/**
 * fork 拿不到继承时的静默降级（06H1 T1 / T2）
 *
 * 背景：fork 有两条路会"看起来成功、实际没继承"：
 * 1. `fork + run_in_background` —— runAsync 参数里没有 fork，executeInBackground 也不传
 *    forkMessages；spawn 的 ParentInitMessage 也只有 user_prompt。此前组合被静默丢掉。
 * 2. `mainContextProvider` 未注入 —— 此前静默退化成「空白上下文起步」，调用方看不出。
 *
 * 修复口径：两条都改成**明确报错**，并让 forkMessages 存在时强制进程内执行
 * （与 task.cwd 存在时同一写法）。这里锁住：
 * - 显式 run_in_background 与定义 background: true 两种后台组合都报错
 * - 未注入 provider 时同步 fork 报错；注入后照常继承
 * - shouldUseSpawn() 为真时，forkMessages 非空仍走进程内，首条上下文来自 fork
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SubAgentTool } from "@sid-code/core/agent/tool.ts";
import { SubAgent } from "@sid-code/core/agent/sub-agent.ts";
import { ProviderRegistry } from "@sid-code/core/llm/registry.ts";
import { Registry } from "@sid-code/core/tool/registry.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import {
  clearDynamicAgents,
  registerDynamicAgents,
} from "@sid-code/core/agent/agent-definition.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";

/** 记录每次请求的 messages，并回一句话收尾。 */
class RecordingProvider implements Provider {
  requests: SendParams[] = [];
  name() {
    return "recording";
  }
  defaultModel() {
    return "m";
  }
  async *sendMessageStream(params: SendParams): AsyncIterable<StreamEvent> {
    this.requests.push(params);
    yield {
      type: "message_start",
      message: { id: "m1", role: "assistant", usage: { inputTokens: 1, outputTokens: 0 } },
    } as StreamEvent;
    yield {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    } as StreamEvent;
    yield {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "## 结论\n完成" },
    } as StreamEvent;
    yield { type: "content_block_stop", index: 0 } as StreamEvent;
    yield {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { outputTokens: 1 },
    } as StreamEvent;
  }
}

const PARENT_TEXT = "父对话里已经确认过的背景 A-42";

let base: string;
const savedConfigDir = process.env.SID_CONFIG_DIR;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "sid-fork-guard-"));
  // 子代理会写 sidechain / session registry，全部重定向到 tmpdir（不碰真实 ~/.sid-code）
  process.env.SID_CONFIG_DIR = join(base, "home");
});

