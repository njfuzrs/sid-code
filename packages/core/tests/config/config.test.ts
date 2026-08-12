/**
 * 配置加载测试
 */

import { describe, test, expect } from "bun:test";
import {
  defaultConfig,
  loadConfig,
  isMissingApiKey,
  PLACEHOLDER_API_KEY,
} from "@sid-code/core/config/config.ts";

describe("config", () => {
  test("defaultConfig 返回合理的默认值（不绑定特定 Provider/模型）", () => {
    const cfg = defaultConfig();
    expect(cfg.provider).toBe("");
    expect(cfg.model).toBe("");
    expect(cfg.maxTokens).toBe(32768);
    expect(cfg.print).toBe(false);
    expect(cfg.yesMode).toBe(false);
    expect(cfg.hooks).toEqual({});
    expect(cfg.mcpServers).toEqual({});
  });

  test("loadConfig 使用 CLI 参数覆盖默认值", async () => {
    const cfg = await loadConfig({
      provider: "openai",
      model: "gpt-4o",
      maxTokens: 4096,
    });
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-4o");
    expect(cfg.maxTokens).toBe(4096);
  });

  // 回归（code review 自查）：显式 maxTokens 必须在 loadConfig 全流程存活，不被
  // 「按模型推导」分支静默覆盖。曾因 _explicitMaxTokens 登记晚于首次
  // resolveCurrentModelConfig，导致显式值被模型上限覆盖。
  test("loadConfig 显式 maxTokens 低于模型上限时不被模型推导覆盖", async () => {
    const cfg = await loadConfig({
      provider: "openai",
      model: "deepseek-v4-pro", // 注册表上限 384000，远高于显式值
      maxTokens: 8192,
    });
    expect(cfg.maxTokens).toBe(8192);
  });

  // 回归：显式 maxTokens 超过模型物理上限时必须钳制（否则网关 400）。
  test("loadConfig 显式 maxTokens 超模型上限时钳制到上限", async () => {
    const cfg = await loadConfig({
      provider: "openai",
      model: "glm-5.2", // 注册表上限 128000
      maxTokens: 999999,
    });
    expect(cfg.maxTokens).toBe(128000);
  });

  test("loadConfig CLI 参数优先级最高", async () => {
    const cfg = await loadConfig({ provider: "ollama", model: "llama3" });
    // CLI 参数应覆盖环境变量和默认值
    expect(cfg.provider).toBe("ollama");
    expect(cfg.model).toBe("llama3");
  });

  // 回归：normalizeConfigKeys 归一化 availableModels 时必须保留用户手写 pricing。
  // 曾漏拷该字段，导致「用户手写价最高优先」被架空（settings.json 里配的价被静默丢弃）。
  test("loadConfig 保留 availableModels 的用户手写 pricing（snake_case 路径）", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "sid-cfg-"));
    const prevHome = process.env.SID_CONFIG_DIR;
    try {
      writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({
          model: "my-model",
          availableModels: [
            {
              name: "my-model",
              provider: "openai",
              base_url: "https://gw.example.com/v1",
              api_key: "sk-x",
              pricing: { input: 1.64, output: 3.29, cacheRead: 0.13 },
            },
          ],
        }),
      );
      process.env.SID_CONFIG_DIR = dir;
      const cfg = await loadConfig({});
      const m = cfg.availableModels.find((x) => x.name === "my-model");
      expect(m?.pricing).toBeDefined();
      expect(m!.pricing!.input).toBe(1.64);
      expect(m!.pricing!.output).toBe(3.29);
      expect(m!.pricing!.cacheRead).toBe(0.13);
    } finally {
      if (prevHome === undefined) delete process.env.SID_CONFIG_DIR;
      else process.env.SID_CONFIG_DIR = prevHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // §3.6（fdb47f30）：loadConfig 收尾必须保证 sessionId 非空（单一事实源），
  // 否则 registerSession 写入 active-sessions 的 sessionId 为空字符串（/ps 看不到 id）。
  test("loadConfig 未指定时自动生成非空 sessionId", async () => {
    const cfg = await loadConfig({ provider: "ollama", model: "llama3" });
    expect(cfg.sessionId).toBeTruthy();
    expect(cfg.sessionId.length).toBeGreaterThan(0);
  });

  test("loadConfig 显式传入 sessionId 时保留不覆盖", async () => {
    const cfg = await loadConfig({ provider: "ollama", model: "llama3", sessionId: "myfixed1" });
    expect(cfg.sessionId).toBe("myfixed1");
  });

  // E.11：SID_CODE_TEAM_MEMORY 环境变量覆盖团队记忆配置（文档 §5 承诺的便捷入口）
  describe("SID_CODE_TEAM_MEMORY env 覆盖", () => {
    const ENV_KEY = "SID_CODE_TEAM_MEMORY";
    const orig = process.env[ENV_KEY];
    const restore = () => {
      if (orig === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = orig;
    };

    test("合法 JSON 对象被解析进 config.teamMemory", async () => {
      process.env[ENV_KEY] = JSON.stringify({
        enabled: true,
        dir: "/nas/team-memory",
        debounceMs: 1500,
      });
      try {
        const cfg = await loadConfig({ provider: "ollama", model: "llama3" });
        expect(cfg.teamMemory).toEqual({
          enabled: true,
          dir: "/nas/team-memory",
          debounceMs: 1500,
        });
      } finally {
        restore();
      }
    });

    test("非法 JSON 静默忽略，不污染 config", async () => {
      process.env[ENV_KEY] = "not-json{";
      try {
        const cfg = await loadConfig({ provider: "ollama", model: "llama3" });
        expect(cfg.teamMemory).toBeUndefined();
      } finally {
        restore();
      }
    });

    test("数组等非对象 JSON 被拒绝", async () => {
      process.env[ENV_KEY] = JSON.stringify(["enabled", true]);
      try {
        const cfg = await loadConfig({ provider: "ollama", model: "llama3" });
        expect(cfg.teamMemory).toBeUndefined();
      } finally {
        restore();
      }
    });

    test("只收形状正确的字段，丢弃错误类型", async () => {
      process.env[ENV_KEY] = JSON.stringify({ enabled: "yes", dir: 123, debounceMs: 2000 });
      try {
        const cfg = await loadConfig({ provider: "ollama", model: "llama3" });
        // enabled/dir 类型错被丢，仅 debounceMs 合法
        expect(cfg.teamMemory).toEqual({ debounceMs: 2000 });
      } finally {
        restore();
      }
    });
  });

  describe("isMissingApiKey — 占位符/空值识别", () => {
    test("空 / undefined / 纯空白 → 视为缺失", () => {
      expect(isMissingApiKey(undefined)).toBe(true);
      expect(isMissingApiKey(null)).toBe(true);
      expect(isMissingApiKey("")).toBe(true);
      expect(isMissingApiKey("   ")).toBe(true);
    });

    test("团队模板占位符 __YOUR_API_KEY__（含首尾空白）→ 视为缺失", () => {
      expect(isMissingApiKey(PLACEHOLDER_API_KEY)).toBe(true);
      expect(isMissingApiKey("  __YOUR_API_KEY__  ")).toBe(true);
    });

    test("真实 key → 不缺失", () => {
      expect(isMissingApiKey("sk-abc123")).toBe(false);
      expect(isMissingApiKey("anthropic-xyz")).toBe(false);
    });
  });
});
