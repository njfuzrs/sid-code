/**
 * 上下文管理器测试
 */

import { describe, test, expect } from "bun:test";
import { Manager } from "../../src/context/manager.ts";

describe("ContextManager", () => {
  test("添加和获取消息", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    mgr.addMessage({
      role: "user",
      content: [{ type: "text", text: "你好" }],
    });
    mgr.addMessage({
      role: "assistant",
      content: [{ type: "text", text: "你好！有什么可以帮你的？" }],
    });

    expect(mgr.messageCount()).toBe(2);
    const msgs = mgr.getMessages();
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
  });

  test("系统提示词设置和获取", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    mgr.setSystemPrompt("你是一个编程助手");
    expect(mgr.getSystemPrompt()).toBe("你是一个编程助手");
  });

  test("token 估算", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    mgr.setSystemPrompt("a".repeat(400)); // ~100 tokens
    mgr.addMessage({
      role: "user",
      content: [{ type: "text", text: "b".repeat(200) }], // ~50 tokens
    });

    const tokens = mgr.estimateTokens();
    expect(tokens).toBeGreaterThan(100);
  });

  test("token 估算包含工具定义开销", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    const baseTokens = mgr.estimateTokens(0);
    const withTools = mgr.estimateTokens(6); // 6 个工具

    // 6 个工具 × 80 token/工具 = 480 token 开销
    expect(withTools - baseTokens).toBe(480);
  });

  test("token 估算包含消息结构开销", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    const before = mgr.estimateTokens();

    mgr.addMessage({
      role: "user",
      content: [{ type: "text", text: "" }], // 空文本，只有结构开销
    });

    const after = mgr.estimateTokens();
    // 每条消息 4 token 结构开销
    expect(after - before).toBe(4);
  });

  test("token 估算 tool_use 块包含额外开销", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    mgr.addMessage({
      role: "user",
      content: [{ type: "text", text: "test" }],
    });
    mgr.addMessage({
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "c1",
        name: "read",
        input: {},
      }],
    });

    const tokens = mgr.estimateTokens();
    // 应包含 tool_use 的 20 token 结构开销
    expect(tokens).toBeGreaterThan(20);
  });

  test("needsCompaction 支持 toolCount 参数", () => {
    const mgr = new Manager({ maxTokens: 1000, compactThreshold: 0.5 });
    // 不带工具时不需要压缩
    expect(mgr.needsCompaction(0)).toBe(false);
    // 带大量工具时可能需要压缩（6 × 80 = 480 > 500 阈值）
    expect(mgr.needsCompaction(7)).toBe(true); // 7 × 80 = 560 > 500
  });

  test("compactWithSummary 用摘要替换历史", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    // 添加 6 条消息
    for (let i = 0; i < 6; i++) {
      mgr.addMessage({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `消息 ${i}` }],
      });
    }

    expect(mgr.messageCount()).toBe(6);
    mgr.compactWithSummary("这是之前对话的摘要", 2);

    // 摘要消息 + 确认消息 + 保留的 2 条 = 4 条
    expect(mgr.messageCount()).toBe(4);
    const msgs = mgr.getMessages();
    expect(msgs[0].content[0]).toHaveProperty("text");
    expect((msgs[0].content[0] as any).text).toContain("对话摘要");
  });

  test("clear 清空所有消息", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    mgr.addMessage({
      role: "user",
      content: [{ type: "text", text: "test" }],
    });
    mgr.clear();
    expect(mgr.messageCount()).toBe(0);
  });
});
