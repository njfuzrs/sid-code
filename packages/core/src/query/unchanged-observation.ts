/**
 * 同指纹同返回值空转检测（P2-20）——运行时口径，与离线 digest 共用同一把尺子
 *
 * ## 缺口是什么
 *
 * `trace/digest.ts` 的 `maxUnchangedObservationRun >= 3` 会把会话判为
 * `observationEntropyPathological`（medium severity Anomaly），但整条计算链
 * （`computeProcessPathology` → `describePathology`）**只在 `/insights` 离线读 trace 时**
 * 被调用，`query/loop.ts` 零引用。于是一次会话里某工具连续 22 次同参数同返回值空转，
 * 运行时**没有任何动作**——不警告、不埋点、不可观测，只有事后跑 `/insights` 才看得到。
 *
 * 两道已有的运行时阀都覆盖不到它：
 *   - `repeated-readonly-guard`：只盯 bash 只读白名单命令 + `READ_FAMILY_TOOLS`
 *     （read/read_many/ls/glob/grep/lsp）。`web_fetch` / `web_search` / `tool_search` /
 *     含管道的 bash 全部落在外面。
 *   - `low-yield-spin`：只盯 bash **且**输出是单标量（`grep -c` / `wc -l`）。
 *     返回值是一大段完全相同的文本时不命中。
 *
 * ## 为什么只报不拦
 *
 * 这是刻意的，有否决记录背书（`.agents/notes/rejected/feature/2026-07-14-工具循环检测默认开启.md`）：
 * 42 个真实会话回放里 shape 检测误判率 ≈100%、exact 检测召回 ≈0，故工具循环检测默认全关。
 * 那份否决同时写明了**正确的切法**：「只读命令做『输入 + 输出双重复』检测（能精准抓到
 * 10 次 git status 输出一字不差这类真死锁，同时放过输出各异的巡检）」，并指出当时的阻塞是
 * 「检测器只 record 输入、看不到 observation，接入有成本」。
 *
 * 本模块就是那个双重复判据，而且**不掐断任何东西**：只 warn + 落一条 trace 事件。
 * 理由是 digest 侧的阈值 3 从未在运行时验证过误报率——先把数据采上来（这条事件的
 * 触发率、命中的工具分布），有了分母再谈要不要升级成干预。没有数据就直接拦，是在猜。
 *
 * ## 与 digest 同源
 *
 * `UNCHANGED_OBSERVATION_THRESHOLD` 定义在本模块、由 `digest.ts` 导入，**只有一个数**。
 * 两侧各写一个 3 的话，任何一侧调阈值都会让「运行时报了但周报不算病态」
 * （或反过来）——这正是本仓 P1-6/7「压缩决策和压缩执行用两套尺子」同型的病。
 *
 * 判据与 digest 的 `maxUnchangedObservationStreak` 逐条对齐：
 *   - 指纹 = 工具名 ⊕ 稳定序列化入参（键排序，避免键序抖动造成伪差异）；
 *   - 连续性在**同指纹自己的子序列**里算，不是全局连续（那是 `repeated_tool_shape_run` 的口径）；
 *   - 观察值截断到 2000 字符后比较（与 digest 同一上界）。
 *
 * 纯函数 + 纯数据，副作用（warn / 埋点）留在 loop.ts，便于单测。
 */

/**
 * 判「同指纹同返回值空转」所需的连续次数。**全仓只此一份**，`trace/digest.ts` 从这里导入。
 *
 * 方向刻意如此：digest.ts 是 3481 行 + `node:fs` 的离线分析模块，让热路径（loop.ts）
 * 顺着本模块去 import 它，等于把整个离线 digest 拖进主循环；反过来零成本 ——
 * 离线模块 import 一个只含常量与纯函数、零依赖的小模块。
 */
export const UNCHANGED_OBSERVATION_THRESHOLD = 3;

/** 观察值参与比较的最大长度（与 digest.ts 的 `truncate(..., 2000)` 同上界）。 */
const OBSERVATION_COMPARE_LIMIT = 2000;

/** 跨轮累积状态（挂 LoopState）。 */
export interface UnchangedObservationState {
  /** 每个指纹上一次的观察值 + 当前连续相同次数。 */
  runs: Map<string, { lastObservation: string; run: number }>;
  /** 已就该指纹报过告警的集合（同一条空转只报一次，不刷屏）。 */
  reported: Set<string>;
}

export function createUnchangedObservationState(): UnchangedObservationState {
  return { runs: new Map(), reported: new Set() };
}

/**
 * 稳定序列化入参：键排序后 JSON。序列化失败兜底空串（与
 * `repeated-readonly-guard.makeToolProbeCommand` 同口径）。
 */
function stableInput(input: unknown): string {
  try {
    if (input && typeof input === "object" && !Array.isArray(input)) {
      const obj = input as Record<string, unknown>;
      const ordered: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) ordered[k] = obj[k];
      return JSON.stringify(ordered);
    }
    return JSON.stringify(input ?? null);
  } catch {
    return "";
  }
}

/** 指纹：工具名 ⊕ 稳定入参。入参不同即视为「另一次探查」，各自独立计数。 */
export function observationFingerprint(toolName: string, input: unknown): string {
  // 分隔符用转义写法 `\x1f`（US）：源码里出现裸控制字节会让 grep 把整个文件判为二进制
  // 而静默跳过（本仓 digest.ts / low-yield-spin.ts 同一处踩过，pre-commit 有门禁拦）。
  return `${toolName}\x1f${stableInput(input)}`;
}

/** 单次工具调用的观测结果。 */
export interface ToolObservation {
  toolName: string;
  input: unknown;
  /** 工具返回的文本（调用方负责取，本模块只比较）。 */
  output: string;
}

/** 判定结果。`shouldReport` 为 true 时调用方 warn + 埋点，且**不做任何干预**。 */
export interface UnchangedObservationDecision {
  /** 该指纹当前的连续相同返回值次数。 */
  run: number;
  /** 是否达阈值且本指纹尚未报过（同一条空转只报一次）。 */
  shouldReport: boolean;
  /** 命中的工具名（便于调用方直接写日志，无需再解指纹）。 */
  tool: string;
}

/**
 * 记录一次工具调用的（入参, 返回值），更新该指纹的连续计数。
 *
 * 返回值不同即清零（「世界在变」= 有新信息，不是空转）；相同则累加。
 * 清零同时把该指纹从 `reported` 移除——它后续若再次卡住，应当再报一次
 * （那是**新的**一段空转，不是同一段的刷屏）。
 */
export function observeToolResult(
  state: UnchangedObservationState,
  obs: ToolObservation,
): UnchangedObservationDecision {
  const fp = observationFingerprint(obs.toolName, obs.input);
  const normalized = obs.output.slice(0, OBSERVATION_COMPARE_LIMIT);
  const prev = state.runs.get(fp);

  if (!prev || prev.lastObservation !== normalized) {
    state.runs.set(fp, { lastObservation: normalized, run: 1 });
    state.reported.delete(fp);
    return { run: 1, shouldReport: false, tool: obs.toolName };
  }

  const run = prev.run + 1;
  state.runs.set(fp, { lastObservation: normalized, run });
  const shouldReport = run >= UNCHANGED_OBSERVATION_THRESHOLD && !state.reported.has(fp);
  if (shouldReport) state.reported.add(fp);
  return { run, shouldReport, tool: obs.toolName };
}
