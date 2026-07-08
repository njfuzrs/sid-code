import { describe, test, expect } from "bun:test";
import { validateConfig } from "../../src/config/schema.ts";
import type { Config } from "../../src/config/config.ts";

describe("Config Validation", () => {
  const baseConfig: Config = {
    provider: "anthropic",
    model: "claude-sonnet-4",
    fallbackModel: "",
    anthropicKey: "sk-ant-test123456789012345678901234567890",
    openaiKey: "",
    baseURL: "",
    maxTokens: 16384,
    availableModels: [],
    permissionMode: "default",
    skipPermissions: false,
    allowedTools: [],
    disallowedTools: [],
    yesMode: false,
    allowedDirectories: [],
    blockedDirectories: [],
    sessionId: "",
    continue: false,
    resume: "",
    print: false,
    outputFormat: "text",
    maxTurns: 0,
    systemPrompt: "",
    appendSystemPrompt: "",
    systemPromptFile: "",
    debug: false,
    debugLevel: "INFO",
    debugLogFile: "",
    hooks: {},
    mcpServers: {},
    alternateBuffer: true,
    showLineNumbers: true,
  };

  test("valid config passes validation", () => {
    const result = validateConfig(baseConfig);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("invalid provider fails validation", () => {
    const config = { ...baseConfig, provider: "invalid" };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === "provider")).toBe(true);
  });

  test("maxTokens below minimum fails validation", () => {
    const config = { ...baseConfig, maxTokens: 500 };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === "maxTokens")).toBe(true);
  });

  test("invalid permission mode fails validation", () => {
    const config = { ...baseConfig, permissionMode: "invalid-mode" };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === "permissionMode")).toBe(true);
  });

  test("empty model name fails validation", () => {
    const config = { ...baseConfig, model: "" };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === "model")).toBe(true);
  });

  test("placeholder API key generates warning", () => {
    const config = { ...baseConfig, anthropicKey: "your-api-key-here" };
    const result = validateConfig(config);
    expect(result.warnings.some(w => w.path === "anthropicKey")).toBe(true);
  });

  test("invalid MCP server config fails validation", () => {
    const config = {
      ...baseConfig,
      mcpServers: {
        test: {
          transport: "stdio" as const,
          // missing command
        },
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path.includes("mcpServers"))).toBe(true);
  });

  describe("模型引用类字段（fallbackModel / classifierModel / goal.evaluatorModel）", () => {
    const withModels = {
      ...baseConfig,
      availableModels: [{ name: "claude-sonnet-4", provider: "anthropic" }],
    };

    test("fallbackModel 引用不存在的模型生成警告", () => {
      const config = { ...withModels, fallbackModel: "ghost-model" };
      const result = validateConfig(config);
      expect(result.warnings.some(w => w.path === "fallbackModel")).toBe(true);
    });

    test("classifierModel 引用不存在的模型生成警告（无论 enableLLMClassifier 是否开启）", () => {
      const config = { ...withModels, classifierModel: "ghost-model", enableLLMClassifier: false };
      const result = validateConfig(config);
      expect(result.warnings.some(w => w.path === "classifierModel")).toBe(true);
    });

    test("goal.evaluatorModel 引用不存在的模型生成警告", () => {
      const config = { ...withModels, goal: { evaluatorModel: "ghost-model" } };
      const result = validateConfig(config);
      expect(result.warnings.some(w => w.path === "goal.evaluatorModel")).toBe(true);
    });

    test("模型引用字段指向存在的模型不生成警告", () => {
      const config = {
        ...withModels,
        fallbackModel: "claude-sonnet-4",
        classifierModel: "claude-sonnet-4",
        goal: { evaluatorModel: "claude-sonnet-4" },
      };
      const result = validateConfig(config);
      expect(result.warnings.some(w => ["fallbackModel", "classifierModel", "goal.evaluatorModel"].includes(w.path))).toBe(false);
    });
  });

  describe("availableModels 重名检查", () => {
    test("重复的模型名生成警告", () => {
      const config = {
        ...baseConfig,
        availableModels: [
          { name: "dup-model", provider: "openai" },
          { name: "dup-model", provider: "anthropic" },
        ],
      };
      const result = validateConfig(config);
      expect(result.warnings.some(w => w.path === "availableModels")).toBe(true);
    });

    test("不重复的模型名不生成警告", () => {
      const config = {
        ...baseConfig,
        availableModels: [
          { name: "model-a", provider: "openai" },
          { name: "model-b", provider: "anthropic" },
        ],
      };
      const result = validateConfig(config);
      expect(result.warnings.some(w => w.path === "availableModels")).toBe(false);
    });
  });

  describe("quota.budgetRules", () => {
    test("非法 period/action/limit_usd 生成警告", () => {
      const config = {
        ...baseConfig,
        quota: {
          budgetRules: [
            { id: "r1", name: "rule1", period: "yearly" as any, limit_usd: -5, action: "explode" as any },
          ],
        },
      };
      const result = validateConfig(config);
      expect(result.warnings.some(w => w.path === "quota.budgetRules[0].period")).toBe(true);
      expect(result.warnings.some(w => w.path === "quota.budgetRules[0].limit_usd")).toBe(true);
      expect(result.warnings.some(w => w.path === "quota.budgetRules[0].action")).toBe(true);
    });

    test("重复的 rule id 生成警告", () => {
      const config = {
        ...baseConfig,
        quota: {
          budgetRules: [
            { id: "dup", name: "rule1", period: "daily" as const, limit_usd: 10 },
            { id: "dup", name: "rule2", period: "daily" as const, limit_usd: 10 },
          ],
        },
      };
      const result = validateConfig(config);
      expect(result.warnings.some(w => w.path === "quota.budgetRules[1].id")).toBe(true);
    });

    test("scope.model 引用不存在的模型生成警告", () => {
      const config = {
        ...baseConfig,
        availableModels: [{ name: "real-model", provider: "openai" }],
        quota: {
          budgetRules: [
            { id: "r1", name: "rule1", period: "daily" as const, limit_usd: 10, scope: { model: "ghost-model" } },
          ],
        },
      };
      const result = validateConfig(config);
      expect(result.warnings.some(w => w.path === "quota.budgetRules[0].scope.model")).toBe(true);
    });

    test("thresholds 顺序颠倒生成警告", () => {
      const config = {
        ...baseConfig,
        quota: {
          budgetRules: [
            {
              id: "r1", name: "rule1", period: "daily" as const, limit_usd: 10,
              thresholds: { warning: 0.9, critical: 0.5 },
            },
          ],
        },
      };
      const result = validateConfig(config);
      expect(result.warnings.some(w => w.path === "quota.budgetRules[0].thresholds")).toBe(true);
    });

    test("合法的 budgetRules 配置不生成警告", () => {
      const config = {
        ...baseConfig,
        availableModels: [{ name: "real-model", provider: "openai" }],
        quota: {
          budgetRules: [
            {
              id: "r1", name: "rule1", period: "daily" as const, limit_usd: 10,
              scope: { model: "real-model" },
              thresholds: { warning: 0.5, critical: 0.8, exceeded: 1.0 },
              action: "alert" as const,
            },
          ],
        },
      };
      const result = validateConfig(config);
      expect(result.warnings.some(w => w.path.startsWith("quota.budgetRules"))).toBe(false);
    });
  });

  describe("search 配置", () => {
    test("无效的 backend 值生成警告", () => {
      const config = { ...baseConfig, search: { backend: "bing" } };
      const result = validateConfig(config);
      expect(result.warnings.some(w => w.path === "search.backend")).toBe(true);
    });

    test("backend 为尚未实现的 brave/tavily 生成警告", () => {
      const config = { ...baseConfig, search: { backend: "brave" } };
      const result = validateConfig(config);
      expect(result.warnings.some(w => w.path === "search.backend")).toBe(true);
    });

    test("backend 为 searxng 但缺 searxngUrl 生成警告", () => {
      const originalEnv = process.env.SEARXNG_URL;
      delete process.env.SEARXNG_URL;
      try {
        const config = { ...baseConfig, search: { backend: "searxng" } };
        const result = validateConfig(config);
        expect(result.warnings.some(w => w.path === "search.searxngUrl")).toBe(true);
      } finally {
        if (originalEnv !== undefined) process.env.SEARXNG_URL = originalEnv;
      }
    });

    test("backend 为 searxng 且配置了 searxngUrl 不生成警告", () => {
      const config = { ...baseConfig, search: { backend: "searxng", searxngUrl: "http://localhost:8080" } };
      const result = validateConfig(config);
      expect(result.warnings.some(w => w.path.startsWith("search."))).toBe(false);
    });
  });

  describe("telemetry / analytics", () => {
    test("telemetry.exporters 无效类型生成警告", () => {
      const config = {
        ...baseConfig,
        telemetry: { enabled: true, exporters: [{ type: "datadog" as any }] },
      };
      const result = validateConfig(config);
      expect(result.warnings.some(w => w.path === "telemetry.exporters[0].type")).toBe(true);
    });

    test("analytics.backends 缺 endpoint 生成警告", () => {
      const config = {
        ...baseConfig,
        analytics: { backends: [{ name: "b1", type: "http" as const, endpoint: "" }] },
      };
      const result = validateConfig(config);
      expect(result.warnings.some(w => w.path === "analytics.backends[0].endpoint")).toBe(true);
    });
  });

  describe("sessionRetention", () => {
    test("maxAge 格式无效生成警告", () => {
      const config = { ...baseConfig, sessionRetention: { maxAge: "30days" } };
      const result = validateConfig(config);
      expect(result.warnings.some(w => w.path === "sessionRetention.maxAge")).toBe(true);
    });

    test("maxAge 格式合法不生成警告", () => {
      const config = { ...baseConfig, sessionRetention: { maxAge: "30d", minRetention: "1d", maxCount: 50 } };
      const result = validateConfig(config);
      expect(result.warnings.some(w => w.path.startsWith("sessionRetention"))).toBe(false);
    });
  });
});
