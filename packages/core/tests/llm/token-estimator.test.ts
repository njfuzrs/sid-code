/**
 * Token 估算服务测试
 * Task 4：中英文混合文本的 token 估算精度（±20% 以内）
 */

import { describe, test, expect } from "bun:test";
import { TokenEstimator } from "@sid-code/core/llm/token-estimator.ts";

const estimator = new TokenEstimator();

describe("TokenEstimator", () => {
  // === estimateText ===
  describe("estimateText", () => {
    test("空字符串返回 0", () => {
      expect(estimator.estimateText("")).toBe(0);
    });

    test("纯 ASCII 文本：约 0.20 token/char", () => {
      const text = "Hello, this is a test message for token estimation.";
      const tokens = estimator.estimateText(text);
      // 51 chars * 0.20 = 10.2 → ceil = 11
      expect(tokens).toBe(11);
    });

    test("纯中文文本：约 0.65 token/char", () => {
      const text = "这是一个测试消息";
      const tokens = estimator.estimateText(text);
      // 8 chars * 0.65 = 5.2 → ceil = 6（9.4：中文系数 0.65，偏保守防长中文对话低估）
      expect(tokens).toBe(6);
    });

    test("中英文混合文本", () => {
      const text = "Hello 你好 World 世界";
      const tokens = estimator.estimateText(text);
      // ASCII: "Hello  World " = 13 chars * 0.20 = 2.6
      // CJK: "你好世界" = 4 chars * 0.65 = 2.6
      // total = 5.2 → ceil = 6
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(20);
    });

    test("超长文本使用快速近似（按抽样语言占比加权）", () => {
      const text = "a".repeat(200_000);
      const tokens = estimator.estimateText(text);
      // EST-6：全 ASCII → 抽样占比 0 非 ASCII → 0.20/char。200000 * 0.20 = 40000
      expect(tokens).toBe(40000);
    });

    test("超长纯中文文本按非 ASCII 系数估算", () => {
      const text = "中".repeat(200_000);
      const tokens = estimator.estimateText(text);
      // 9.4：全中文 → 0.65/char。200000 * 0.65 = 130000（浮点累加后 ceil 可能 +1）
      expect(tokens).toBeGreaterThanOrEqual(130000);
      expect(tokens).toBeLessThanOrEqual(130001);
    });

    test("刚好在阈值内使用精确计算", () => {
      const text = "a".repeat(100_000);
      const tokens = estimator.estimateText(text);
      // 100000 * 0.20 ≈ 20000，浮点累加微漂移后 ceil → 20001
      expect(tokens).toBe(20001);
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
      // 4 (overhead) + ceil(5 * 0.20) = 4 + 1 = 5
      expect(tokens).toBe(5);
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

    test("EST-3：1M 窗口 deepseek 变体不回退到旧 128K 兜底", () => {
      // 带后缀的 deepseek 变体命名，靠注册表前缀匹配 + 兜底 1M 命中
      expect(estimator.getContextLimit("deepseek-v4-pro-1m")).toBe(1_000_000);
      expect(estimator.getContextLimit("deepseek-v4-flash-20260101")).toBe(1_000_000);
      // 完全未知的 deepseek 变体也按 1M 兜底（兜底值已从 128K 提至 1M）
      expect(estimator.getContextLimit("deepseek-unknown-variant")).toBe(1_000_000);
    });

    test("未知模型返回默认值 1_000_000", () => {
      // 兜底从 128K 提至 1M（2026 年主流模型普遍 1M），详见 docs/bugfixes/done/20260730-未知模型contextWindow兜底失真-根因与修复记录.md
      expect(estimator.getContextLimit("unknown-model")).toBe(1_000_000);
    });

    test("#10：availableModels 声明的 contextWindow 是权威源，覆盖静态表", () => {
      // 用户自建/代理同名模型可声明真实窗口，不被内置静态表锁死
      expect(estimator.getContextLimit("gpt-4o", [{ name: "gpt-4o", contextWindow: 256000 }])).toBe(
        256000,
      );
    });

    test("#10：SID_FALLBACK_CONTEXT_WINDOW 覆盖未知模型兜底窗口", () => {
      const saved = process.env.SID_FALLBACK_CONTEXT_WINDOW;
      try {
        process.env.SID_FALLBACK_CONTEXT_WINDOW = "256000";
        // 未知模型 + 未声明 contextWindow → 走可配置兜底
        expect(estimator.getContextLimit("totally-unknown-model")).toBe(256000);
        // deepseek 变体现在也走兜底 env（deepseek 特判已删，统一走 resolveFallbackWindow）
        expect(estimator.getContextLimit("deepseek-unknown-variant")).toBe(256000);
      } finally {
        if (saved === undefined) delete process.env.SID_FALLBACK_CONTEXT_WINDOW;
        else process.env.SID_FALLBACK_CONTEXT_WINDOW = saved;
      }
    });

    test("#10：SID_FALLBACK_CONTEXT_WINDOW 非法值静默回退默认 1_000_000", () => {
      const saved = process.env.SID_FALLBACK_CONTEXT_WINDOW;
      try {
        for (const bad of ["0", "-1", "abc", ""]) {
          process.env.SID_FALLBACK_CONTEXT_WINDOW = bad;
          expect(estimator.getContextLimit("totally-unknown-model")).toBe(1_000_000);
        }
      } finally {
        if (saved === undefined) delete process.env.SID_FALLBACK_CONTEXT_WINDOW;
        else process.env.SID_FALLBACK_CONTEXT_WINDOW = saved;
      }
    });
  });

  // === checkContextFit ===
  describe("checkContextFit", () => {
    test("小请求 fits: true", () => {
      const result = estimator.checkContextFit({
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
        maxTokens: 4096,
      });
      expect(result.fits).toBe(true);
    });

    test("超大请求 fits: false", () => {
      // 构造一个超大消息（EST-6 后 ASCII 系数 0.20）：1.2M 字符 ≈ 240000 tokens > 200000 limit
      const bigText = "a".repeat(1_200_000);
      const result = estimator.checkContextFit({
        model: "claude-sonnet-4-20250514", // 200000 limit
        messages: [{ role: "user", content: [{ type: "text", text: bigText }] }],
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
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
        system: "You are a helpful assistant.",
        tools: [{ name: "read", description: "Read file", input_schema: { type: "object" } }],
        maxTokens: 4096,
      });
      expect(result.fits).toBe(true);
    });

    test("留 5% 安全余量", () => {
      // 构造刚好在 95% 边界的请求
      // gpt-4o: 128000 limit, 95% = 121600；ASCII 系数 0.20 → 需 121600/0.20 字符
      const charCount = Math.floor(121600 / 0.2); // ~608000 ASCII chars ≈ 121600 tokens
      const result = estimator.checkContextFit({
        model: "gpt-4o",
        messages: [{ role: "user", content: [{ type: "text", text: "a".repeat(charCount) }] }],
        maxTokens: 100,
      });
      // 应该 fits: false，因为 estimated ≈ 121600 + 100 > 121600
      expect(result.fits).toBe(false);
    });
  });
});
