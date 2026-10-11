/**
 * 子代理的「连接」必须跟着**最终生效的模型**走，不能按子代理类型查。
 *
 * 回归背景（2026-10-11 事故）：task.model 显式指定 deepseek-v4-pro（openai 族、api.deepseek.com）时，
 * executeInner 仍用 getProviderForSubAgent(task.type) 取 provider——那是 explore 类型默认模型
 * （anthropic 族、另一网关）的连接。于是模型名配上错的协议 + 端点，零轮失败；
 * warn.log 里只看到 `[LLM:ANTHROPIC] 请求异常`，看起来像"模型不可用/欠费"。
 * 同型错配还在 spawn 路径（完全忽略 task.model）与 custom 两条路径（modelOverride 配 "task" 类型连接）。
 */

import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { Registry } from "@sid-code/core/tool/registry.ts";
import { SubAgent } from "@sid-code/core/agent/sub-agent.ts";
import { ProviderRegistry } from "@sid-code/core/llm/registry.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";

/** 记录收到的 model 的最小 provider：直接回一段文本 end_turn */
class RecordingProvider implements Provider {
  calls: string[] = [];
  constructor(private _name: string) {}
  name() {
    return this._name;
  }
  defaultModel() {
    return `${this._name}-default`;
  }
  async *sendMessageStream(params: SendParams): AsyncIterable<StreamEvent> {
    this.calls.push(params.model ?? "<none>");
    yield {
      type: "message_start",
      message: { usage: { inputTokens: 1, outputTokens: 0 } },
    } as StreamEvent;
    yield {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    } as StreamEvent;
    yield {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "## 发现\nok" },
    } as StreamEvent;
    yield { type: "content_block_stop", index: 0 } as StreamEvent;
    yield {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { outputTokens: 2 },
    } as StreamEvent;
  }
}

/**
 * 按模型名返回各自 provider 的 registry 桩。
 * getProviderForSubAgent 故意返回「类型默认模型」的 provider——旧实现走的就是它，
 * 若被调用并用于发送，断言会抓到。
 */
function routingRegistry(opts: {
  mainModel: string;
  typeDefaultModel: string;
  providers: Record<string, RecordingProvider>;
}) {
  const { mainModel, typeDefaultModel, providers } = opts;
  return {
    getProvider: () => providers[mainModel]!,
    getProviderFor: () => providers[mainModel]!,
    getCurrentModel: () => mainModel,
    getModelForSubAgent: () => typeDefaultModel,
    getProviderForSubAgent: () => providers[typeDefaultModel]!,
    getProviderForModelName: (m: string) => providers[m]!,
    getLanguage: () => "zh" as const,
    getKnownModelNames: () => Object.keys(providers),
    getContextWindow: () => 200_000,
    clearCache: () => {},
  } as unknown as ProviderRegistry;
}

let prevNoSpawn: string | undefined;
beforeEach(() => {
  prevNoSpawn = process.env.SIDCODE_NO_SPAWN;
  process.env.SIDCODE_NO_SPAWN = "1"; // 强制进程内路径
});
afterEach(() => {
  if (prevNoSpawn === undefined) delete process.env.SIDCODE_NO_SPAWN;
  else process.env.SIDCODE_NO_SPAWN = prevNoSpawn;
});

describe("进程内 executeInner：provider 按最终模型解析", () => {
  test("task.model 覆盖 → 请求发给该模型自己的 provider，而不是类型默认模型的", async () => {
    const providers = {
      "main-model": new RecordingProvider("openai-main"),
      "haiku-like": new RecordingProvider("anthropic-gw"),
      "deepseek-v4-pro": new RecordingProvider("openai-deepseek"),
    };
    const reg = routingRegistry({
      mainModel: "main-model",
      typeDefaultModel: "haiku-like",
      providers,
    });
    const agent = SubAgent.fromRegistry(reg, new Registry());

    const res = await agent.execute({
      type: "explore",
      description: "routing",
      prompt: "x",
      model: "deepseek-v4-pro",
    });

    expect(res.success).toBe(true);
    expect(providers["deepseek-v4-pro"].calls).toEqual(["deepseek-v4-pro"]);
    // 事故里正是这里收到了 deepseek-v4-pro
    expect(providers["haiku-like"].calls).toEqual([]);
  });

  test("无 task.model → 用类型默认模型，且发给它自己的 provider", async () => {
    const providers = {
      "main-model": new RecordingProvider("openai-main"),
      "explore-model": new RecordingProvider("openai-explore"),
    };
    const reg = routingRegistry({
      mainModel: "main-model",
      typeDefaultModel: "explore-model",
      providers,
    });
    const agent = SubAgent.fromRegistry(reg, new Registry());

    await agent.execute({ type: "explore", description: "routing", prompt: "x" });

    expect(providers["explore-model"].calls).toEqual(["explore-model"]);
    expect(providers["main-model"].calls).toEqual([]);
  });
});

