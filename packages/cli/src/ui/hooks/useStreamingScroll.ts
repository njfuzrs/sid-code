/**
 * 流式 ↔ 滚动协调 Hook — ST8
 *
 * 把 streamingScroll.ts 的纯状态机接到 React，并对外暴露：
 * - paused：用户是否已滚离底部、暂停了流式跟随（供 UI 显示「跟随已暂停」提示）
 * - onStreamToken / onUserScrollUp / onReachBottom / onStreamEnd：事件派发
 * - shouldFollow：当前是否应让流式增长把视口推到底部
 *
 * VirtualizedList 的 isStickingToBottom 仍是滚动执行者；本 hook 是其上的语义层，
 * 让「暂停/跟随」状态可被观测、可被其它组件协调（如 Footer 提示、停止自动推底）。
 */

import { useReducer, useCallback, useMemo } from "react";
import {
  streamingScrollReducer,
  shouldFollowOnToken,
  INITIAL_STREAMING_SCROLL_STATE,
  type StreamingScrollState,
} from "./streamingScroll.ts";

export interface StreamingScrollController {
  state: StreamingScrollState;
  /** 用户已滚离底部、暂停跟随。 */
  paused: boolean;
  /** 当前是否应在新 token 到达时把视口推到底部。 */
  shouldFollow: boolean;
  onStreamToken: () => void;
  onUserScrollUp: () => void;
  onReachBottom: () => void;
  onStreamEnd: () => void;
}

export function useStreamingScroll(): StreamingScrollController {
  const [state, dispatch] = useReducer(streamingScrollReducer, INITIAL_STREAMING_SCROLL_STATE);

  const onStreamToken = useCallback(() => dispatch({ type: "stream_token" }), []);
  const onUserScrollUp = useCallback(() => dispatch({ type: "user_scroll_up" }), []);
  const onReachBottom = useCallback(() => dispatch({ type: "reach_bottom" }), []);
  const onStreamEnd = useCallback(() => dispatch({ type: "stream_end" }), []);

  return useMemo<StreamingScrollController>(
    () => ({
      state,
      paused: state === "paused",
      shouldFollow: shouldFollowOnToken(state),
      onStreamToken,
      onUserScrollUp,
      onReachBottom,
      onStreamEnd,
    }),
    [state, onStreamToken, onUserScrollUp, onReachBottom, onStreamEnd],
  );
}
