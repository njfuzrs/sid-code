/**
 * 配置加载测试
 */

import { describe, test, expect } from "bun:test";
import { defaultConfig, loadConfig } from "../../src/config/config.ts";

describe("config", () => {
  test("defaultConfig 返回合理的默认值", () => {
    const cfg = defaultConfig();
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-sonnet-4-20250514");
    expect(cfg.maxTokens).toBe(8192);
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

  test("loadConfig CLI 参数优先级最高", async () => {
    const cfg = await loadConfig({ provider: "ollama", model: "llama3" });
    // CLI 参数应覆盖环境变量和默认值
    expect(cfg.provider).toBe("ollama");
    expect(cfg.model).toBe("llama3");
  });
});
