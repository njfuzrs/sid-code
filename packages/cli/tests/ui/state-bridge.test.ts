import { describe, expect, test } from "bun:test";
import { getConversationClearedPatch } from "@sid-code/cli/ui/state-bridge.ts";

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

// ─── 流式合帧（updateStreaming）───
// 背景：流式回调每 token 一次 update → 每 token 一次整树 reconcile。合帧后 emit 降到
// 每 STREAM_FLUSH_MS 一次。下面锁住三条约束：current 同步、窗口内只 emit 一次、
// 普通 update 立即带出待发状态（不乱序、不延后状态切换）。
describe("StateBridge.updateStreaming 合帧", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const mk = async () => {
    const { StateBridge } = await import("@sid-code/cli/ui/state-bridge.ts");
    const bridge = new StateBridge({ streamingText: "", isStreaming: false } as any);
    const emitted: string[] = [];
    bridge.on("change", (s: any) => emitted.push(s.streamingText));
    return { bridge, emitted };
  };

  test("current 同步合并，窗口内多次更新只 emit 一次且是最新值", async () => {
    const { bridge, emitted } = await mk();
    const { STREAM_FLUSH_MS } = await import("@sid-code/cli/ui/state-bridge.ts");
    for (let i = 1; i <= 50; i++) {
      bridge.updateStreaming({ streamingText: "x".repeat(i) } as any);
      // 同步读 current 必须是最新值（app.ts 大量同步读 bridge.current）
      expect((bridge.current as any).streamingText.length).toBe(i);
    }
    expect(emitted).toEqual([]);
    await sleep(STREAM_FLUSH_MS + 20);
    expect(emitted).toEqual(["x".repeat(50)]);
    bridge.detach();
  });

  test("持续流式下每个窗口都出帧（固定窗口，不是 debounce）", async () => {
    const { bridge, emitted } = await mk();
    const { STREAM_FLUSH_MS } = await import("@sid-code/cli/ui/state-bridge.ts");
    const end = Date.now() + STREAM_FLUSH_MS * 5;
    let n = 0;
    while (Date.now() < end) {
      bridge.updateStreaming({ streamingText: String(++n) } as any);
      await sleep(4);
    }
    // debounce 实现在持续输入下会是 0 帧；固定窗口至少 3 帧
    expect(emitted.length).toBeGreaterThanOrEqual(3);
    bridge.detach();
  });

  test("普通 update 立即 emit 并带出待发流式状态，之后不再补发旧帧", async () => {
    const { bridge, emitted } = await mk();
    const { STREAM_FLUSH_MS } = await import("@sid-code/cli/ui/state-bridge.ts");
    bridge.updateStreaming({ streamingText: "abc" } as any);
    bridge.update({ isStreaming: false } as any);
    expect(emitted).toEqual(["abc"]);
    await sleep(STREAM_FLUSH_MS + 20);
    // 待发定时器已被 update 取消：不会在状态切换之后又补发一帧
    expect(emitted).toEqual(["abc"]);
    bridge.detach();
  });

  test("detach 取消待发定时器", async () => {
    const { bridge, emitted } = await mk();
    const { STREAM_FLUSH_MS } = await import("@sid-code/cli/ui/state-bridge.ts");
    bridge.updateStreaming({ streamingText: "z" } as any);
    bridge.detach();
    await sleep(STREAM_FLUSH_MS + 20);
    expect(emitted).toEqual([]);
  });
});
