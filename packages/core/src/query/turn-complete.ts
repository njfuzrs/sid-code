/**
 * TurnComplete —— 「轮次结束」锚点事件（P1-4）
 *
 * ## 为什么必须新增一个事件，而不是复用 `LoopTransition`
 *
 * 「更快」方向的主口径是**端到端耗时**（用户回车 → 最终答复），但此前没有任何埋点
 * 直接记它。现有的是 TTFT（首字节）与生成段耗时，两者相加**也不等于**端到端 ——
 * 中间还有工具往返、JIT 注入、权限确认、重试等待。
 *
 * 派生也做不到：`query/transition.ts` 的 `setTransition()` 只在**继续循环**时发事件
 *（函数职责就是"记录 continue 原因"），而轮次结束是**退出循环**，天然不经过它。
 * 实测 `LoopTransition.type` 只有 4 个取值（`tool_use` 767 / `todo_gate_retry` 1 /
 * `timeout_retry` 2 / `unanswered_retry` 1），**没有 `end_turn`**。
 * 于是"最终答复时刻"这个最重要的锚点反而是唯一没有事件的时刻，只能用
 *「下一个 UserPromptSubmit 之前的最后一个 AfterModel」近似 —— 那个近似在会话中断、
 * 用户中途 ESC、多轮嵌套子代理时全部失真（实测派生出 p95 758.7s，明显被污染）。
 *
 * 也不能把"结束"塞进 `LoopTransition`：它的语义是"继续"，混进一个反义值会让所有现有
 * 消费方的 `type` 分支都需要重新审视（`trace/digest.ts` 已经在按
 * `type === "todo_gate_retry"` 过滤）。所以另开一个事件名。
 *
 * ## 三条口径铁律
 *
 * 1. **差值在发事件时当场算，不留给消费侧配对**。配对式口径已经栽过一次
 *    （watchdog 快照注册用 turnCount、查用 pair index，结构性恒 null）。
 * 2. **每轮重设基准**，绝不跨轮累计（同 TTFT 那个 bug 的形态：基准不重设让
 *    thinking 模型虚高数十秒）。基准由 `LoopState.turnStartedAtMs` 持有。
 * 3. **异常/中断轮次也必须发**。只在成功路径发事件会造成选择偏差 ——
 *    慢轮次往往正是被中断的那些，漏掉它们会让 p95 系统性偏低，
 *    "看起来变快了"其实是把慢样本筛掉了。这是本文件唯一不可妥协的一条。
 *
 * ## 口径诚实：含 HITL 等待时间
 *
 * `elapsed_ms_since_prompt` 里包含权限确认弹窗的等待 —— 那段等的是人，不是 agent。
 * **刻意不剔除**：剔除需要再引两个事件（弹窗开/关）并保证配对，收益不足、失真风险
 * 更高。改为在发生过确认的轮次上打 `had_hitl: true`，让消费侧自己决定是否排除。
 * 这样口径诚实，且不引入任何配对。
 */

/**
 * ## "一轮"的定义：一条用户消息，不是一次 API 调用
 *
 * 本事件的粒度是 **queryLoop 的一次调用**（= 用户回车一次），而 `LoopState.turnCount`
 * 是那次调用内部的 API 迭代数。所以一条用户消息只发**一个** `TurnComplete`，
 * `tool_calls_in_turn` 是整条消息内累计派发的工具数。
 *
 * 这个粒度是端到端口径本身要求的（"用户回车 → 最终答复"），也是为什么端到端样本天然
 * 比 TTFT 少一个数量级 —— 一条用户消息里有多次 fetch，每次都有 TTFT，但只有一个
 * "答复完成"。消费侧展示时必须标 n，不然会被误以为两者置信度相同。
 */

import type { LoopState, QueryDeps } from "./types.ts";
import type { SessionState } from "../session/state.ts";

/**
 * HITL（需用户确认的权限弹窗）**累计**次数在 SessionState 上的键。
 *
 * 为什么是累计计数而不是布尔标志：`hadHitlThisTurn` 必须由**前后差值**判定。
 * 布尔标志一旦被某轮置真，后续每轮都会被误标成"有 HITL"（同 `LoopState` 上那些
 * 一次性标志位踩过的坑）。计数器 + 轮首快照 + 轮末比较，才能如实回答"本轮有没有"。
 *
 * 挂 SessionState 而非 LoopState：LoopState 每条用户消息重建，而权限确认发生在
 * tool-executor 里、跨用户消息累计，放 LoopState 拿不到。
 */
export const HITL_PROMPT_COUNT_KEY = "hitlPromptCount";

/** 递增 HITL 计数（tool-executor 在确实弹过窗的路径上调用）。失败静默。 */
export function recordHitlPrompt(sessionState: SessionState | undefined): void {
  if (!sessionState) return;
  try {
    const prev = sessionState.get(HITL_PROMPT_COUNT_KEY);
    sessionState.set(HITL_PROMPT_COUNT_KEY, (typeof prev === "number" ? prev : 0) + 1);
  } catch {
    /* 观测计数失败绝不影响权限流程 */
  }
}

/** 读当前累计 HITL 次数（读不到按 0）。 */
export function readHitlPromptCount(sessionState: SessionState | undefined): number {
  if (!sessionState) return 0;
  try {
    const v = sessionState.get(HITL_PROMPT_COUNT_KEY);
    return typeof v === "number" ? v : 0;
  } catch {
    return 0;
  }
}

