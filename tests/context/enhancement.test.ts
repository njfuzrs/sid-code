/**
 * 智能压缩增强 + 压缩触发策略 + LLM 认知检测 测试
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Manager } from "../../src/context/manager.ts";
import { LoopDetector } from "../../src/agent/loop-detection.ts";

describe("findCompressSplitPoint", () => {
  test("在 user 消息处分割", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    for (let i = 0; i < 20; i++) {
      mgr.addMessage({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `消息 ${i} ${"x".repeat(100)}` }],
      });
    }

    const splitPoint = mgr.findCompressSplitPoint();
    expect(splitPoint).toBeGreaterThan(0);
    // 分割点应该是 user 消息
    const msgs = mgr.getMessages();
    expect(msgs[splitPoint].role).toBe("user");
  });

  test("不在 tool_result 消息处分割", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    // 添加包含 tool_use/tool_result 的对话
    mgr.addMessage({ role: "user", content: [{ type: "text", text: "请读取文件" }] });
    mgr.addMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "test.ts" } }],
    });
    mgr.addMessage({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(500) }],
    });
    mgr.addMessage({ role: "assistant", content: [{ type: "text", text: "文件内容如上" }] });
    // 再添加一些纯文本对话
    for (let i = 0; i < 16; i++) {
      mgr.addMessage({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `后续消息 ${i} ${"y".repeat(100)}` }],
      });
    }

    const splitPoint = mgr.findCompressSplitPoint();
    if (splitPoint > 0) {
      const msgs = mgr.getMessages();
      const splitMsg = msgs[splitPoint];
      // 分割点不应包含 tool_result
      const hasToolResult = splitMsg.content.some(b => b.type === "tool_result");
      expect(hasToolResult).toBe(false);
      expect(splitMsg.role).toBe("user");
    }
  });

  test("消息太少时返回 0", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    mgr.addMessage({ role: "user", content: [{ type: "text", text: "hello" }] });
    mgr.addMessage({ role: "assistant", content: [{ type: "text", text: "hi" }] });

    const splitPoint = mgr.findCompressSplitPoint();
    expect(splitPoint).toBe(0);
  });
});

describe("truncateForCompression", () => {
  test("预算充足时保留完整内容", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    const messages = [
      {
        role: "user" as const,
        content: [{ type: "tool_result" as const, tool_use_id: "t1", content: "short output" }],
      },
    ];

    const result = mgr.truncateForCompression(messages);
    expect(result[0].content[0].type).toBe("tool_result");
    if (result[0].content[0].type === "tool_result") {
      expect(result[0].content[0].content).toBe("short output");
    }
  });

  test("预算不足时截断旧输出", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    // 创建大量工具输出超过 50K token 预算
    const messages = [];
    for (let i = 0; i < 20; i++) {
      messages.push({
        role: "user" as const,
        content: [{
          type: "tool_result" as const,
          tool_use_id: `t${i}`,
          content: "a".repeat(20000), // 每个约 5K token
        }],
      });
    }

    const result = mgr.truncateForCompression(messages);
    // 最前面的输出应该被截断
    let truncatedCount = 0;
    for (const msg of result) {
      for (const block of msg.content) {
        if (block.type === "tool_result" && block.content.includes("[输出已截断")) {
          truncatedCount++;
        }
      }
    }
    expect(truncatedCount).toBeGreaterThan(0);
  });
});

describe("CompactionLevel", () => {
  // 使用标准窗口模型（200K）测试三层渐进压缩（绝对 buffer 40K/60K/80K）
  // token 估算规则（EST-6 后）：ASCII 0.20 token/char（含 >100K 字符的抽样快速近似，全 ASCII 仍 0.20）
  // 检查顺序：remaining ≤ 40K → emergency | ≤ 60K → hard | ≤ 80K → soft | > 80K → none

  test("none: 剩余 > 80K tokens", () => {
    const mgr = new Manager({ maxTokens: 200_000 });
    // 300K 字符 × 0.20 → 60K tokens，剩余 ~140K
    mgr.setSystemPrompt("a".repeat(300_000));
    expect(mgr.getCompactionLevel()).toBe("none");
  });

  test("soft: 剩余在 60K-80K → 触发工具输出遮罩", () => {
    const mgr = new Manager({ maxTokens: 200_000 });
    // 650K 字符 × 0.20 → 130K tokens，剩余 ~70K
    mgr.setSystemPrompt("a".repeat(650_000));
    expect(mgr.getCompactionLevel()).toBe("soft");
  });

  test("hard: 剩余在 40K-60K → 触发摘要压缩", () => {
    const mgr = new Manager({ maxTokens: 200_000 });
    // 750K 字符 × 0.20 → 150K tokens，剩余 ~50K
    mgr.setSystemPrompt("a".repeat(750_000));
    expect(mgr.getCompactionLevel()).toBe("hard");
  });

  test("emergency: 剩余 ≤ 40K → 紧急截断", () => {
    const mgr = new Manager({ maxTokens: 200_000 });
    // 850K 字符 × 0.20 → 170K tokens，剩余 ~30K
    mgr.setSystemPrompt("a".repeat(850_000));
    expect(mgr.getCompactionLevel()).toBe("emergency");
  });

  test("小窗口模型（≤ 60K）仅剩 10% 时触发 emergency", () => {
    const mgr = new Manager({ maxTokens: 50_000 });
    // 230K 字符 × 0.20 → 46K tokens，剩余 ~4K ≤ 10%
    mgr.setSystemPrompt("a".repeat(230_000));
    expect(mgr.getCompactionLevel()).toBe("emergency");
  });

  test("小窗口模型（≤ 60K）剩余 > 10% 时不触发", () => {
    const mgr = new Manager({ maxTokens: 50_000 });
    // 215K 字符 × 0.20 → 43K tokens，剩余 ~7K > 10%
    mgr.setSystemPrompt("a".repeat(215_000));
    expect(mgr.getCompactionLevel()).toBe("none");
  });
});

describe("emergencyTruncate", () => {
  test("紧急截断保留近期消息", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    for (let i = 0; i < 30; i++) {
      mgr.addMessage({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `消息 ${i} ${"x".repeat(200)}` }],
      });
    }

    const before = mgr.messageCount();
    mgr.emergencyTruncate();
    const after = mgr.messageCount();

    // 应该减少了消息
    expect(after).toBeLessThan(before);
    // 第一条应该是紧急压缩标记
    const msgs = mgr.getMessages();
    expect((msgs[0].content[0] as any).text).toContain("紧急压缩");
  });
});

describe("LoopDetector LLM 认知检测（需 SID_ENABLE_LOOP_DETECTION=1）", () => {
  beforeAll(() => {
    process.env.SID_ENABLE_LOOP_DETECTION = "1";
  });
  afterAll(() => {
    delete process.env.SID_ENABLE_LOOP_DETECTION;
  });
  test("30 轮前不触发 LLM 检测", () => {
    const detector = new LoopDetector();
    for (let i = 0; i < 29; i++) {
      detector.recordTurn();
    }
    expect(detector.shouldRunLLMCheck()).toBe(false);
  });

  test("30 轮时触发 LLM 检测", () => {
    const detector = new LoopDetector();
    for (let i = 0; i < 30; i++) {
      detector.recordTurn();
    }
    expect(detector.shouldRunLLMCheck()).toBe(true);
  });

  test("触发后需间隔 10 轮才能再次触发", () => {
    const detector = new LoopDetector();
    for (let i = 0; i < 30; i++) {
      detector.recordTurn();
    }
    expect(detector.shouldRunLLMCheck()).toBe(true);

    // 再过 5 轮不应触发
    for (let i = 0; i < 5; i++) {
      detector.recordTurn();
    }
    expect(detector.shouldRunLLMCheck()).toBe(false);

    // 再过 5 轮应触发
    for (let i = 0; i < 5; i++) {
      detector.recordTurn();
    }
    expect(detector.shouldRunLLMCheck()).toBe(true);
  });

  test("置信度低于阈值时不报循环", () => {
    const detector = new LoopDetector();
    const result = detector.processLLMResult({
      is_loop: true,
      confidence: 0.5,
      reason: "可能在循环",
    });
    expect(result).toBe(false);
  });

  test("置信度高于阈值时报循环", () => {
    const detector = new LoopDetector();
    const result = detector.processLLMResult({
      is_loop: true,
      confidence: 0.95,
      reason: "反复读取同一文件",
    });
    expect(result).toBe(true);
  });

  test("is_loop 为 false 时不报循环", () => {
    const detector = new LoopDetector();
    const result = detector.processLLMResult({
      is_loop: false,
      confidence: 0.99,
      reason: "正常的批量操作",
    });
    expect(result).toBe(false);
  });

  test("reset 重置轮次计数", () => {
    const detector = new LoopDetector();
    for (let i = 0; i < 30; i++) {
      detector.recordTurn();
    }
    expect(detector.getTurnCount()).toBe(30);

    detector.reset();
    expect(detector.getTurnCount()).toBe(0);
    expect(detector.shouldRunLLMCheck()).toBe(false);
  });

  test("buildLLMCheckPrompt 提取工具调用序列", () => {
    const detector = new LoopDetector();
    const messages = [
      {
        role: "assistant" as const,
        content: [
          { type: "tool_use" as const, id: "t1", name: "read", input: { path: "a.ts" } },
        ],
      },
      {
        role: "user" as const,
        content: [{ type: "tool_result" as const, tool_use_id: "t1", content: "file content" }],
      },
      {
        role: "assistant" as const,
        content: [
          { type: "tool_use" as const, id: "t2", name: "edit", input: { path: "a.ts", old: "x", new: "y" } },
        ],
      },
    ];

    const prompt = detector.buildLLMCheckPrompt(messages);
    expect(prompt).toContain("read(");
    expect(prompt).toContain("edit(");
    expect(prompt).toContain("a.ts");
  });
});
