/**
 * 流式 ↔ 滚动协调状态机 — ST8
 *
 * 此前流式跟随底部的逻辑隐含在 VirtualizedList 的 isStickingToBottom 里：流式时
 * scrollTop 锚定底部，用户上滚即断开粘底。但「是否正在跟随流式输出」这一语义
 * 没有被显式建模，也无法对外暴露（如显示「跟随已暂停」提示）、无法单测。
 *
 * 本模块把协调抽成纯状态机：
 *
 *   状态：following（跟随底部）/ paused（用户滚离底部，暂停跟随）
 *   事件：
 *     - stream_token：流式新增内容。following → 保持；paused → 保持。
 *     - user_scroll_up：用户上滚。→ paused。
 *     - reach_bottom：滚动/跟随回到底部。→ following。
 *     - stream_end：流式结束。→ following（下一轮重新跟随）。
 *
 * VirtualizedList 仍是真正的滚动执行者；本状态机是其上的语义层，决定
 * 「流式增长是否应继续把视口推到底部」，并供 UI 显示暂停提示。
 */

export type StreamingScrollState = "following" | "paused";

export type StreamingScrollEvent =
  | { type: "stream_token" }
  | { type: "user_scroll_up" }
  | { type: "reach_bottom" }
  | { type: "stream_end" };

/** 纯转换函数：当前状态 + 事件 → 新状态。 */
export function streamingScrollReducer(
  state: StreamingScrollState,
  event: StreamingScrollEvent,
): StreamingScrollState {
  switch (event.type) {
    case "user_scroll_up":
      // 用户主动上滚 → 暂停跟随，让其安心阅读历史，不被新 token 拽回底部。
      return "paused";
    case "reach_bottom":
      // 回到底部 → 恢复跟随。
      return "following";
    case "stream_end":
      // 流式结束 → 复位为跟随，下一轮输出重新粘底。
      return "following";
    case "stream_token":
      // 新 token 不改变跟随/暂停意图，仅在 following 时由执行层推到底部。
      return state;
    default:
      return state;
  }
}

/** 在该状态下，流式新增内容是否应把视口推到底部。 */
export function shouldFollowOnToken(state: StreamingScrollState): boolean {
  return state === "following";
}

export const INITIAL_STREAMING_SCROLL_STATE: StreamingScrollState = "following";
