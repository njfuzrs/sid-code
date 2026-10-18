/**
 * E11（20261018）：resume 恢复快照里的跨 provider 模型时，必须重建 provider 并注入 QueryEngine。
 *
 * 原缺陷：restoreSession 只改 config.model + resolveCurrentModelConfig，注释称「让 doInit 采用」，
 * 但 provider / QueryEngine 在 App 构造期就已建好、doInit 不重建——于是 DeepSeek 的模型名被按
 * Anthropic 协议发到 Claude 端点。这里用真实 ProviderRegistry 断言 QueryEngine 拿到的 provider
 * 就是快照模型那一族 / 那个 baseURL 的实例。
 *
 * 经 SID_CONFIG_DIR 重定向到 tmp，不触碰真实 ~/.sid-code；不联网（只构造 provider，不发请求）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { App } from "@sid-code/cli/app.ts";
import { defaultConfig, resolveCurrentModelConfig } from "@sid-code/core/config/config.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import { ProviderRegistry } from "@sid-code/core/llm/registry.ts";

const saved = {
  HOME: process.env.HOME,
  SID_CONFIG_DIR: process.env.SID_CONFIG_DIR,
  SID_CODE_EFFORT_LEVEL: process.env.SID_CODE_EFFORT_LEVEL,
  SID_CODE_THINKING: process.env.SID_CODE_THINKING,
};
let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `sid-resume-provider-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(testDir, ".sid-code"), { recursive: true });
  process.env.HOME = testDir;
  process.env.SID_CONFIG_DIR = join(testDir, ".sid-code");
  delete process.env.SID_CODE_EFFORT_LEVEL;
  delete process.env.SID_CODE_THINKING;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

const CLAUDE_URL = "http://127.0.0.1:9/claude";
const DS_URL = "http://127.0.0.1:9/ds";

function makeApp(): { app: any; registry: ProviderRegistry } {
  const config = {
    ...defaultConfig(),
    model: "claude-opus-5-5",
    availableModels: [
      { name: "claude-opus-5-5", provider: "anthropic", baseURL: CLAUDE_URL, apiKey: "k-claude" },
      { name: "deepseek-v4-pro", provider: "openai", baseURL: DS_URL, apiKey: "k-ds" },
    ],
    permissionMode: "default",
  } as unknown as Config;
  resolveCurrentModelConfig(config);
  const registry = new ProviderRegistry(config);
  const provider = registry.getProvider();
  const app = new App({
    config,
    provider,
    providerRegistry: registry,
    mcpManager: {} as any,
  } as any) as any;
  return { app, registry };
}

function sessionWith(setting: Record<string, unknown>): any {
  const now = new Date().toISOString();
  return {
    version: "1",
    id: "20261018-000000-e11test",
    model: "claude-opus-5-5",
    provider: "anthropic",
    messages: [],
    createdAt: now,
    updatedAt: now,
    metadata: { agent_setting: setting },
  };
}

describe("E11：resume 恢复跨 provider 模型时重建 provider", () => {
  test("快照模型属于另一 provider/baseURL → QueryEngine 拿到新端点的 provider", async () => {
    const { app, registry } = makeApp();
    const before = app.queryEngine.deps.provider;
    expect(app.config.baseURL).toBe(CLAUDE_URL);

    await app.restoreSession(sessionWith({ model: "deepseek-v4-pro", effortLevel: "low" }));

    expect(app.config.model).toBe("deepseek-v4-pro");
    expect(app.config.provider).toBe("openai");
    expect(app.config.baseURL).toBe(DS_URL);
    // 关键断言：QueryEngine 实际持有的 provider 已换成 DeepSeek 那一个（registry 按 provider:baseURL 缓存）
    const expected = registry.getProviderFor("openai", "k-ds", DS_URL);
    expect(app.queryEngine.deps.provider).toBe(expected);
    expect(app.queryEngine.deps.provider).not.toBe(before);
    expect(app.provider).toBe(expected);
  });

  test("快照模型与启动模型相同 → 不动 provider", async () => {
    const { app } = makeApp();
    const before = app.queryEngine.deps.provider;
    await app.restoreSession(sessionWith({ model: "claude-opus-5-5" }));
    expect(app.queryEngine.deps.provider).toBe(before);
  });
});
