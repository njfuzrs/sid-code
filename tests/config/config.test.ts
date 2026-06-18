/**
 * 配置加载测试
 */

import { describe, test, expect } from "bun:test";
import { defaultConfig, loadConfig } from "../../src/config/config.ts";

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

  test("loadConfig CLI 参数优先级最高", async () => {
    const cfg = await loadConfig({ provider: "ollama", model: "llama3" });
    // CLI 参数应覆盖环境变量和默认值
    expect(cfg.provider).toBe("ollama");
    expect(cfg.model).toBe("llama3");
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
});
