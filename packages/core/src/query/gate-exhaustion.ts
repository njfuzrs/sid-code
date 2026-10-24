/**
 * GateExhausted —— end_turn 闸门链「某道门续命预算耗尽」的结构化事件（2026-10-24）
 *
 * ## 闸门链耗尽语义（本文件是唯一事实源）
 *
 * 模型 end_turn 后依次经过：Stop Hook → unanswered → promise_nudge → todo → hypothesis →
 * token_budget → goal。每道门各自封顶，但「耗尽」的含义按门的性质分三类，处理方式不同：
 *
 * | 类 | 成员 | 耗尽意味着 | 耗尽后 |
 * | --- | --- | --- | --- |
 * | 退化 | unanswered、empty_param、context_window | 模型已产不出有效输出 / 窗口已无可腾挪空间 | **整条链收尾**（P1-3 / P2-7）：每道门都靠「注入提示再续一轮」起作用，对已退化的模型续命只会把同一个退化再跑一遍 |
 * | 质量闸门 | stop_hook、todo、hypothesis、promise_nudge | 「这一项检查」劝不动了 | **只是本门不再续命**，后续门照常判定 |
 * | 用户授权续跑 | token_budget（`+500k`）、goal（`/goal`） | 有自己的终止判据（预算 / 递减收益 / 评估者 / 轮数） | 按自己的判据，不因前面某道质量门耗尽而失效 |
 *
 * 为什么质量门耗尽**不**短路后续门：
 * - 质量门耗尽只证明「这项检查劝不动」，不证明「用户要停」；用户开了 `/goal` / `+500k`
 *   恰恰是在授权继续。让 todo 耗尽连带掐掉 goal，等于用一道门的失败否决另一道门的授权。
 * - 每道门都独立封顶，续命总次数是各门上限之和，有界，不构成无限循环。
 * - 反过来，若要求「任一门耗尽即收尾」，Stop Hook 耗尽（lint 仍红）会让 hypothesis 门
 *   永远轮不到——同一条消息里未裁决的假设被直接当结论交付，那正是 hypothesis 门要拦的。
 *
 * ## 为什么需要这个事件
 *
 * 耗尽此前只有一行 `log.warn` 中文日志，结构化轨迹里看不到。于是「质量门耗尽后被用户授权门
 * 接着续跑」（设计如此）与「耗尽后被不该续的门续上」（缺陷）在数据上无法区分，只能读代码判。
 * 落成事件后，按 `promptSeq` 把 `GateExhausted` 与其后的 `LoopTransition` 对齐即可复算；
 * `TurnComplete.gates_exhausted` 给出本条消息内耗尽过哪些门。
 *
 * 写入失败一律吞掉——埋点绝不能反过来阻断主循环。
 */
import type { LoopState, QueryDeps } from "./types.ts";

/** 可能耗尽的闸门（闭集，与上表一致） */
export type ExhaustibleGate =
  | "stop_hook"
  | "unanswered"
  | "promise_nudge"
  | "todo"
  | "hypothesis"
  | "empty_param"
  | "context_window";

/** 耗尽后的链路行为：`chain_ends` = 整条链收尾；`gate_only` = 只是本门不再续命 */
export type GateExhaustionEffect = "chain_ends" | "gate_only";

/** 每道门耗尽后的链路行为（上表的可执行版本，测试据此锁语义） */
export const GATE_EXHAUSTION_EFFECT: Record<ExhaustibleGate, GateExhaustionEffect> = {
  unanswered: "chain_ends",
  empty_param: "chain_ends",
  context_window: "chain_ends",
  stop_hook: "gate_only",
  promise_nudge: "gate_only",
  todo: "gate_only",
  hypothesis: "gate_only",
};

export function emitGateExhausted(
  state: LoopState,
  deps: Pick<QueryDeps, "traceAppendEvent">,
  args: {
    sessionId: string;
    absoluteTurn: number;
    promptSeq: number;
    gate: ExhaustibleGate;
    /** 本门已续命次数 */
    retries: number;
    /** 本门封顶次数 */
    cap: number;
  },
): void {
  // 每条用户消息每道门只记一次：「这道门在本条消息里耗尽过」是要回答的事实，
  // 同一状态下后续 end_turn 再判一次耗尽（如 promise_nudge 的 capped）不是新事实。
  const list = (state.gatesExhausted ??= []);
  if (list.includes(args.gate)) return;
  list.push(args.gate);
  if (!deps.traceAppendEvent) return;
  try {
    deps.traceAppendEvent({
      event: "GateExhausted",
      session_id: args.sessionId || "unknown",
      timestamp: new Date().toISOString(),
      data: {
        gate: args.gate,
        effect: GATE_EXHAUSTION_EFFECT[args.gate],
        retries: args.retries,
        cap: args.cap,
        turn: state.turnCount,
        absoluteTurn: args.absoluteTurn,
        promptSeq: args.promptSeq,
      },
    });
  } catch {
    /* 埋点失败不阻断主循环 */
  }
}
