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
});
