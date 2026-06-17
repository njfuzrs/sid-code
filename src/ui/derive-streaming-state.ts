/**
 * StreamingState 派生纯函数
 *
 * 从 TUIState 的若干布尔/对象标志派生 UI 流式状态枚举。抽成纯函数便于单测，
 * 避免在 App.tsx 的 useMemo 里内联难测。
 *
 * 优先级（从高到低，顺序很重要）：
 * 1. 有待确认请求（权限/shell/计划）→ WaitingForConfirmation（最高优先）
 * 2. 正在流式 / 工具执行中           → Responding（首字已到达）
 * 3. 已提交但还没首字 / 没开始执行工具 → Connecting（消灭首字延迟盲区）
 * 4. 其余                            → Idle
 *
 * 关键：Responding 判断必须在 Connecting 之前——一旦首字到达 isStreaming=true，
 * 即使 isLoading 仍为 true，也应优先判为 Responding。
 */

import { StreamingState } from "./types.ts";

/** 派生 StreamingState 所需的最小状态切片 */
export interface StreamingStateInput {
  isLoading: boolean;
  isStreaming: boolean;
  isToolExecuting: boolean;
  permissionRequest: unknown;
  shellConfirmRequest: unknown;
  planApprovalRequest: unknown;
}

export function deriveStreamingState(state: StreamingStateInput): StreamingState {
  if (state.permissionRequest || state.shellConfirmRequest || state.planApprovalRequest) {
    return StreamingState.WaitingForConfirmation;
  }
  if (state.isStreaming || state.isToolExecuting) {
    return StreamingState.Responding;
  }
  // 已提交但还没收到首字 / 没开始执行工具 → Connecting（消灭首字延迟盲区）。
  if (state.isLoading) {
    return StreamingState.Connecting;
  }
  return StreamingState.Idle;
}
