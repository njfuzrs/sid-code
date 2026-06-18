import { describe, expect, test } from "bun:test";
import { getConversationClearedPatch } from "../../src/ui/state-bridge.ts";

describe("getConversationClearedPatch", () => {
  test("应重置会话视图相关状态，确保 /clear 后界面回到空白状态", () => {
    const patch = getConversationClearedPatch();

    expect(patch.messages).toEqual([]);
    expect(patch.displayItems).toEqual([]);
    expect(patch.historyItems).toEqual([]);
    expect(patch.toolName).toBeNull();
    expect(patch.toolInput).toBeNull();
    expect(patch.isToolExecuting).toBe(false);
    expect(patch.contextPercent).toBe(0);
    expect(patch.statusMessage).toBe("");
    expect(patch.lastToolResult).toBeNull();
    expect(patch.streamingText).toBe("");
    expect(patch.isStreaming).toBe(false);
    expect(patch.streamingLine).toBe("");
    expect(patch.permissionRequest).toBeNull();
    expect(patch.shellConfirmRequest).toBeNull();
    expect(patch.activeDialog).toBeNull();
  });

  // §五（fdb47f30）：/clear 后状态栏的 token/缓存/费用/上下文占用必须归零，
  // 与清空的对话上下文保持一致。这是本次修复的核心字段，单独断言防回归。
  test("应清空状态栏统计三件套（token/费用/上下文占用）", () => {
    const patch = getConversationClearedPatch();
    expect(patch.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(patch.stockInputTokens).toBe(0);
    expect(patch.costUSD).toBe(0);
    expect(patch.contextPercent).toBe(0);
    expect(patch.todos).toEqual([]);
    expect(patch.tasks).toEqual([]);
    expect(patch.retryStatus).toBeNull();
  });
});
