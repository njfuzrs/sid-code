/**
 * 模型能力动态采集 —— 接线完整性回归测试（2026-08-01）。
 *
 * 为什么单独建这个文件：下面每一条对应的缺陷**都通过了当时全部 7464 个测试**。
 * 它们不是逻辑写错，而是「算出来的值没人消费」「三份重复实现悄悄漂移」这类
 * **接线断裂**——单元测试各自测自己那一段都是绿的，断点恰好落在段与段之间。
 * 所以这里测的是「链路是否真的通」，而不是某个函数的输入输出。
 *
 * 覆盖 4 条断点：
 *   1. 未知协议族的 reasoning_effort 是否真的进 requestBody（P0，整套采集的自愈入口）
 *   2. 上下文超限判定三处是否仍一致（活路径曾漏判 4 种措辞 → 该压缩却不压缩）
 *   3. 非流式路径是否有能力自愈（曾只有流式有 → 降级后行为不对称）
 *   4. 目录同步 TTL 是否 1 天且可 env 覆盖
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { resolveEffortCapability } from "../../src/llm/effort.ts";
import { lookupCatalog } from "../../src/llm/model-params-catalog.ts";
import {
  learnFromError,
  shouldSyncCatalogs,
  shouldRetryWithoutEffort,
  recordEffortRejected,
  lookupCapability,
  __resetCapabilityCacheForTest,
} from "../../src/llm/model-capabilities.ts";
import { isPromptTooLong } from "../../src/api/errors.ts";
import { isPromptTooLongError } from "../../src/query/reactive-compact.ts";

/**
 * 判断模型是否属于「未知协议族」——即本次修复的目标人群。
 *
 * 只用于挑选/排除测试输入，**不**用于断言下发结果：断言必须观测真实请求体
 * （见 captureWireBody）。第一版这里曾复刻整个分派逻辑再拿它当期望值，结果是同义反复——
 * 实测把 openai.ts 里的未知族分支整段删掉，这组测试依然全绿。
 */
function isUnknownFamily(model: string): boolean {
  const kind = lookupCatalog(model)?.protocolKind;
  if (kind !== undefined) return false;
  return !/deepseek/i.test(model) && !/^glm/i.test(model) && !/grok/i.test(model) && !/^o[0-9]/i.test(model);
}

/**
 * 发一次真实（被 mock 的）非流式请求，捕获 sid-code 实际发出的 HTTP body。
 *
 * 这是本文件唯一可信的观测手段：applyDeepSeekThinking 是 private 的，其分派判据是
 * 方法内局部变量，从外部无法直接读取——只能看「最终发到线上的字段」。
 */
async function captureWireBody(
  model: string,
  params: Record<string, unknown>,
): Promise<any> {
  const { OpenAIProvider } = await import("../../src/llm/openai.ts");
  let captured: any = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    captured = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as any;
  try {
    const provider = new OpenAIProvider("k", model, "https://example.invalid/v1");
    await provider.sendMessageNonStreaming({
      model,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxTokens: 16,
      ...params,
    } as any);
  } finally {
    globalThis.fetch = origFetch;
  }
  return captured;
}

