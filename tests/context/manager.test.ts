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
    // 添加 20 条消息（10 轮对话），确保有足够消息触发压缩
    for (let i = 0; i < 20; i++) {
      mgr.addMessage({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `消息 ${i} ${"x".repeat(100)}` }],
      });
    }

    const before = mgr.messageCount();
    expect(before).toBe(20);
    mgr.compactWithSummary("这是之前对话的摘要");

    // 压缩后消息数应减少（摘要 + 确认 + 保留的近期消息）
    expect(mgr.messageCount()).toBeLessThan(before);
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
    // 700 tokens 以上应触发压缩（0.7 * 1000 = 700）；ASCII 系数 0.20 → 700 tokens ≈ 3500 字符
    mgr.setSystemPrompt("a".repeat(3300)); // ~660 tokens < 700
    expect(mgr.needsCompaction(0)).toBe(false);
    mgr.setSystemPrompt("a".repeat(3700)); // ~740 tokens > 700
    expect(mgr.needsCompaction(0)).toBe(true);
  });

  test("compactWithSummary 使用安全分割点压缩", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    // 添加 20 条消息（10 轮对话），确保有足够内容触发分割
    for (let i = 0; i < 20; i++) {
      mgr.addMessage({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `消息 ${i} ${"x".repeat(100)}` }],
      });
    }
    expect(mgr.messageCount()).toBe(20);

    mgr.compactWithSummary("摘要内容");
    // 压缩后消息数应减少，且第一条是摘要
    expect(mgr.messageCount()).toBeLessThan(20);
    const msgs = mgr.getMessages();
    expect((msgs[0].content[0] as any).text).toContain("对话摘要");
    expect((msgs[1].content[0] as any).text).toContain("了解");
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
  test("addMessage 自动截断超大 tool_result (非豁免工具)", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    const bigContent = "x".repeat(50000);

    mgr.addMessage({
      role: "user",
      content: [{ type: "text", text: "test" }],
    });
    mgr.addMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: "c1", name: "bash", input: {} }],
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
      // 应该被持久化到磁盘，content 变为 ~200 字节的轻量引用
      expect(toolResult.content.length).toBeLessThan(bigContent.length);
      expect(toolResult.content).toContain("[持久化输出]");
      expect(toolResult.content).toContain("tool_use_id=c1");
      expect(toolResult.content).toContain("tool=bash");
    }
  });

  test("addMessage 豁免 read/edit/write 工具的大输出（不立即持久化）", () => {
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
      // read 工具豁免即时持久化，内容应保持原样
      expect(toolResult.content.length).toBe(bigContent.length);
      expect(toolResult.content).not.toContain("[持久化输出]");
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

  test("P1-7：recordActualTokens 校准估算向真实 usage 收敛", () => {
    const mgr = new Manager({ maxTokens: 200_000 });
    mgr.addMessage({ role: "user", content: [{ type: "text", text: "x".repeat(10_000) }] });
    const raw = mgr.estimateTokens(0);
    // 假设真实 input 是纯启发式估算的 2 倍 → factor 应趋向 2
    mgr.recordActualTokens(raw * 2, 0);
    const calibrated = mgr.estimateTokens(0);
    // 校准后应明显大于原始估算（向真实值靠拢），且不小于真实锚点
    expect(calibrated).toBeGreaterThan(raw);
    expect(calibrated).toBeGreaterThanOrEqual(raw * 2);
  });

  test("P1-6：estimateTokens 不低于上次真实输入锚点", () => {
    const mgr = new Manager({ maxTokens: 200_000 });
    mgr.addMessage({ role: "user", content: [{ type: "text", text: "hi" }] });
    // 真实输入 50000（远大于这条短消息的字符估算）
    mgr.recordActualTokens(50_000, 0);
    // compact 决策依赖的估算不应塌缩到字符估算的极小值，至少守住真实锚点
    expect(mgr.estimateTokens(0)).toBeGreaterThanOrEqual(50_000);
  });

  test("recordActualTokens 忽略非法真实值（0/负/NaN）", () => {
    const mgr = new Manager({ maxTokens: 200_000 });
    mgr.addMessage({ role: "user", content: [{ type: "text", text: "x".repeat(1000) }] });
    const before = mgr.estimateTokens(0);
    mgr.recordActualTokens(0, 0);
    mgr.recordActualTokens(-100, 0);
    mgr.recordActualTokens(NaN, 0);
    // 未校准，估算保持纯启发式不变
    expect(mgr.estimateTokens(0)).toBe(before);
  });

  test("P1-6：compactWithSummary 后真实锚点失效，估算回落（不再被旧高锚点钉死）", () => {
    const mgr = new Manager({ maxTokens: 200_000 });
    for (let i = 0; i < 12; i++) {
      mgr.addMessage({ role: "user", content: [{ type: "text", text: `msg-${i} ${"x".repeat(200)}` }] });
      mgr.addMessage({ role: "assistant", content: [{ type: "text", text: `reply-${i}` }] });
    }
    // 锚定一个远高于压缩后真实量的值
    mgr.recordActualTokens(180_000, 0);
    expect(mgr.estimateTokens(0)).toBeGreaterThanOrEqual(180_000);
    // 压缩后真实 prompt 骤降，锚点必须失效，否则估算仍被钉在 180k → 刚压缩完又触发 compact
    mgr.compactWithSummary("早期对话摘要");
    expect(mgr.estimateTokens(0)).toBeLessThan(180_000);
  });

  test("P1-6：emergencyTruncate / setMessages / clear 均重置真实锚点", () => {
    // emergencyTruncate
    const m1 = new Manager({ maxTokens: 200_000 });
    for (let i = 0; i < 12; i++) {
      m1.addMessage({ role: "user", content: [{ type: "text", text: `u${i} ${"x".repeat(200)}` }] });
      m1.addMessage({ role: "assistant", content: [{ type: "text", text: `a${i}` }] });
    }
    m1.recordActualTokens(180_000, 0);
    m1.emergencyTruncate();
    expect(m1.estimateTokens(0)).toBeLessThan(180_000);

    // setMessages
    const m2 = new Manager({ maxTokens: 200_000 });
    m2.addMessage({ role: "user", content: [{ type: "text", text: "hi" }] });
    m2.recordActualTokens(150_000, 0);
    m2.setMessages([{ role: "user", content: [{ type: "text", text: "short" }] }]);
    expect(m2.estimateTokens(0)).toBeLessThan(150_000);

    // clear
    const m3 = new Manager({ maxTokens: 200_000 });
    m3.addMessage({ role: "user", content: [{ type: "text", text: "hi" }] });
    m3.recordActualTokens(150_000, 0);
    m3.clear();
    expect(m3.estimateTokens(0)).toBeLessThan(150_000);
  });

  test("P2-3：setMaxTokens 更新上下文窗口，忽略非法值", () => {
    const mgr = new Manager({ maxTokens: 200_000 });
    expect(mgr.getMaxTokens()).toBe(200_000);
    mgr.setMaxTokens(1_000_000);
    expect(mgr.getMaxTokens()).toBe(1_000_000);
    // 非法值忽略，保持原窗口
    mgr.setMaxTokens(0);
    mgr.setMaxTokens(-5);
    mgr.setMaxTokens(NaN);
    expect(mgr.getMaxTokens()).toBe(1_000_000);
  });
});
