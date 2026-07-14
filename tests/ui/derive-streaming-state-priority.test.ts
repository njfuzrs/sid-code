/**
 * deriveStreamingState 纯函数单测 — §6.4
 *
 * 从 TUIState 的若干布尔/对象标志派生 UI 流式状态枚举。
 * 去掉 App.tsx useMemo 的内部逻辑便于单独验证。
 *
 * 优先级（从高到低）：
 * 1. 有待确认请求（权限/shell/计划）→ WaitingForConfirmation
 * 2. 正在流式 / 工具执行中           → Responding
 * 3. 已提交但还没首字                 → Connecting
 * 4. 其余                            → Idle
 */

import { test, expect, describe } from "bun:test";
import { deriveStreamingState } from "../../src/ui/derive-streaming-state.ts";
import { StreamingState } from "../../src/ui/types.ts";

describe("deriveStreamingState — 优先级链", () => {
  test("全部空闲 → Idle", () => {
    expect(
      deriveStreamingState({
        isLoading: false,
        isStreaming: false,
        isToolExecuting: false,
        permissionRequest: undefined,
        shellConfirmRequest: undefined,
        planApprovalRequest: undefined,
        askUserQuestionRequest: undefined,
      }),
    ).toBe(StreamingState.Idle);
  });

  test("isLoading=true, 但 isStreaming/isToolExecuting 均为 false → Connecting（消灭盲区 1）", () => {
    expect(
      deriveStreamingState({
        isLoading: true,
        isStreaming: false,
        isToolExecuting: false,
        permissionRequest: undefined,
        shellConfirmRequest: undefined,
        planApprovalRequest: undefined,
        askUserQuestionRequest: undefined,
      }),
    ).toBe(StreamingState.Connecting);
  });

  test("isLoading=true 且 isStreaming=true → Responding（Responding 优先于 Connecting）", () => {
    expect(
      deriveStreamingState({
        isLoading: true,
        isStreaming: true,
        isToolExecuting: false,
        permissionRequest: undefined,
        shellConfirmRequest: undefined,
        planApprovalRequest: undefined,
        askUserQuestionRequest: undefined,
      }),
    ).toBe(StreamingState.Responding);
  });

  test("isLoading=true 且 isToolExecuting=true → Responding", () => {
    expect(
      deriveStreamingState({
        isLoading: true,
        isStreaming: false,
        isToolExecuting: true,
        permissionRequest: undefined,
        shellConfirmRequest: undefined,
        planApprovalRequest: undefined,
        askUserQuestionRequest: undefined,
      }),
    ).toBe(StreamingState.Responding);
  });

  test("permissionRequest 存在 → WaitingForConfirmation（最高优先，即使 isLoading + isStreaming 均为 true）", () => {
    expect(
      deriveStreamingState({
        isLoading: true,
        isStreaming: true,
        isToolExecuting: false,
        permissionRequest: { tool: "bash", command: "rm -rf /" },
        shellConfirmRequest: undefined,
        planApprovalRequest: undefined,
        askUserQuestionRequest: undefined,
      }),
    ).toBe(StreamingState.WaitingForConfirmation);
  });

  test("shellConfirmRequest 存在 → WaitingForConfirmation", () => {
    expect(
      deriveStreamingState({
        isLoading: false,
        isStreaming: false,
        isToolExecuting: false,
        permissionRequest: undefined,
        shellConfirmRequest: { message: "确认执行?" },
        planApprovalRequest: undefined,
        askUserQuestionRequest: undefined,
      }),
    ).toBe(StreamingState.WaitingForConfirmation);
  });

  test("planApprovalRequest 存在 → WaitingForConfirmation", () => {
    expect(
      deriveStreamingState({
        isLoading: false,
        isStreaming: false,
        isToolExecuting: false,
        permissionRequest: undefined,
        shellConfirmRequest: undefined,
        planApprovalRequest: { planId: "plan-1" },
        askUserQuestionRequest: undefined,
      }),
    ).toBe(StreamingState.WaitingForConfirmation);
  });

  test("多个确认请求同时存在 → WaitingForConfirmation", () => {
    expect(
      deriveStreamingState({
        isLoading: true,
        isStreaming: false,
        isToolExecuting: false,
        permissionRequest: { tool: "bash" },
        shellConfirmRequest: { message: "确认?" },
        planApprovalRequest: undefined,
        askUserQuestionRequest: undefined,
      }),
    ).toBe(StreamingState.WaitingForConfirmation);
  });

  test("isLoading=false, isStreaming=true → Responding（首字已到，isLoading 可能已被消费）", () => {
    expect(
      deriveStreamingState({
        isLoading: false,
        isStreaming: true,
        isToolExecuting: false,
        permissionRequest: undefined,
        shellConfirmRequest: undefined,
        planApprovalRequest: undefined,
        askUserQuestionRequest: undefined,
      }),
    ).toBe(StreamingState.Responding);
  });
});