describe("P0 未知协议族 effort 必须真的下发（自愈闭环入口）", () => {
  beforeEach(() => __resetCapabilityCacheForTest({}));

  /**
   * 这是整组测试里最重要的一条。
   *
   * 缺陷链：effort.ts 对未知族**乐观放行**（supportsEffort=true）算出 reasoningEffort，
   * 但 openai.ts 的分派只认 deepseek/glm/grok/o-series 四族 → 字段算出来却从不进
   * requestBody → 服务端永远不会因它报 400 → withCapabilityHealing 永不触发 →
   * model-capabilities.ts 的「乐观放行 + 400 学真值」闭环在它**唯一的目标人群**上是断的。
   */
  test.each(["kimi-k3", "qwen3-coder-plus", "brand-new-model-2027"])(
    "%s（未知族）：effort 既要算出来，也要真的进 requestBody",
    async (model) => {
      expect(isUnknownFamily(model)).toBe(true);

      // 第一段：effort.ts 对未知族乐观放行，算出档位
      const cap = resolveEffortCapability({ model, provider: "openai" });
      const params: any = {};
      cap.applyToSendParams(params, "high", true);
      expect(params.reasoningEffort).toBeDefined();

      // 第二段（曾断裂）：观测真实请求体——字段必须落到线上，否则 400 永不发生、自愈永不触发
      const body = await captureWireBody(model, { reasoningEffort: params.reasoningEffort });
      expect(body.reasoning_effort).toBe(params.reasoningEffort);
    },
  );

  test("未知族 + 显式关闭思考 → 不下发（与其它族语义一致）", async () => {
    const body = await captureWireBody("kimi-k3", {
      reasoningEffort: "high",
      thinking: { enabled: false },
    });
    expect(body.reasoning_effort).toBeUndefined();
  });

  test("未知族不得被下发 thinking 字段（结构各家不同，猜错无法自愈）", async () => {
    const body = await captureWireBody("kimi-k3", { reasoningEffort: "high" });
    expect(body.thinking).toBeUndefined();
  });

  /**
   * 判据必须是「protocolKind 缺失 **且** 四族正则不匹配」，不能是「不属于这四族」。
   * openai-responses 有专属 applier 与专属线格式（当前唯一原生认 xhigh 的族），
   * 且 sendMessageNonStreaming **不做** Responses 分派——用「不属于四族」会让 GPT-5.x
   * 在「流式失败降级到非流式」时把 xhigh 当普通 reasoning_effort 发到 Chat Completions
   * 线上（其它端点不认这一档）。
   */
  test("已声明为其它已知族的模型不得被当成未知族", () => {
    for (const m of ["gpt-5.6-luna", "glm-5.2", "o3", "grok-4", "deepseek-v4-pro"]) {
      expect(isUnknownFamily(m)).toBe(false);
    }
  });

  test("openai-responses 族走非流式时不得把 xhigh 发到 Chat Completions 线上", async () => {
    const body = await captureWireBody("gpt-5.6-luna", { reasoningEffort: "xhigh" });
    expect(body.reasoning_effort).toBeUndefined();
  });
});

describe("P1 上下文超限判定：三处必须一致（SSOT）", () => {
  beforeEach(() => __resetCapabilityCacheForTest({}));

  /**
   * 这 4 种措辞是活路径（isPromptTooLongError，驱动 reactiveCompact 的唯一闸门）
   * 此前实测漏判的。漏判后果不是报错而是**该压缩时不压缩**——用户直接吃一个
   * 本可自动恢复的失败。
   */
  const HISTORICALLY_MISSED = [
    "context_length_exceeded",
    "Your input exceeds the context window of this model.",
    "too many tokens in request",
    "Please reduce the length of the messages.",
  ];

  test.each(HISTORICALLY_MISSED)("曾漏判的措辞现在必须判为超限：%s", (msg) => {
    expect(isPromptTooLongError(new Error(msg))).toBe(true);
    expect(isPromptTooLong(new Error(msg))).toBe(true);
    expect(learnFromError("m", msg).contextExceeded).toBe(true);
  });

  test.each([
    "prompt is too long: 137500 tokens > 135000 maximum",
    "maximum context length is 128000 tokens",
    ...HISTORICALLY_MISSED,
  ])("三处判定完全一致（防重复实现再次漂移）：%s", (msg) => {
    const live = isPromptTooLongError(new Error(msg));
    const ssot = isPromptTooLong(new Error(msg));
    const heal = learnFromError("m", msg).contextExceeded === true;
    expect(live).toBe(ssot);
    expect(heal).toBe(ssot);
  });

  test.each([
    "401 authentication failed",
    "rate_limit exceeded, retry later",
    "model_not_found",
  ])("不得把无关错误误判为超限（误判会触发无意义压缩）：%s", (msg) => {
    expect(isPromptTooLong(new Error(msg))).toBe(false);
    expect(isPromptTooLongError(new Error(msg))).toBe(false);
  });
});

