/**
 * setTransition — 记录循环 continue 原因并发射 trace 事件
 *
 * 解决 transition 字段"只写不读"问题：通过 traceAppendEvent 让测试和可观测性系统
 * 都能断言/追踪恢复路径的触发。
 */
import type { LoopState, ContinueReason, QueryDeps } from "./types.ts";

export function setTransition(
  state: LoopState,
  reason: ContinueReason,
  deps: Pick<QueryDeps, "traceAppendEvent">,
  sessionId?: string,
): void {
  state.transition = reason;
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
