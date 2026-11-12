/**
 * 项目记忆的注入模式：全量索引 vs 按需召回（F5 / PR-4）
 *
 * ─── 为什么需要第二种模式 ───
 *
 * 默认路径是「MEMORY.md 索引全量进 system prompt，模型按需 Read」，与 CC 默认一致。
 * 但索引有 200 条 / 25KB 的上限（`types.ts`），记忆库一旦超过上限，全量注入本身就**已经不完整**
 * （尾部那句「部分记忆未列出」），每轮还要背着约 22k 字符（2026-11-12 本机实测：项目记忆
 * 203 个文件，索引 24,870 字节、已截断）。继续全量注入是「既浪费 token 又漏信息」。
 *
 * 召回（`recall.ts`）按当前查询从**全部**记忆里挑 ≤5 条，正好覆盖这种场景。
 *
 * ─── 判据只用结构性事实 ───
 *
 * 「索引被截断」以 `writeIndex` 追加的截断警告为准（`readIndexCapacity`，与写侧同一判据），
 * 不按模型、不按窗口大小。没被截断就维持全量注入——小记忆库全量更准、更快，
 * 召回每条用户消息还要多一次辅助调用，没有理由替换。
 *
 * ─── 会话内锁定，失败只回退一次 ───
 *
 * 索引在 system prompt 的静态区，模式切换 = 静态前缀变一次 = prompt cache 全部失效。
 * 所以模式**按记忆目录在进程内锁定**：首次判定后，CLAUDE.md 热重载、/language 等任何
 * system prompt 重建都复用同一结论，不会因为会话中途抽取出新记忆跨过阈值而来回翻转。
 *
 * 召回失败（辅助调用超时 / 报错）时回退到全量（截断版），且粒度是「本会话起改回全量」，
 * 不是逐条消息切换——后者每次失败都击穿一次缓存。回退只会单向发生（recall → full）。
 *
 * ─── 开关 ───
 *
 * `SID_CODE_MEMORY_RECALL=1` 强制召回（不论是否截断）；`=0` 强制全量（关闭自动切换，
 * 也是本特性的回滚出口）；其它值 / 未设置 = 按截断自动判定。
 */

import { readIndexCapacity } from "./index-capacity.ts";
import { getLogger } from "../debug/logger.ts";

export type MemoryInjectMode = "full" | "recall";

/** 模式的成因（进日志与 /context，排查「为什么这次没注入索引」时第一眼要看到的东西） */
export type MemoryInjectModeReason =
  | "index_truncated"
  | "index_fits"
  | "env_force_recall"
  | "env_force_full"
  | "recall_failed_fallback";

export interface MemoryInjectDecision {
  mode: MemoryInjectMode;
  reason: MemoryInjectModeReason;
}

/**
 * 进程内锁定表：记忆目录 → 判定。
 *
 * 按目录分键而不是一个全局变量：同一进程里切 worktree / 测试用不同 tmp 目录时，
 * 各自的判定互不污染。
 */
const decisions = new Map<string, MemoryInjectDecision>();

/** 读开关：返回强制模式；未设或非法值返回 null（= 自动判定） */
function envOverride(): MemoryInjectDecision | null {
  const v = process.env.SID_CODE_MEMORY_RECALL;
  if (v === "1") return { mode: "recall", reason: "env_force_recall" };
  if (v === "0") return { mode: "full", reason: "env_force_full" };
  return null;
}

/** 不锁定、只看磁盘的判定（纯函数，测试与首次判定共用） */
export function decideMemoryInjectMode(memoryDir: string): MemoryInjectDecision {
  const forced = envOverride();
  if (forced) return forced;
  return readIndexCapacity(memoryDir).truncated
    ? { mode: "recall", reason: "index_truncated" }
    : { mode: "full", reason: "index_fits" };
}

/**
 * 取本会话的注入模式（首次调用时判定并锁定）。
 *
 * system prompt 构建（索引要不要全量注入）与召回接线（要不要发辅助调用）**必须**都经这里，
 * 两边才不会出现「索引照样全量注入，召回又额外加一段」的净增 token 形态——
 * 那正是修复前打开 `SID_CODE_MEMORY_RECALL=1` 的真实行为。
 */
export function resolveMemoryInjectMode(memoryDir: string): MemoryInjectDecision {
  const hit = decisions.get(memoryDir);
  if (hit) return hit;
  const d = decideMemoryInjectMode(memoryDir);
  decisions.set(memoryDir, d);
  getLogger().info("MEMORY", `项目记忆注入模式: ${d.mode}（${d.reason}）`);
  return d;
}

/**
 * 召回失败 → 本会话起改回全量注入。
 *
 * @returns 是否真的发生了切换（原本就是 full 时返回 false，调用方据此决定要不要重建 system prompt，
 *          避免无意义地击穿缓存）
 */
export function fallbackToFullInjection(memoryDir: string): boolean {
  const cur = decisions.get(memoryDir);
  if (cur && cur.mode === "full") return false;
  decisions.set(memoryDir, { mode: "full", reason: "recall_failed_fallback" });
  getLogger().warn("MEMORY", "记忆召回失败，本会话起改回全量索引注入");
  return true;
}

/** 测试专用：清空锁定表 */
export function resetMemoryInjectModeForTest(): void {
  decisions.clear();
}