describe("400 自愈兜底：不得依赖措辞匹配（否则主动多发 = 新增用户可见故障）", () => {
  beforeEach(() => __resetCapabilityCacheForTest({}));

  /** 执行层的真实判据：措辞匹配 **或** 结构匹配。两处自愈路径都用这个组合。 */
  const willHeal = (msg: string, statusCode?: number) =>
    learnFromError("u", msg).dropEffort === true ||
    shouldRetryWithoutEffort({ statusCode, errorMessage: msg });

  /**
   * 这 5 种措辞是 learnFromError 的文本匹配**兜不住**的，实测。
   * 因为 P0 让我们对未知族**主动多发** reasoning_effort，漏判一种措辞就等于
   * 让那批用户看到一个修复前根本不存在的 400——所以必须有不看措辞的结构兜底。
   */
  test.each([
    ["vLLM/pydantic 兼容层", "Extra inputs are not permitted [type=extra_forbidden]", 400],
    ["不含字段名·泛化", "Invalid request body", 400],
    ["不含字段名·422", "One or more parameters are invalid", 422],
    ["网关透传截断（正文全丢）", "400 Bad Request", 400],
    ["中文网关不含字段名", "参数错误：不支持的参数", 400],
  ])("措辞匹配不到也必须自愈：%s", (_label, msg, code) => {
    expect(learnFromError("u", msg).dropEffort).toBeUndefined(); // 措辞确实匹配不到
    expect(willHeal(msg, code as number)).toBe(true); // 但结构兜底接住了
  });

  test.each([
    ["401 鉴权", "invalid api key", 401],
    ["403 禁止", "forbidden", 403],
    ["404 模型不存在", "model_not_found", 404],
    ["429 限流", "rate limit exceeded", 429],
    ["413 上下文超限", "prompt is too long: 137500 > 135000", 413],
    ["400 但是上下文超限（该压缩不该剥字段）", "context_length_exceeded", 400],
    ["500 服务端故障", "internal server error", 500],
  ])("不得误自愈（会掩盖真问题 / 白费一次请求）：%s", (_label, msg, code) => {
    expect(willHeal(msg, code as number)).toBe(false);
  });

  test.each([
    ["网络中断", "fetch failed: ECONNRESET"],
    ["超时", "The operation was aborted"],
  ])("无状态码且措辞无字段名 → 证据不足，不猜：%s", (_label, msg) => {
    expect(willHeal(msg, undefined)).toBe(false);
  });

  test("无状态码但措辞含字段名 → 仍自愈（网关未透传状态码的情形）", () => {
    expect(willHeal("unsupported reasoning_effort", undefined)).toBe(true);
  });
});

