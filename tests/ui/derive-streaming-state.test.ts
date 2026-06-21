/**
 * deriveStreamingState 派生纯函数测试
 *
 * 验证 §6.4：从 TUIState 切片派生 StreamingState 的优先级与 Connecting 分支。
 */

import { test, expect, describe } from "bun:test";
import { deriveStreamingState, type StreamingStateInput } from "../../src/ui/derive-streaming-state.ts";
import { StreamingState } from "../../src/ui/types.ts";

const base: StreamingStateInput = {
  isLoading: false,
  isStreaming: false,
  isToolExecuting: false,
  permissionRequest: null,
  shellConfirmRequest: null,
  planApprovalRequest: null,
  askUserQuestionRequest: null,
};

describe("deriveStreamingState", () => {
  test("已提交未收首字 → Connecting（消灭首字延迟盲区）", () => {
    expect(deriveStreamingState({ ...base, isLoading: true })).toBe(
      StreamingState.Connecting,
    );
  });

  test("isStreaming → Responding（首字到达，Responding 优先于 Connecting）", () => {
    expect(
      deriveStreamingState({ ...base, isLoading: true, isStreaming: true }),
    ).toBe(StreamingState.Responding);
  });

  test("isToolExecuting → Responding", () => {
    expect(
      deriveStreamingState({ ...base, isLoading: true, isToolExecuting: true }),
    ).toBe(StreamingState.Responding);
  });

  test("permissionRequest → WaitingForConfirmation（最高优先，盖过流式/连接）", () => {
    expect(
      deriveStreamingState({
        ...base,
        isLoading: true,
        isStreaming: true,
        permissionRequest: { foo: 1 },
      }),
    ).toBe(StreamingState.WaitingForConfirmation);
  });

  test("shellConfirmRequest → WaitingForConfirmation", () => {
    expect(
      deriveStreamingState({ ...base, shellConfirmRequest: { foo: 1 } }),
    ).toBe(StreamingState.WaitingForConfirmation);
  });

  test("planApprovalRequest → WaitingForConfirmation", () => {
    expect(
      deriveStreamingState({ ...base, planApprovalRequest: { foo: 1 } }),
    ).toBe(StreamingState.WaitingForConfirmation);
  });

  test("askUserQuestionRequest → WaitingForConfirmation", () => {
    expect(
      deriveStreamingState({ ...base, askUserQuestionRequest: { foo: 1 } }),
    ).toBe(StreamingState.WaitingForConfirmation);
  });

  test("全 false → Idle", () => {
    expect(deriveStreamingState(base)).toBe(StreamingState.Idle);
  });
});
