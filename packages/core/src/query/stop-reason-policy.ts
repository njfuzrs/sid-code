/**
 * 停止判据单一事实源：provider 的 stop_reason + content 事实 → 本轮该怎么处置。
 *
 * 为什么要收成一个纯函数：此前主循环判据分散在 `isEndTurnLike` / `isTruncatedWithTools` /
 * `stop_reason === "tool_use" || f2FallThrough` / 各 terminal 分支多处 if 里，子循环又抄了一份。
 * 新增一种 stop_reason 时要同时改 3–4 处，漏一处就静默改变行为（`pause_turn` 从 continue
 * 改成收尾时文档没跟上就是这么来的）。现在「这一轮凭什么继续 / 为什么停」只有这里回答，
 * 主循环（query/loop.ts）与子循环（agent/agentic-loop.ts）调用同一份。
 *
 * ⚠️ 白名单 fail-closed（P0-2 死亡螺旋防御的同一方向）：只有明确列出的取值才进
 * `execute_tools` / `finalize`；未知值一律落 `unknown` / `terminal`，绝不当正常收尾、
 * 也绝不当工具轮。不要改成「排除已知错误」——那样每出现一种新的错误 stopReason
 * 都会重新打开 Stop Hook / 闸门链在「模型从未正常产出」时运行的口子。
 *
 * 分类器只回答「怎么处置」，不做副作用：执行工具、压缩、孤儿结算、发事件都在调用方。
 */

import { isEndTurnLikeStopReason } from "../agent/message-invariants.ts";

/** 截断类停止原因（输出撞到 max_tokens 上限）。OpenAI 族叫 `length`。 */
export function isTruncationStopReason(stopReason: string | null | undefined): boolean {
  return stopReason === "max_tokens" || stopReason === "length";
}

export type StopAction =
  /**
   * 执行 content 里的 tool_use。
   * - `tool_use`：正常路径
   * - `f2_end_turn`：声称 end_turn/stop/stop_sequence 却带 tool_use（F2，协议偏差兜底）
   * - `f2_truncated`：max_tokens/length 时已带完整 tool_use（P1-4，先执行工具再说截断）
   */
  | { kind: "execute_tools"; why: "tool_use" | "f2_end_turn" | "f2_truncated" }
  /** 正常收尾，走 AfterAgent / Stop Hook / 闸门链 */
  | { kind: "finalize" }
  /** 可恢复：截断续写，或撞模型窗口后压缩续写（各自有封顶，封顶在调用方） */
  | { kind: "recover"; how: "max_tokens" | "ctx_window" }
  /** 如实收尾（不跑闸门链），收尾前必须结算孤儿 tool_use */
  | { kind: "terminal"; reason: "refusal" | "pause_turn" | "empty_stream" }
  /**
   * 未识别的停止原因（含 null 但有内容、以及 `tool_use` 却一个 tool_use 块都没有）。
   * 同样是如实收尾 + 孤儿结算；与 terminal 分开是因为它要给用户的提示不同。
   */
  | { kind: "unknown"; hasContent: boolean };

export interface StopReasonInput {
  stopReason: string | null | undefined;
  /** content 里是否有 tool_use 块（F1 空参数已在调用方先行拦截） */
  hasToolUse: boolean;
  /** content 是否非空 */
  hasAnyContent: boolean;
}

export function classifyStopReason(input: StopReasonInput): StopAction {
  const { stopReason, hasToolUse, hasAnyContent } = input;

  if (stopReason === "tool_use") {
    // 报 tool_use 却没有任何 tool_use 块：旧实现会 executeTools([]) 后 continue，
    // 白烧一次 API 往返，且 LoopTransition 记成一次正常工具轮。与 F2 同族的协议偏差
    // 反向形态，按未知处理（如实收尾），不空转。
    return hasToolUse
      ? { kind: "execute_tools", why: "tool_use" }
      : { kind: "unknown", hasContent: hasAnyContent };
  }
  if (isEndTurnLikeStopReason(stopReason)) {
    return hasToolUse ? { kind: "execute_tools", why: "f2_end_turn" } : { kind: "finalize" };
  }
  if (isTruncationStopReason(stopReason)) {
    return hasToolUse
      ? { kind: "execute_tools", why: "f2_truncated" }
      : { kind: "recover", how: "max_tokens" };
  }
  if (stopReason === "model_context_window_exceeded") return { kind: "recover", how: "ctx_window" };
  if (stopReason === "refusal") return { kind: "terminal", reason: "refusal" };
  // 本仓未实现 server-tool 续接（anthropic.ts 把 server_tool_use 块丢成空 text），
  // 续接无从谈起，只能如实收尾。见 loop.ts pause_turn 分支的 P2-5 注释。
  if (stopReason === "pause_turn") return { kind: "terminal", reason: "pause_turn" };
  if (!hasAnyContent) return { kind: "terminal", reason: "empty_stream" };
  return { kind: "unknown", hasContent: true };
}