describe("自愈记账：避免永久 2 倍请求", () => {
  beforeEach(() => __resetCapabilityCacheForTest({}));

  /**
   * 结构兜底不看措辞，因此也学不到任何东西。若只重试不记账，就退化成
   * 「每次对话都先撞一次 400 再重试」——永久 2 倍请求数与首字延迟。
   */
  test("记账后同一模型不再下发 effort（下次不再撞 400）", () => {
    const before = resolveEffortCapability({ model: "gw-model", provider: "openai" });
    const p1: any = {};
    before.applyToSendParams(p1, "high", true);
    expect(p1.reasoningEffort).toBeDefined(); // 记账前：乐观放行，会撞 400

    recordEffortRejected("gw-model");

    const after = resolveEffortCapability({ model: "gw-model", provider: "openai" });
    const p2: any = {};
    after.applyToSendParams(p2, "high", true);
    expect(p2.reasoningEffort).toBeUndefined(); // 记账后：不再下发
  });

  /**
   * 已有非空档位列表（用户配置/目录/探针的可信数据）时不得抹平：
   * 那种情况下的 400 更可能是「我们发的那一档不在列表里」，而非「完全不支持」。
   * 抹成 [] 会把一个支持 effort 的模型永久降级。
   */
  test("已有可信档位列表 → 不得被记账抹平", () => {
    __resetCapabilityCacheForTest({
      trusted: { contextWindow: 1000, effortValues: ["low", "high"], source: "catalog" },
    });
    recordEffortRejected("trusted");
    expect(lookupCapability("trusted")?.effortValues).toEqual(["low", "high"]);
  });

  test("重复记账幂等", () => {
    recordEffortRejected("m");
    recordEffortRejected("m");
    expect(lookupCapability("m")?.effortValues).toEqual([]);
  });

  /**
   * 「只在重试成功后记账」这条约束的守卫（流式路径的 sawError 标志）。
   *
   * 流式的坑：第二轮的错误是直接 yield 出去的，`capabilityError` 仍为 null，
   * 于是「重试也失败」会走进和「重试成功」同一个分支。少了 sawError 校验就会记账，
   * 把一个**可能明明支持 effort** 的模型永久标记为不支持——真因其实是别的（比如
   * 请求体里另一个字段不合法），却让 effort 背了锅，且这个误判会持久化到磁盘。
   */
  test("剥字段重试仍失败 → 不得记账（真因不是这个字段，别冤枉它）", async () => {
    const { OpenAIProvider } = await import("../../src/llm/openai.ts");
    const origFetch = globalThis.fetch;
    let calls = 0;
    // 两轮都 400，且措辞不含字段名（靠结构兜底触发自愈，learnFromError 学不到东西）
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "Invalid request body" } }), {
        status: 400,
      });
    }) as any;
    try {
      const provider = new OpenAIProvider("k", "innocent-model", "https://example.invalid/v1");
      const events: any[] = [];
      for await (const ev of provider.sendMessageStream({
        model: "innocent-model",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        maxTokens: 16,
        reasoningEffort: "high",
      } as any)) {
        events.push(ev);
      }
      // 确实重试过（两次请求），且错误最终透出给用户（不静默吞掉）
      expect(calls).toBe(2);
      expect(events.some((e) => e.type === "error")).toBe(true);
      // 关键断言：重试失败 → 不得留下「不支持 effort」的记账
      expect(lookupCapability("innocent-model")?.effortValues).not.toEqual([]);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("P2 非流式路径必须有能力自愈（与流式对称）", () => {
  let origFetch: typeof globalThis.fetch;
  beforeEach(() => {
    __resetCapabilityCacheForTest({});
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  /**
   * 此前只有流式包了 withCapabilityHealing，于是同一个未知模型「流式能自愈、
   * 降级到非流式就不能」。而降级恰恰发生在网关异常时——最不该再叠加一个
   * 可自愈失败的时刻。
   */
  test("首次因 reasoning_effort 400 → 剥字段重试并成功", async () => {
    const { OpenAIProvider } = await import("../../src/llm/openai.ts");
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.reasoning_effort !== undefined) {
        return new Response(
          JSON.stringify({
            error: { message: "Invalid value for 'reasoning_effort': supported values are low, high" },
          }),
          { status: 400 },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as any;

    const provider = new OpenAIProvider("k", "unknown-heal-me", "https://example.invalid/v1");

    const res = await provider.sendMessageNonStreaming({
      model: "unknown-heal-me",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxTokens: 16,
      reasoningEffort: "high",
    } as any);

    // 两次请求：第一次带 effort 被拒，第二次剥掉后成功
    expect(bodies).toHaveLength(2);
    expect(bodies[0].reasoning_effort).toBe("high");
    expect(bodies[1].reasoning_effort).toBeUndefined();
    expect(JSON.stringify(res)).toContain("ok");
  });

  test("非能力类错误（401）原样抛出，不重试掩盖真问题", async () => {
    const { OpenAIProvider } = await import("../../src/llm/openai.ts");
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 });
    }) as any;

    const provider = new OpenAIProvider("bad", "unknown-heal-me", "https://example.invalid/v1");

    let threw = false;
    try {
      await provider.sendMessageNonStreaming({
        model: "unknown-heal-me",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        maxTokens: 16,
        reasoningEffort: "high",
      } as any);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(calls).toBe(1); // 只发一次，没有盲目重试
  });
});

describe("/model discover 必须消费能力缓存", () => {
  /**
   * 缺陷：discover 的解析链是 API → 速查表 → 失败，中间**没有能力缓存这一档**。
   * 而 queryProviderAPI 对 OpenAI 兼容类（Moonshot/Qwen/GLM/DeepSeek）直接返回 null
   * （那些端点的 /v1/models 不返回能力字段）——于是恰好是本命令最该帮到的那批模型
   * 一路落到「⚠ 失败」，而准确数值就躺在 ~/.sid-code/model-capabilities.json 里。
   */
  test("未在速查表、但能力缓存有 → 报 cache 而非 failed", async () => {
    __resetCapabilityCacheForTest({
      "cache-only-model": { contextWindow: 262_144, maxOutputTokens: 32_768, source: "catalog" },
    });
    const { __discoverSingleForTest } = await import(
      "../../src/command/commands/model/discover.ts"
    );
    const r = await __discoverSingleForTest(
      { name: "cache-only-model", provider: "openai" } as any,
      false,
    );
    expect(r.source).toBe("cache");
    expect(r.contextWindow).toBe(262_144);
    expect(r.maxOutputTokens).toBe(32_768);
  });

  test("既不在速查表也不在缓存 → 仍报 failed（不得凭空编造）", async () => {
    __resetCapabilityCacheForTest({});
    const { __discoverSingleForTest } = await import(
      "../../src/command/commands/model/discover.ts"
    );
    const r = await __discoverSingleForTest(
      { name: "nobody-knows-this-model", provider: "openai" } as any,
      false,
    );
    expect(r.source).toBe("failed");
    expect(r.contextWindow).toBeNull();
  });
});

describe("目录同步 TTL：1 天 + env 可覆盖", () => {
  const KEY = "SID_MODEL_CATALOG_TTL_MS";
  const DAY = 24 * 60 * 60 * 1000;
  const SYNCED_AT = 1_700_000_000_000;

  beforeEach(() => {
    delete process.env[KEY];
    // 注入一条「上次同步成功、无失败」的元信息：TTL 判定才走 TTL 而非退避分支
    __resetCapabilityCacheForTest({});
  });
  afterEach(() => {
    delete process.env[KEY];
  });

  /**
   * ⚠ shouldSyncCatalogs 读的是模块内存态 meta，而 __resetCapabilityCacheForTest 会把它清空
   * （syncedAt 缺失 → 恒为 true）。所以这里只断言 env 解析这一段可观测的行为：
   * 缺失 syncedAt 时永远该同步——首次启动必须拉，这本身就是要守的语义。
   */
  test("无同步记录（首次启动）→ 必须同步，否则新用户永远拿不到能力数据", () => {
    expect(shouldSyncCatalogs(SYNCED_AT + DAY)).toBe(true);
  });

  test.each([
    ["非数字", "abc"],
    ["负数", "-5"],
    ["零", "0"],
    ["空串", ""],
  ])("env 非法值（%s）静默回退默认，不得让同步彻底停摆", (_label, raw) => {
    process.env[KEY] = raw;
    // 非法值不应导致抛错或永不同步
    expect(() => shouldSyncCatalogs(SYNCED_AT)).not.toThrow();
    expect(shouldSyncCatalogs(SYNCED_AT + 2 * DAY)).toBe(true);
  });
});
