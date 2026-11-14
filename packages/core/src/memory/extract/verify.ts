/**
 * P1-2（MD5）：让提取代理周期性回头核实一条「很久没人读」的记忆。
 *
 * ## 缺陷背景
 *
 * 记忆只写不校。一条记忆的前提可能早就变了（「这个仓库用 A 方案」→ 后来改成 B），
 * 但提取代理的提示词明确写着「不要为确认旧记忆是否仍然准确去读代码」——它没有核实
 * 通道，于是过期记忆会一直躺在索引里，每轮随 system prompt 注入，误导后续会话。
 *
 * ## 做法：每 N 次提取，放开一轮去核实**一条**
 *
 * 不增加每轮的预算，只在低频的轮次上换一件事做：
 *
 * - **挑谁**：超过 `staleDays` 天没被读过的那条（`lastRead` 取 `.read-stats.json`；
 *   从没被读过的按写入时间 mtime 算）。从未被读过的优先 —— 它连一次都没被验证过。
 * - **怎么核实**：允许 `grep` / `read` 源码、跑 `git log`，只针对这一条。
 * - **写完怎么回写**：前提已不成立 → 用 `纠正：<旧结论为什么不成立>` 覆盖同一条；
 *   仍成立 → **什么都不做**（不要为了「证明核实过」而重写文件，那会把 mtime 推新，
 *   让 `buildFreshnessWarning` 把它当成「最近改过」）。
 *
 * ## 为什么排掉 `agent_action`
 *
 * `source: agent_action` 的条目**不进 MEMORY.md 索引**（`isIndexVisibleMemory`）——
 * 模型在清单之外根本看不见它，核实了也没人受益，只会白烧一轮。
 *
 * ## 代价（主动接受，不是副作用）
 *
 * `extractor.ts` 现在是 `maxTurns: 5` / `timeoutMs: 60_000` 的紧预算。核实轮次把
 * `maxTurns` 提到 6，多出来的那一轮就是核实成本：**这一轮的提取产出会下降**。
 * 换来的是「记忆不再是只写不校」。这个取舍写在 Agent Note 里。
 *
 * ## 与 P1-1 的关系
 *
 * 核实结果如果确实推翻了旧结论，回写时正好撞上 P1-1 的闸门（`conclusion-guard.ts`）：
 * 提示词要求写 `纠正：`，而那正是 P1-1 认的放行标记。两处判据刻意对齐 —— 否则核实
 * 出来的正确答案会被自己的另一道闸门拒掉。
 */

import { relative, sep } from "node:path";
import type { MemoryHeader } from "../types.ts";
import type { MemoryReadStat } from "../read-stats.ts";

/** 超过这么多天没被读过，才值得核实（缺省 7 天） */
export const DEFAULT_STALE_DAYS = 7;
/** 每这么多次提取触发一次核实（缺省 5 次；0 = 关闭） */
export const DEFAULT_VERIFY_EVERY = 5;

export interface VerifyTarget {
  /** 模型更新时该传的 key（`frontmatter name`，不是文件名） */
  key: string;
  filename: string;
  /** 距最近一次被读取的天数（从未读过时按写入时间算） */
  idleDays: number;
  /** 从没被读过 —— 它连一次都没被验证过，比「读过但很久了」更可疑 */
  neverRead: boolean;
}

/**
 * 解析「每 N 次提取核实一次」的间隔：env `SID_CODE_MEMORY_VERIFY_EVERY` > 缺省 5。
 * `0` 是合法值（显式关闭），负数和非法值回落缺省。
 *
 * 为什么只走 env 不进 settings：这条是**行为改动**（每 5 轮把一次提取的产出换成一次核实），
 * 加 settings 字段就要同步 config schema + 参考页生成；而在它被真实数据验证之前，
 * 一个环境变量足够（`SID_CODE_MEMORY_VERIFY_EVERY=0` 就是回滚开关）。
 * 与 `resolveMemoryExtractInterval` 同一形状：拼错的值不该把功能**静默关掉**，
 * 但显式写 0 的用户意图明确，要认。
 */
export function resolveVerifyEvery(): number {
  const parse = (v: unknown): number | undefined => {
    const n = typeof v === "string" ? Number(v.trim()) : v;
    return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : undefined;
  };
  const env = process.env.SID_CODE_MEMORY_VERIFY_EVERY;
  if (env !== undefined && env !== "") {
    const n = parse(env);
    if (n !== undefined) return n;
  }
  return DEFAULT_VERIFY_EVERY;
}

/**
 * 挑一条值得核实的记忆。没有候选返回 `null`（此时本轮就正常提取，不加核实任务）。
 *
 * 排序：**从未读过**的优先，其次按闲置天数降序。同分时取清单里靠前的（它更可能进索引）。
 */
export function pickVerifyTarget(
  headers: readonly MemoryHeader[],
  readStats: Record<string, MemoryReadStat>,
  opts: {
    memoryDir: string;
    now?: number;
    staleDays?: number;
  },
): VerifyTarget | null {
  const now = opts.now ?? Date.now();
  const staleMs = (opts.staleDays ?? DEFAULT_STALE_DAYS) * 86_400_000;
  const candidates: VerifyTarget[] = [];

  for (const h of headers) {
    // 不进索引的条目模型根本看不见，核实它没有人受益
    if (h.source === "agent_action") continue;
    const rel = relative(opts.memoryDir, h.filePath).split(sep).join("/");
    const stat = readStats[rel];
    const neverRead = stat === undefined;
    // 从未读过时用写入时间：一条刚写 3 分钟的记忆不该被当成「很久没人看」
    const idleBase = stat ? stat.lastRead : h.mtimeMs;
    const idleMs = now - idleBase;
    if (idleMs < staleMs) continue;
    candidates.push({
      key: h.name ?? h.filename.replace(/\.md$/, ""),
      filename: h.filename,
      idleDays: Math.floor(idleMs / 86_400_000),
      neverRead,
    });
  }

  if (candidates.length === 0) return null;
  // 稳定排序：先按「从未读过」，再按闲置天数；Array.prototype.sort 在现代引擎是稳定的，
  // 所以同分时保留清单原顺序（= 索引保留优先级顺序）
  candidates.sort((a, b) => {
    if (a.neverRead !== b.neverRead) return a.neverRead ? -1 : 1;
    return b.idleDays - a.idleDays;
  });
  return candidates[0] ?? null;
}

/**
 * 这一轮要不要做核实。`every <= 0` 表示关闭。
 *
 * `seq` 是「第几个触发抽取的 end_turn」，从 1 开始 —— 所以 `seq % every === 0`
 * 在第 every / 2*every / … 轮触发，第一次核实不会发生在第 1 轮（那时记忆还没积累）。
 */
export function shouldVerifyThisRound(seq: number, every: number): boolean {
  if (every <= 0) return false;
  return seq > 0 && seq % every === 0;
}
