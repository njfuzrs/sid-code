/**
 * setTransition — 记录循环 continue 原因并发射 trace 事件
 *
 * 解决 transition 字段"只写不读"问题：通过 traceAppendEvent 让测试和可观测性系统
 * 都能断言/追踪恢复路径的触发。
 *
 * ## 本条用户消息内的 continue 计数（2026-10-24）
 *
 * 这里是 continue 理由的**唯一写入点**，所以计数也只在这里维护：
 * `continueCounts`（各理由次数）与 `maxContinueStreak`（同一理由最长连续游程）
 * 随 `TurnComplete` 落盘。它们回答的是「有没有哪条 continue 路径停不下来」——
 * 这类缺陷此前只能靠读代码一条条排查（`model_context_window_exceeded` 分支无封顶、
 * 闸门耗尽后被下一道门续命，都是这样找到的），轨迹里没有直接信号。
 *
 * ⚠️ 游程**不统计 `tool_use`**：连续几十轮工具调用是正常工作形态，算进去会让
 * `maxContinueStreak` 恒等于工具轮数，把真正的异常游程淹没。`tool_use` 仍计入
 * `continueCounts`，并且会打断其它理由的游程（中间夹了真实工作就不算"原地续命"）。
 */
import type { LoopState, ContinueReason, QueryDeps } from "./types.ts";

export function setTransition(
  state: LoopState,
  reason: ContinueReason,
  deps: Pick<QueryDeps, "traceAppendEvent">,
  sessionId?: string,
): void {
  state.transition = reason;
  recordContinue(state, reason.type);
  try {
    deps.traceAppendEvent?.({
      event: "LoopTransition",
      session_id: sessionId || "unknown",
      timestamp: new Date().toISOString(),
      data: { type: reason.type, turn: state.turnCount },
    });
  } catch {
    /* trace 写入失败不阻断主循环 */
  }
}

/** 维护 `continueCounts` / `continueStreak` / `maxContinueStreak`（见文件头）。 */
function recordContinue(state: LoopState, type: ContinueReason["type"]): void {
  const counts = (state.continueCounts ??= {});
  counts[type] = (counts[type] ?? 0) + 1;

  if (type === "tool_use") {
    state.continueStreak = undefined;
    return;
  }
  const streak =
    state.continueStreak?.type === type
      ? { type, length: state.continueStreak.length + 1 }
      : { type, length: 1 };
  state.continueStreak = streak;
  if (!state.maxContinueStreak || streak.length > state.maxContinueStreak.length) {
    state.maxContinueStreak = { ...streak };
  }
}

/**
 * 各 continue 理由在**一条用户消息内连续出现**的健康上限（digest 判「这条路径没封住」用）。
 *
 * 只收录封顶是固定常量的理由；`timeout_retry`（可配置）、`max_tokens_*`（递减收益检测）、
 * `loop_recovery`（检测器内部计数 + 软重置）、`goal_*` / `token_budget_continuation`
 * （用户授权，按预算 / 评估者终止）没有固定上限，不进表——硬写一个数只会制造假告警。
 *
 * 值必须与各自常量逐字同源，`tests/query/continue-path-caps.test.ts` 锁住。
 */
export const CONTINUE_STREAK_CAPS: Partial<Record<ContinueReason["type"], number>> = {
  stop_hook_retry: 3, // stop-hooks.ts MAX_STOP_HOOK_RETRIES
  todo_gate_retry: 3, // todo-reminder.ts MAX_TODO_GATE_RETRIES
  unanswered_retry: 2, // todo-reminder.ts MAX_UNANSWERED_RETRIES
  promise_nudge: 1, // promise-nudge.ts MAX_PROMISE_NUDGES
  // 交付门禁 2 次 + 被推翻假设复用检查 1 次，两者共用这个 transition type
  hypothesis_gate_retry: 3,
  empty_param_retry: 3, // empty-param.ts MAX_EMPTY_PARAM_RETRIES
  context_window_recovery: 2, // loop.ts MAX_CTX_WINDOW_RECOVERIES
  reactive_compact: 1, // LoopState.hasAttemptedReactiveCompact one-shot
};
