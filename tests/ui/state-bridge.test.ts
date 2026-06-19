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

  // 对照完整 TUIState 补齐的高影响残留字段（Harness×LLM 对照评判 §1 矛盾①）：
  // planApprovalRequest 不清会导致 /clear 后审批框不消失；isLoading/copyModeEnabled/isPlanMode
  // 残留会让加载态/Copy 模式/plan 模式标志错乱；turnStartOutputTokens 不归零会让 Composer
  // 用旧基线作差，清空后首条消息的「本轮输出 token」算出负数或虚高。逐条断言防回归。
  test("应重置审批框 / 加载 / 模式标志 / 本轮输出基线等用户可见残留字段", () => {
    const patch = getConversationClearedPatch();
    expect(patch.planApprovalRequest).toBeNull();
    expect(patch.isLoading).toBe(false);
    expect(patch.copyModeEnabled).toBe(false);
    expect(patch.isPlanMode).toBe(false);
    expect(patch.streamingThinking).toBe("");
    expect(patch.turnStartOutputTokens).toBe(0);
  });
});
