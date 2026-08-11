/**
 * ST8 流式↔滚动协调状态机单测
 *
 * 覆盖纯函数 streamingScrollReducer / shouldFollowOnToken：
 * - 初始态为 following
 * - user_scroll_up → paused（用户上滚暂停跟随）
 * - reach_bottom → following（回到底部恢复跟随）
 * - stream_end → following（流式结束复位，下一轮重新粘底）
 * - stream_token 不改变跟随/暂停意图（仅执行层据 shouldFollow 决定是否推底）
 * - shouldFollowOnToken 仅在 following 为 true
 */

import { test, expect, describe } from "bun:test";
import {
  streamingScrollReducer,
  shouldFollowOnToken,
  INITIAL_STREAMING_SCROLL_STATE,
  type StreamingScrollState,
} from "@sid-code/cli/ui/hooks/streamingScroll.ts";

describe("streamingScrollReducer", () => {
  test("初始态为 following", () => {
    expect(INITIAL_STREAMING_SCROLL_STATE).toBe("following");
  });

  test("following + user_scroll_up → paused", () => {
    expect(
      streamingScrollReducer("following", { type: "user_scroll_up" }),
    ).toBe("paused");
  });

  test("paused + reach_bottom → following", () => {
    expect(
      streamingScrollReducer("paused", { type: "reach_bottom" }),
    ).toBe("following");
  });

  test("paused + stream_end → following（流式结束复位）", () => {
    expect(streamingScrollReducer("paused", { type: "stream_end" })).toBe(
      "following",
    );
  });

  test("following + stream_end → following（保持）", () => {
    expect(streamingScrollReducer("following", { type: "stream_end" })).toBe(
      "following",
    );
  });

  test("stream_token 不改变状态意图（following 保持 following）", () => {
    expect(streamingScrollReducer("following", { type: "stream_token" })).toBe(
      "following",
    );
  });

  test("stream_token 不改变状态意图（paused 保持 paused）", () => {
    expect(streamingScrollReducer("paused", { type: "stream_token" })).toBe(
      "paused",
    );
  });

  test("paused + user_scroll_up → paused（幂等）", () => {
    expect(
      streamingScrollReducer("paused", { type: "user_scroll_up" }),
    ).toBe("paused");
  });

  test("following + reach_bottom → following（幂等）", () => {
    expect(
      streamingScrollReducer("following", { type: "reach_bottom" }),
    ).toBe("following");
  });

  test("典型序列：跟随 → 上滚暂停 → 持续 token 仍暂停 → 回底恢复 → 流式结束复位", () => {
    let state: StreamingScrollState = INITIAL_STREAMING_SCROLL_STATE;
    state = streamingScrollReducer(state, { type: "stream_token" });
    expect(state).toBe("following");
    state = streamingScrollReducer(state, { type: "user_scroll_up" });
    expect(state).toBe("paused");
    // 暂停期间新 token 不应把用户拽回底部
    state = streamingScrollReducer(state, { type: "stream_token" });
    state = streamingScrollReducer(state, { type: "stream_token" });
    expect(state).toBe("paused");
    state = streamingScrollReducer(state, { type: "reach_bottom" });
    expect(state).toBe("following");
    state = streamingScrollReducer(state, { type: "stream_end" });
    expect(state).toBe("following");
  });
});

describe("shouldFollowOnToken", () => {
  test("following → true（应推底）", () => {
    expect(shouldFollowOnToken("following")).toBe(true);
  });

  test("paused → false（不推底）", () => {
    expect(shouldFollowOnToken("paused")).toBe(false);
  });
});