/**
 * 设定端到端基准并快照 HITL 计数。
 *
 * **在 queryLoop 入口调用一次**（不是 while 循环里每次迭代）—— 见文件头「一轮的定义」：
 * 基准点是"用户回车那一刻"，而 while 循环的每次迭代只是这条消息内的一次 API 往返。
 *
 * 基准天然随每条用户消息重设：`LoopState` 由 `createInitialLoopState()` 在每次
 * queryLoop 调用时重建。这正好满足"第二轮不含第一轮耗时"的要求 —— 但**必须有测试
 * 锁住它**：TTFT 当年就是因为基准设在重试循环之外而虚高数十秒，形态完全一样，
 * 靠"结构上应该没问题"是拦不住回归的。
 */
export function beginTurn(state: LoopState, sessionState: SessionState | undefined): void {
  state.turnStartedAtMs = Date.now();
  state.hadHitlThisTurn = false;
  state.hitlCountAtTurnStart = readHitlPromptCount(sessionState);
  state.turnCompleteEmitted = false;
  state.toolCallsDispatched = 0;
}

/** `TurnComplete` 事件的 data 载荷（与 `trace/digest.ts` 的消费侧字段名严格一致）。 */
export interface TurnCompletePayload {
  /** 本条用户消息内的轮次（与其它埋点的 `turn` 同口径） */
  turn: number;
  /** 会话累计轮次（跨用户消息可比较，避免 turn 回绕） */
  absoluteTurn: number;
  /** 第几条用户消息 */
  promptSeq: number;
  /**
   * 本轮的结束原因。**不是** provider 的 stopReason 原样透传：这里要回答的是
   * "这一轮为什么不再继续了"，取值见 {@link TurnStopReason}。
   */
  stop_reason: TurnStopReason;
  /** 本轮模型请求执行的工具调用数（无工具轮为 0） */
  tool_calls_in_turn: number;
  /**
   * 端到端耗时（ms）= 本轮起点到本事件的墙钟差。**含 HITL 等待**（见文件头）。
   * 基准缺失时不落该字段（而不是落 0）—— 0 会被读成"0 毫秒"。
   */
  elapsed_ms_since_prompt?: number;
  /** 本轮是否发生过需用户确认的权限弹窗。消费侧据此决定是否排除含人等待的样本 */
  had_hitl: boolean;
}

/**
 * 轮次结束原因。
 *
 * 刻意用一组**受控值**而非透传 provider 的 stopReason：后者各家不一
 *（`end_turn` / `stop` / `stop_sequence` 都表示"正常说完了"），透传等于把归一化
 * 责任推给每一个消费方，必然漂移出多套口径。
 */
export type TurnStopReason =
  /** 模型正常收尾（end_turn / stop / stop_sequence 归一到此） */
  | "end_turn"
  /** 用户中断（ESC）或上游 abort。**必须也发事件**，否则 p95 被系统性拉低 */
  | "abort"
  /** 达到 maxTurns 硬停 */
  | "max_turns"
  /** 抛错终止（含超时重试耗尽） */
  | "error"
  /** 其它提前收尾（hook 阻断、空响应、未识别 stopReason 等） */
  | "other";

/**
 * 把 provider 的 stopReason 归一到 {@link TurnStopReason}。
 *
 * 只认明确的正常收尾三值，其余一律 `other` —— 宁可归到 other，也不要把未识别的
 * 新协议值静默当成 end_turn（那会让"提前收尾"混进正常样本，掩盖真实故障）。
 */
export function normalizeTurnStopReason(stopReason: string | null | undefined): TurnStopReason {
  if (stopReason === "end_turn" || stopReason === "stop" || stopReason === "stop_sequence") {
    return "end_turn";
  }
  return "other";
}

/**
 * 发射一次 `TurnComplete`。
 *
 * **幂等**：同一个 `state` 只发一次（`turnCompleteEmitted` 置位）。queryLoop 有 20+ 个
 * `yield done; return` 出口，加上 finally 兜底，不做幂等必然重复计数 —— 而端到端样本
 * 本就比 TTFT 少一个数量级，重复一次就能明显偏移分位数。
 *
 * 全程静默失败：埋点绝不阻塞主循环。
 */
export function emitTurnComplete(
  state: LoopState,
  sessionState: SessionState | undefined,
  deps: Pick<QueryDeps, "traceAppendEvent">,
  args: {
    sessionId: string;
    absoluteTurn: number;
    promptSeq: number;
    stopReason: TurnStopReason;
    toolCallsInTurn: number;
  },
): void {
  if (state.turnCompleteEmitted) return;
  state.turnCompleteEmitted = true;
  try {
    if (!deps.traceAppendEvent) return;
    const startedAt = state.turnStartedAtMs;
    const hitlNow = readHitlPromptCount(sessionState);
    const hadHitl =
      state.hadHitlThisTurn === true || hitlNow > (state.hitlCountAtTurnStart ?? hitlNow);
    const payload: TurnCompletePayload = {
      turn: state.turnCount,
      absoluteTurn: args.absoluteTurn,
      promptSeq: args.promptSeq,
      stop_reason: args.stopReason,
      tool_calls_in_turn: args.toolCallsInTurn,
      // 基准缺失（理论上不该发生）时不落字段：落 0 会污染分位数，
      // 而缺失会被 digest 侧原样跳过（它只收 > 0 的值）。
      ...(typeof startedAt === "number" ? { elapsed_ms_since_prompt: Date.now() - startedAt } : {}),
      had_hitl: hadHitl,
    };
    deps.traceAppendEvent({
      event: "TurnComplete",
      session_id: args.sessionId || "unknown",
      timestamp: new Date().toISOString(),
      data: payload as unknown as Record<string, unknown>,
    });
  } catch {
    /* 埋点失败不阻断主循环 */
  }
}