describe("进程内 executeCustomInner：modelOverride 用自己的 provider", () => {
  test('modelOverride → 发给该模型的 provider（旧实现取 "task" 类型的）', async () => {
    const providers = {
      "main-model": new RecordingProvider("openai-main"),
      "task-model": new RecordingProvider("anthropic-task"),
      "override-model": new RecordingProvider("openai-override"),
    };
    const reg = routingRegistry({
      mainModel: "main-model",
      typeDefaultModel: "task-model",
      providers,
    });
    const agent = SubAgent.fromRegistry(reg, new Registry(), undefined, "override-model");

    const res = await agent.executeCustom({ systemPrompt: "s", userPrompt: "u", allowedTools: [] });

    expect(res.success).toBe(true);
    expect(providers["override-model"].calls).toEqual(["override-model"]);
    expect(providers["task-model"].calls).toEqual([]);
  });

  test("无 modelOverride → 主模型 + 主模型 provider", async () => {
    const providers = {
      "main-model": new RecordingProvider("openai-main"),
      "task-model": new RecordingProvider("anthropic-task"),
    };
    const reg = routingRegistry({
      mainModel: "main-model",
      typeDefaultModel: "task-model",
      providers,
    });
    const agent = SubAgent.fromRegistry(reg, new Registry());

    await agent.executeCustom({ systemPrompt: "s", userPrompt: "u", allowedTools: [] });

    expect(providers["main-model"].calls).toEqual(["main-model"]);
  });
});

/** 真 registry 的配置：主模型 openai 网关；另有 anthropic 网关模型与 deepseek 直连模型 */
function multiProviderConfig(): Config {
  return {
    ...defaultConfig(),
    provider: "openai",
    model: "main-model",
    openaiKey: "sk-main",
    baseURL: "https://gw-main/v1",
    availableModels: [
      { name: "main-model", provider: "openai", baseURL: "https://gw-main/v1" },
      {
        name: "haiku-like",
        provider: "anthropic",
        baseURL: "https://gw-anthropic",
        apiKey: "sk-ant",
      },
      {
        name: "deepseek-v4-pro",
        provider: "openai",
        baseURL: "https://api.deepseek.com",
        apiKey: "sk-ds",
      },
    ],
  };
}

describe("spawn 路径：init 消息里的连接跟着 task.model", () => {
  /** 截获 executeSpawnedInternal 的 init 消息，不真起子进程 */
  function captureSpawnInit(agent: SubAgent) {
    const captured: Record<string, unknown>[] = [];
    const a = agent as unknown as Record<string, unknown>;
    a.shouldUseSpawn = () => true;
    a.executeSpawnedInternal = async (initMsg: Record<string, unknown>) => {
      captured.push(initMsg);
      return {
        success: true,
        output: "ok",
        usage: { inputTokens: 0, outputTokens: 0 },
        turns: 1,
        toolUseCount: 0,
      };
    };
    return captured;
  }

  test("executeSpawned：task.model 覆盖 → model/provider/baseURL/apiKey 全属于该模型", async () => {
    const reg = new ProviderRegistry(multiProviderConfig(), { explore: "haiku-like" });
    const agent = SubAgent.fromRegistry(reg, new Registry());
    const captured = captureSpawnInit(agent);

    await agent.execute({
      type: "explore",
      description: "d",
      prompt: "p",
      model: "deepseek-v4-pro",
    });

    expect(captured).toHaveLength(1);
    const init = captured[0]!;
    expect(init.model).toBe("deepseek-v4-pro");
    expect(init.provider_name).toBe("openai");
    expect(init.base_url).toBe("https://api.deepseek.com");
    expect(init.api_key).toBe("sk-ds");
  });

  test("executeSpawned：无 task.model → 类型默认模型及其连接", async () => {
    const reg = new ProviderRegistry(multiProviderConfig(), { explore: "haiku-like" });
    const agent = SubAgent.fromRegistry(reg, new Registry());
    const captured = captureSpawnInit(agent);

    await agent.execute({ type: "explore", description: "d", prompt: "p" });

    const init = captured[0]!;
    expect(init.model).toBe("haiku-like");
    expect(init.provider_name).toBe("anthropic");
    expect(init.base_url).toBe("https://gw-anthropic");
  });

  test('executeSpawnedCustom：modelOverride → 连接属于 override 模型而非 "task" 类型模型', async () => {
    const reg = new ProviderRegistry(multiProviderConfig(), { task: "haiku-like" });
    const agent = SubAgent.fromRegistry(reg, new Registry(), undefined, "deepseek-v4-pro");
    const captured = captureSpawnInit(agent);

    await agent.executeCustom({ systemPrompt: "s", userPrompt: "u", allowedTools: [] });

    const init = captured[0]!;
    expect(init.model).toBe("deepseek-v4-pro");
    expect(init.provider_name).toBe("openai");
    expect(init.base_url).toBe("https://api.deepseek.com");
    expect(init.api_key).toBe("sk-ds");
  });
});

describe("ProviderRegistry.getSpawnConfigForModel", () => {
  test("与 getSpawnConfigForSubAgent 同口径：按类型 = 按该类型解析出的模型", () => {
    const reg = new ProviderRegistry(multiProviderConfig(), { explore: "haiku-like" });
    expect(reg.getSpawnConfigForSubAgent("explore")).toEqual(
      reg.getSpawnConfigForModel("haiku-like"),
    );
  });

  test("主模型 → 主连接", () => {
    const reg = new ProviderRegistry(multiProviderConfig());
    const sc = reg.getSpawnConfigForModel("main-model");
    expect(sc.providerName).toBe("openai");
    expect(sc.baseURL).toBe("https://gw-main/v1");
  });

  test("跨 provider 模型 → 用它自己声明的 provider/baseURL/apiKey", () => {
    const reg = new ProviderRegistry(multiProviderConfig());
    const sc = reg.getSpawnConfigForModel("haiku-like");
    expect(sc.providerName).toBe("anthropic");
    expect(sc.baseURL).toBe("https://gw-anthropic");
    expect(sc.apiKey).toBe("sk-ant");
  });
});
