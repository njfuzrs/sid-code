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

  test("needsCompaction 在 token 超过阈值时返回 true", () => {
    const mgr = new Manager({ maxTokens: 100, compactThreshold: 0.5 });
    // 添加足够多的内容超过 50 tokens（100 * 0.5）
    mgr.addMessage({
      role: "user",
      content: [{ type: "text", text: "x".repeat(400) }], // ~100 tokens
    });

    expect(mgr.needsCompaction()).toBe(true);
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
