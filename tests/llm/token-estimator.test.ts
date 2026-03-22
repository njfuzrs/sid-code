/**
 * Token 估算服务测试
 * Task 4：中英文混合文本的 token 估算精度（±20% 以内）
 */

import { describe, test, expect } from "bun:test";
import { TokenEstimator } from "../../src/llm/token-estimator.ts";

const estimator = new TokenEstimator();

describe("TokenEstimator", () => {
  // === estimateText ===
  describe("estimateText", () => {
    test("空字符串返回 0", () => {
      expect(estimator.estimateText("")).toBe(0);
    });

    test("纯 ASCII 文本：约 0.25 token/char", () => {
      const text = "Hello, this is a test message for token estimation.";
      const tokens = estimator.estimateText(text);
      // 51 chars * 0.25 = 12.75 → ceil = 13
      expect(tokens).toBe(13);
    });

    test("纯中文文本：约 1.3 token/char", () => {
      const text = "这是一个测试消息";
      const tokens = estimator.estimateText(text);
      // 8 chars * 1.3 = 10.4 → ceil = 11
      expect(tokens).toBe(11);
    });

    test("中英文混合文本", () => {
      const text = "Hello 你好 World 世界";
      const tokens = estimator.estimateText(text);
      // ASCII: "Hello  World " = 13 chars * 0.25 = 3.25
      // CJK: "你好世界" = 4 chars * 1.3 = 5.2
      // total = 8.45 → ceil = 9
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(20);
    });

    test("超长文本使用快速近似（0.35）", () => {
      const text = "a".repeat(200_000);
      const tokens = estimator.estimateText(text);
      // 200000 * 0.35 = 70000
      expect(tokens).toBe(70000);
    });

    test("刚好在阈值内使用精确计算", () => {
      const text = "a".repeat(100_000);
      const tokens = estimator.estimateText(text);
      // 100000 * 0.25 = 25000
      expect(tokens).toBe(25000);
    });
  });

  // === estimateMessages ===
  describe("estimateMessages", () => {
    test("空消息列表返回 0", () => {
      expect(estimator.estimateMessages([])).toBe(0);
    });

    test("单条文本消息", () => {
      const tokens = estimator.estimateMessages([
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ]);
      // 4 (overhead) + ceil(5 * 0.25) = 4 + 2 = 6
      expect(tokens).toBe(6);
    });

    test("包含 tool_use 块", () => {
      const tokens = estimator.estimateMessages([
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "read",
              input: { path: "/tmp/test.ts" },
            },
          ],
        },
      ]);
      // 4 (overhead) + estimateText("read") + estimateText(JSON.stringify({path:"/tmp/test.ts"}))
      expect(tokens).toBeGreaterThan(4);
    });

    test("包含 tool_result 块", () => {
      const tokens = estimator.estimateMessages([
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_1",
              content: "file content here",
            },
          ],
        },
      ]);
      expect(tokens).toBeGreaterThan(4);
    });

    test("多条消息累加", () => {
      const tokens = estimator.estimateMessages([
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
      ]);
      // 两条消息，每条 4 overhead + text tokens
      expect(tokens).toBeGreaterThan(8);
    });
  });

  // === estimateTools ===
  describe("estimateTools", () => {
    test("空工具列表返回 0", () => {
      expect(estimator.estimateTools([])).toBe(0);
    });

    test("单个工具定义", () => {
      const tokens = estimator.estimateTools([
        {
          name: "read_file",
          description: "Read a file from the filesystem",
          input_schema: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path" },
            },
            required: ["path"],
          },
        },
      ]);
      expect(tokens).toBeGreaterThan(0);
    });

    test("多个工具定义累加", () => {
      const singleTokens = estimator.estimateTools([
        { name: "tool_a", description: "desc a", input_schema: {} },
      ]);
      const doubleTokens = estimator.estimateTools([
        { name: "tool_a", description: "desc a", input_schema: {} },
        { name: "tool_b", description: "desc b", input_schema: {} },
      ]);
      expect(doubleTokens).toBeGreaterThan(singleTokens);
    });
  });

  // === getContextLimit ===
  describe("getContextLimit", () => {
    test("精确匹配已知模型", () => {
      expect(estimator.getContextLimit("claude-sonnet-4-20250514")).toBe(200000);
      expect(estimator.getContextLimit("gpt-4o")).toBe(128000);
      expect(estimator.getContextLimit("gpt-4o-mini")).toBe(128000);
      expect(estimator.getContextLimit("o1")).toBe(200000);
    });

    test("前缀匹配", () => {
      // claude-sonnet-4-xxx 应该匹配 claude-sonnet-4-20250514
      expect(estimator.getContextLimit("claude-sonnet-4-20260101")).toBe(200000);
    });

    test("未知模型返回默认值 128000", () => {
      expect(estimator.getContextLimit("unknown-model")).toBe(128000);
    });
  });

  // === checkContextFit ===
  describe("checkContextFit", () => {
    test("小请求 fits: true", () => {
      const result = estimator.checkContextFit({
        model: "claude-sonnet-4-20250514",
        messages: [
          { role: "user", content: [{ type: "text", text: "Hello" }] },
        ],
        maxTokens: 4096,
      });
      expect(result.fits).toBe(true);
    });

    test("超大请求 fits: false", () => {
      // 构造一个超大消息
      const bigText = "a".repeat(800_000); // 约 200000 tokens
      const result = estimator.checkContextFit({
        model: "claude-sonnet-4-20250514", // 200000 limit
        messages: [
          { role: "user", content: [{ type: "text", text: bigText }] },
        ],
        maxTokens: 4096,
      });
      expect(result.fits).toBe(false);
      if (!result.fits) {
        expect(result.estimated).toBeGreaterThan(result.limit);
      }
    });

    test("包含 system prompt 和 tools 的估算", () => {
      const result = estimator.checkContextFit({
        model: "gpt-4o", // 128000 limit
        messages: [
          { role: "user", content: [{ type: "text", text: "Hello" }] },
        ],
        system: "You are a helpful assistant.",
        tools: [
          { name: "read", description: "Read file", input_schema: { type: "object" } },
        ],
        maxTokens: 4096,
      });
      expect(result.fits).toBe(true);
    });

    test("留 5% 安全余量", () => {
      // 构造刚好在 95% 边界的请求
      // gpt-4o: 128000 limit, 95% = 121600
      const charCount = Math.floor(121600 / 0.25); // ~486400 ASCII chars ≈ 121600 tokens
      const result = estimator.checkContextFit({
        model: "gpt-4o",
        messages: [
          { role: "user", content: [{ type: "text", text: "a".repeat(charCount) }] },
        ],
        maxTokens: 100,
      });
      // 应该 fits: false，因为 estimated ≈ 121604 + 100 > 121600
      expect(result.fits).toBe(false);
    });
  });
});
