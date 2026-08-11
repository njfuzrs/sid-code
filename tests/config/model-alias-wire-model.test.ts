/**
 * 配置层：别名（name）+ 真名（model_id）双渠道配置的解析回归。
 *
 * 覆盖三条本次改造新增的接线：
 *   1. snake_case `model_id` 必须被归一化进 ModelConfig.modelId（漏字段 = 用户配了被静默丢弃）；
 *   2. resolveCurrentModelConfig 必须顺带刷新进程级别名表（它是启动解析与 /model 切换的共同咽喉）；
 *   3. 注册表兜底（maxOutputTokens / contextWindow）必须按真名查 —— 喂别名会 miss 到不钳制，
 *      把上个模型的高 maxTokens 原样发出去吃 400。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Config } from "@sid-code/core/config/config.ts";
import {
  resolveCurrentModelConfig,
  resolveMaxOutputTokensForModel,
  normalizeConfigKeysForTest,
} from "@sid-code/core/config/config.ts";
import {
  lookupWireModelAlias,
  resetWireModelAliases,
} from "@sid-code/core/llm/wire-model.ts";
import { TokenEstimator } from "@sid-code/core/llm/token-estimator.ts";

function makeConfig(over: Partial<Config> = {}): Config {
  return {
    provider: "anthropic",
    model: "claude-sonnet-5-gateway",
    fallbackModel: "",
    anthropicKey: "k",
    openaiKey: "",
    baseURL: "https://gateway.internal",
    maxTokens: 8192,
    availableModels: [
      {
        name: "claude-sonnet-5-gateway",
        modelId: "claude-sonnet-5",
        provider: "anthropic",
        baseURL: "https://gateway.internal",
        apiKey: "sk-gw",
      },
      {
        name: "claude-sonnet-5-official",
        modelId: "claude-sonnet-5",
        provider: "anthropic",
        baseURL: "https://api.anthropic.com",
        apiKey: "sk-official",
      },
    ],
    permissionMode: "default",
    skipPermissions: false,
    allowedTools: [],
    disallowedTools: [],
    yesMode: false,
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
    debugLogFile: "~/.sid-code/debug.log",
    hooks: [],
    mcpServers: {},
    ...over,
  } as unknown as Config;
}

describe("settings.json 的 snake_case model_id 必须被归一化", () => {
  // 归一化是一份**手写字段列表**，漏一个字段就是「用户配了却被静默丢弃」→ 别名当模型名
  // 发给厂商吃 400。同一位置此前已经漏过 pricing 一次，所以这条必须有测试钉住。
  test("model_id → modelId", () => {
    const out = normalizeConfigKeysForTest({
      available_models: [
        { name: "claude-sonnet-5-gateway", model_id: "claude-sonnet-5", base_url: "https://gw/v1", api_key: "sk-1" },
      ],
    }) as any;
    expect(out.availableModels[0].modelId).toBe("claude-sonnet-5");
    // 同批字段不得回退
    expect(out.availableModels[0].baseURL).toBe("https://gw/v1");
    expect(out.availableModels[0].apiKey).toBe("sk-1");
  });

  test("camelCase modelId 混写同样接受", () => {
    const out = normalizeConfigKeysForTest({
      available_models: [{ name: "a", modelId: "real-a" }],
    }) as any;
    expect(out.availableModels[0].modelId).toBe("real-a");
  });

  test("没配 model_id → modelId 为 undefined（不臆造）", () => {
    const out = normalizeConfigKeysForTest({
      available_models: [{ name: "glm-5" }],
    }) as any;
    expect(out.availableModels[0].modelId).toBeUndefined();
  });
});

describe("双渠道：两条别名各自可解析到自己的端点与 Key", () => {
  beforeEach(() => resetWireModelAliases());
  afterEach(() => resetWireModelAliases());

  test("选网关别名 → 回填网关的 base_url / api_key", () => {
    const config = makeConfig({ model: "claude-sonnet-5-gateway" });
    resolveCurrentModelConfig(config);
    expect(config.baseURL).toBe("https://gateway.internal");
    expect(config.anthropicKey).toBe("sk-gw");
  });

  test("选官方别名 → 回填官方的 base_url / api_key（旧实现下这条永远切不过去）", () => {
    // 这就是改造要解决的核心症状：同名时第二条的 base_url/api_key 是死配置。
    const config = makeConfig({ model: "claude-sonnet-5-official" });
    resolveCurrentModelConfig(config);
    expect(config.baseURL).toBe("https://api.anthropic.com");
    expect(config.anthropicKey).toBe("sk-official");
  });

  test("resolveCurrentModelConfig 顺带刷新别名表（启动 + /model 切换共同咽喉）", () => {
    const config = makeConfig();
    expect(lookupWireModelAlias("claude-sonnet-5-gateway")).toBeUndefined();
    resolveCurrentModelConfig(config);
    expect(lookupWireModelAlias("claude-sonnet-5-gateway")).toBe("claude-sonnet-5");
    expect(lookupWireModelAlias("claude-sonnet-5-official")).toBe("claude-sonnet-5");
  });

  test("config.model 指向不存在的名字时，别名表仍与 availableModels 一致", () => {
    // 早退分支之前就得刷表，否则残留旧映射会把别名错翻成上一份配置的真名。
    const config = makeConfig({ model: "typo-not-exist" });
    resolveCurrentModelConfig(config);
    expect(lookupWireModelAlias("claude-sonnet-5-gateway")).toBe("claude-sonnet-5");
  });
});

describe("注册表兜底必须按真名查（别名会静默 miss）", () => {
  beforeEach(() => resetWireModelAliases());
  afterEach(() => resetWireModelAliases());

  const models = [
    { name: "gw-glm-5", modelId: "glm-5", provider: "openai" },
  ];

  test("maxOutputTokens：别名带前缀也能拿到真名的注册表上限", () => {
    // "gw-glm-5" 不在注册表里、也不是任何 key 的前缀 → 修前恒 undefined（不钳制）。
    const viaAlias = resolveMaxOutputTokensForModel("gw-glm-5", models as any);
    const viaReal = resolveMaxOutputTokensForModel("glm-5", []);
    expect(viaAlias).toBeDefined();
    expect(viaAlias).toBe(viaReal);
  });

  test("用户显式配的 maxOutputTokens 优先于真名注册表（渠道各自上限可不同）", () => {
    // 网关常比官方更紧，这个声明是对「这条渠道」的权威描述，不能被真名推导覆盖。
    const withExplicit = [{ name: "gw-glm-5", modelId: "glm-5", maxOutputTokens: 4096 }];
    expect(resolveMaxOutputTokensForModel("gw-glm-5", withExplicit as any)).toBe(4096);
  });

  test("contextWindow：别名带前缀也能拿到真名的窗口，不落 1M 兜底", () => {
    const est = new TokenEstimator();
    const viaAlias = est.getContextLimit("gw-glm-5", models as any);
    const viaReal = est.getContextLimit("glm-5", []);
    expect(viaAlias).toBe(viaReal);
    // 防「兜底值恰好等于真值」导致断言假通过
    expect(viaAlias).not.toBe(1_000_000);
  });

  test("用户显式配的 contextWindow 仍然最高优先", () => {
    const withExplicit = [{ name: "gw-glm-5", modelId: "glm-5", contextWindow: 65536 }];
    expect(new TokenEstimator().getContextLimit("gw-glm-5", withExplicit as any)).toBe(65536);
  });

  test("未配 modelId 的存量配置行为不变", () => {
    const legacy = [{ name: "glm-5", provider: "openai" }];
    expect(resolveMaxOutputTokensForModel("glm-5", legacy as any)).toBe(
      resolveMaxOutputTokensForModel("glm-5", []),
    );
  });
});

describe("provider 启发式推断按真名（缓存三段归一化口径）", () => {
  // normalizeCacheUsage 按 provider 分叉：Anthropic 的 inputTokens 是**未命中余量**，
  // OpenAI/DeepSeek 的 inputTokens **含命中**。provider 判错 → 三段拆分口径反掉 →
  // 成本与缓存命中率静默算错，不报错。别名带渠道前缀时 `/^claude/i` 就会判错。
  test("inferPricingProvider：前缀式别名靠 modelId 判回 anthropic", async () => {
    const { inferPricingProvider } = await import("@sid-code/core/api/cost-tracker.ts");
    const models = [{ name: "gw-claude-sonnet-5", modelId: "claude-sonnet-5" }];
    expect(inferPricingProvider("gw-claude-sonnet-5", models)).toBe("anthropic");
    // 没有 modelId 时按别名判 —— 会落 openai，正是修前的行为
    expect(inferPricingProvider("gw-claude-sonnet-5", [{ name: "gw-claude-sonnet-5" }])).toBe("openai");
  });

  test("SessionState.inferProvider：同上口径", async () => {
    const { SessionState } = await import("@sid-code/core/session/state.ts");
    const models = [{ name: "gw-claude-sonnet-5", modelId: "claude-sonnet-5" }];
    expect(SessionState.inferProvider("gw-claude-sonnet-5", models)).toBe("anthropic");
  });

  test("用户显式配的 provider 永远最高优先（不被真名推断覆盖）", async () => {
    const { inferPricingProvider } = await import("@sid-code/core/api/cost-tracker.ts");
    const { SessionState } = await import("@sid-code/core/session/state.ts");
    // 真名像 claude，但用户显式说这条渠道走 openai 协议 → 必须尊重用户
    const models = [{ name: "weird", modelId: "claude-sonnet-5", provider: "openai" }];
    expect(inferPricingProvider("weird", models)).toBe("openai");
    expect(SessionState.inferProvider("weird", models)).toBe("openai");
  });

  test("存量配置（无 modelId）行为完全不变", async () => {
    const { inferPricingProvider } = await import("@sid-code/core/api/cost-tracker.ts");
    expect(inferPricingProvider("claude-sonnet-5", [{ name: "claude-sonnet-5" }])).toBe("anthropic");
    expect(inferPricingProvider("glm-5", [{ name: "glm-5" }])).toBe("openai");
  });
});

describe("计价仍按别名（两渠道差价不得被抹平）", () => {
  test("同一真名的两条渠道各自计价", async () => {
    const { resolvePricing } = await import("@sid-code/core/api/cost-tracker.ts");
    const models = [
      { name: "gw", modelId: "claude-sonnet-5", baseURL: "https://gateway.internal/v1", pricing: { input: 1, output: 2 } },
      { name: "official", modelId: "claude-sonnet-5", baseURL: "https://api.anthropic.com", pricing: { input: 3, output: 6 } },
    ];
    expect(resolvePricing("gw", models, "https://gateway.internal/v1")?.input).toBe(1);
    expect(resolvePricing("official", models, "https://api.anthropic.com")?.input).toBe(3);
  });
});

describe("别名表清空（early-return 顺序回归）", () => {
  beforeEach(() => resetWireModelAliases());
  afterEach(() => resetWireModelAliases());

  test("切到空 availableModels 必须清空旧映射，不得残留上一份配置的真名", () => {
    // 缺陷：setWireModelAliases 曾被放在 `if (!availableModels?.length) return` **之后**，
    // 于是「切到没有 availableModels 的配置」时旧映射残留 —— 别名被翻成上一份配置的
    // 真名照样发出去，不报错。这是本次 code review 抓出的真实逻辑错误。
    const withAliases = makeConfig();
    resolveCurrentModelConfig(withAliases);
    expect(lookupWireModelAlias("claude-sonnet-5-gateway")).toBe("claude-sonnet-5");

    const empty = makeConfig({ availableModels: [] } as any);
    resolveCurrentModelConfig(empty);
    expect(lookupWireModelAlias("claude-sonnet-5-gateway")).toBeUndefined();
  });

  test("切到「有模型但都没配 model_id」的配置同样清空", () => {
    resolveCurrentModelConfig(makeConfig());
    expect(lookupWireModelAlias("claude-sonnet-5-gateway")).toBe("claude-sonnet-5");

    const legacy = makeConfig({
      model: "glm-5",
      availableModels: [{ name: "glm-5", provider: "openai" }],
    } as any);
    resolveCurrentModelConfig(legacy);
    expect(lookupWireModelAlias("claude-sonnet-5-gateway")).toBeUndefined();
  });
});