afterEach(() => {
  clearDynamicAgents();
  if (savedConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = savedConfigDir;
  rmSync(base, { recursive: true, force: true });
});

function makeTool(providerRegistry?: ProviderRegistry): SubAgentTool {
  const config = defaultConfig() as Config;
  return new SubAgentTool(providerRegistry ?? new ProviderRegistry(config, {}), new Registry());
}

/**
 * 把 registry 的 provider 解析全部指向桩。
 * 只覆盖 getProvider 不够：构造走 `fromRegistry → getProvider()`，执行期还会走
 * `getProviderForModelName()` 按实际 model 重新解析（sub-agent.ts 的 executeInner）。
 * defaultConfig() 的 provider 为空，漏掉任一条都会在测试里报「未知的 Provider: 」。
 */
function stubProviders(registry: ProviderRegistry, provider: Provider): void {
  const stub = registry as unknown as Record<string, () => Provider>;
  stub.getProvider = () => provider;
  stub.getProviderFor = () => provider;
  stub.getProviderForSubAgent = () => provider;
  stub.getProviderForModelName = () => provider;
}

describe("T1：fork 与后台组合直接报错（不再静默丢掉 fork）", () => {
  test("显式 run_in_background + fork → isError", async () => {
    const tool = makeTool();
    // provider 已注入，确保报错来自「fork 只能同步」而不是 T2 那条
    tool.setMainContextProvider(() => [
      { role: "user", content: [{ type: "text", text: PARENT_TEXT }] },
    ]);
    const r = await tool.execute({
      type: "explore",
      description: "后台跑",
      prompt: "继续",
      fork: true,
      run_in_background: true,
    });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("fork 只支持同步");
  });

  test("定义声明 background: true 时（不显式传参）同样报错", async () => {
    // 判据必须放在 def.background 合并之后：否则这条会漏
    registerDynamicAgents(
      [
        {
          agentType: "bg-agent",
          description: "默认后台的 agent",
          whenToUse: "后台任务",
          systemPrompt: "你是后台代理",
          background: true,
        } as never,
      ],
      true,
    );
    const tool = makeTool();
    tool.setMainContextProvider(() => [
      { role: "user", content: [{ type: "text", text: PARENT_TEXT }] },
    ]);
    const r = await tool.execute({
      type: "bg-agent",
      description: "后台跑",
      prompt: "继续",
      fork: true,
    });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("fork 只支持同步");
  });
});

describe("T2：未注入主对话上下文时报错（不再退化成空白起步）", () => {
  test("未注入 provider + 同步 fork → isError", async () => {
    const tool = makeTool(); // 故意不调 setMainContextProvider
    const r = await tool.execute({
      type: "explore",
      description: "核验",
      prompt: "继续",
      fork: true,
    });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("setMainContextProvider");
  });

  test("注入 provider 后 fork 照常，父对话内容真的进了子代理上下文", async () => {
    const provider = new RecordingProvider();
    const registry = new ProviderRegistry(defaultConfig() as Config, {});
    // 只替换 provider 解析，避免真发网络请求；model 解析仍走真实实现
    stubProviders(registry, provider);
    const tool = makeTool(registry);
    tool.setMainContextProvider(() => [
      { role: "user", content: [{ type: "text", text: PARENT_TEXT }] },
    ]);
    const r = await tool.execute({
      type: "explore",
      description: "核验",
      prompt: "接着刚才的结论继续",
      fork: true,
    });
    expect(r.isError).toBeFalsy();
    expect(provider.requests.length).toBeGreaterThan(0);
    expect(JSON.stringify(provider.requests)).toContain(PARENT_TEXT);
  });
});

describe("T1：forkMessages 存在时强制进程内（spawn 协议传不了它）", () => {
  test("shouldUseSpawn() 为真时 fork 仍走进程内，且首条上下文来自 fork", async () => {
    const provider = new RecordingProvider();
    const sub = new SubAgent(provider, "m", new Registry());
    let spawnCalled = false;
    (sub as unknown as { shouldUseSpawn: () => boolean }).shouldUseSpawn = () => true;
    (sub as unknown as { executeSpawned: () => Promise<never> }).executeSpawned = async () => {
      spawnCalled = true;
      throw new Error("不该走 spawn");
    };

    const r = await sub.execute({
      type: "explore",
      description: "核验",
      prompt: "接着聊",
      forkMessages: [{ role: "user", content: [{ type: "text", text: PARENT_TEXT }] }],
    });

    expect(spawnCalled).toBe(false);
    expect(r.success).toBe(true);
    expect(JSON.stringify(provider.requests)).toContain(PARENT_TEXT);
  });

  test("对照：没有 forkMessages 时 spawn 照常被选中（强制进程内只在 fork 时生效）", async () => {
    const provider = new RecordingProvider();
    const sub = new SubAgent(provider, "m", new Registry());
    let spawnCalled = false;
    (sub as unknown as { shouldUseSpawn: () => boolean }).shouldUseSpawn = () => true;
    (sub as unknown as { executeSpawned: () => Promise<unknown> }).executeSpawned = async () => {
      spawnCalled = true;
      return {
        success: true,
        output: "spawn 结果",
        usage: { inputTokens: 0, outputTokens: 0 },
        turns: 1,
        toolUseCount: 0,
      };
    };

    const r = await sub.execute({ type: "explore", description: "核验", prompt: "看看" });
    expect(spawnCalled).toBe(true);
    expect(r.success).toBe(true);
  });
});
