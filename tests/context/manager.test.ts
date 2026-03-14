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

  test("getMaxTokens 返回配置的最大 token 数", () => {
    const mgr = new Manager({ maxTokens: 200000 });
    expect(mgr.getMaxTokens()).toBe(200000);
  });

  test("默认 compactThreshold 为 0.7", () => {
    const mgr = new Manager({ maxTokens: 1000 });
    // 700 tokens 以上应触发压缩（0.7 * 1000 = 700）
    mgr.setSystemPrompt("a".repeat(2800)); // ~700 tokens
    expect(mgr.needsCompaction(0)).toBe(false);
    mgr.setSystemPrompt("a".repeat(2900)); // ~725 tokens > 700
    expect(mgr.needsCompaction(0)).toBe(true);
  });

  test("compactWithSummary 默认保留 10 条消息", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    // 添加 14 条消息（7 轮对话）
    for (let i = 0; i < 14; i++) {
      mgr.addMessage({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `消息 ${i}` }],
      });
    }
    expect(mgr.messageCount()).toBe(14);

    mgr.compactWithSummary("摘要内容");
    // 摘要 + 确认 + 保留 10 条 = 12 条
    expect(mgr.messageCount()).toBe(12);
  });
});

describe("truncateToolOutput 智能截断", () => {
  test("短内容不截断", () => {
    const content = "hello world";
    expect(Manager.truncateToolOutput(content)).toBe(content);
  });

  test("普通文本：70% 头 + 30% 尾", () => {
    // 生成超过 30000 字符的普通文本
    const content = "x".repeat(50000);
    const result = Manager.truncateToolOutput(content);

    expect(result.length).toBeLessThan(content.length);
    expect(result).toContain("省略约");
    expect(result).toContain("字符");
    // 头部应该是原始内容的前 70%
    expect(result.startsWith("x".repeat(100))).toBe(true);
    // 尾部应该是原始内容的后 30%
    expect(result.endsWith("x".repeat(100))).toBe(true);
  });

  test("文件内容（行号特征 →）：保留前 20 行 + 后 10 行", () => {
    // 生成带行号特征的超长内容
    const lines = Array.from({ length: 100 }, (_, i) => `${i + 1}→ line content ${i}`);
    const content = lines.join("\n");
    // 确保超过阈值
    const padded = content + "\n" + "x".repeat(30000);
    const result = Manager.truncateToolOutput(padded);

    expect(result).toContain("1→ line content 0");  // 头部
    expect(result).toContain("省略");
    expect(result).toContain("行");
  });

  test("文件内容（行号特征 │）：保留前 20 行 + 后 10 行", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `  ${i + 1} │ line content ${i}`);
    const content = lines.join("\n");
    const padded = content + "\n" + "x".repeat(30000);
    const result = Manager.truncateToolOutput(padded);

    expect(result).toContain("1 │ line content 0");
    expect(result).toContain("省略");
  });

  test("代码块：保留 60% 头 + 40% 尾", () => {
    // 生成包含大代码块的内容
    const codeLines = Array.from({ length: 200 }, (_, i) => `  const x${i} = ${i};`);
    const content = "前面的文本\n```typescript\n" + codeLines.join("\n") + "\n```\n后面的文本" + "x".repeat(30000);
    const result = Manager.truncateToolOutput(content);

    // 代码块应该被压缩
    expect(result).toContain("省略");
  });

  test("自定义 maxChars 参数", () => {
    const content = "a".repeat(2000);
    const result = Manager.truncateToolOutput(content, 1000);

    expect(result.length).toBeLessThan(content.length);
    expect(result).toContain("省略约");
  });
});

describe("增量压缩", () => {
  test("addMessage 自动截断超大 tool_result", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    const bigContent = "x".repeat(50000);

    mgr.addMessage({
      role: "user",
      content: [{ type: "text", text: "test" }],
    });
    mgr.addMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: "c1", name: "read", input: {} }],
    });
    mgr.addMessage({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "c1",
        content: bigContent,
        is_error: false,
      }],
    });

    const msgs = mgr.getMessages();
    const toolResult = msgs[2].content[0];
    expect(toolResult.type).toBe("tool_result");
    if (toolResult.type === "tool_result") {
      // 应该被截断了
      expect(toolResult.content.length).toBeLessThan(bigContent.length);
      expect(toolResult.content).toContain("省略约");
    }
  });

  test("addMessage 不截断小的 tool_result", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    const smallContent = "小输出内容";

    mgr.addMessage({
      role: "user",
      content: [{ type: "text", text: "test" }],
    });
    mgr.addMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: "c1", name: "read", input: {} }],
    });
    mgr.addMessage({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "c1",
        content: smallContent,
        is_error: false,
      }],
    });

    const msgs = mgr.getMessages();
    const toolResult = msgs[2].content[0];
    if (toolResult.type === "tool_result") {
      expect(toolResult.content).toBe(smallContent);
    }
  });
});
