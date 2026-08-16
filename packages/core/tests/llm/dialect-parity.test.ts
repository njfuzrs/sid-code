/**
 * dialect 重构的**行为等价**断言。
 *
 * ## 这份测试要挡的是什么
 *
 * PR-3 把族差异行为从 `effort.ts` + `openai.ts` 搬进 `dialect/`。搬迁类改动最危险的
 * 失败模式不是「跑不起来」，而是**跑起来了但某一族的某个字段悄悄变了形状**——
 * 现有单测覆盖的是「DeepSeek 开思考发什么」这类正向用例，覆盖不到
 * 「我在重构时把 Grok 的 `!thinkingDisabled` 守卫顺手抹平了」这种。
 *
 * 故本文件按**族 × 输入**穷举，把每一格的期望值**硬编码**在这里，
 * 而不是拿 dialect 自己的声明去断言 dialect（那是同义反复，改错了两边一起变）。
 *
 * 表里的期望值来自重构前的 `git show HEAD~:...` 实读，**不是**从新实现反推的。
 * 有两处刻意保留的不对称（见下面注释），它们正是这份测试存在的理由。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { resolveEffortCapability, type EffortLevel } from "../../src/llm/effort.ts";
import { resetModelCompat } from "../../src/llm/model-compat.ts";
import {
  classifyProtocolFamily,
  isChatCompletionsFamily,
  getDialectWire,
  type ProtocolFamily,
  type WireDialect,
} from "../../src/llm/dialect/catalog.ts";
import type { SendParams } from "../../src/llm/types.ts";

/** 造一个最小 SendParams（只有被测字段有意义） */
function mkParams(model: string): SendParams {
  return { model, messages: [], maxTokens: 1024 };
}

beforeEach(() => {
  // compat 表是进程级的，不清会跨用例串味（本仓有过这个坑）。
  resetModelCompat();
});

describe("classifyProtocolFamily：唯一分类入口的判据与重构前逐条一致", () => {
  // 期望值来自重构前 effort.ts classifyCapability 的实读，含它的优先级顺序。
  const CASES: [string, { provider?: string; baseURL?: string }, ProtocolFamily][] = [
    // ── 注册表声明优先（优先级 1）──
    ["claude-opus-4-5-20260514", {}, "anthropic-native"],
    ["gpt-5.6-sol", {}, "openai-responses"],
    ["o3-mini", {}, "o-series"],
    ["glm-4.6", {}, "glm-openai"],
    ["grok-4.3", {}, "grok-openai"],

    // ── 未注册 → 正则兜底（优先级 2）──
    // DeepSeek 双端点：同一模型名，靠 baseURL 分族。
    ["deepseek-v9-unregistered", {}, "deepseek-openai"],
    [
      "deepseek-v9-unregistered",
      { baseURL: "https://gw.internal/anthropic/v1" },
      "deepseek-anthropic",
    ],
    // provider=anthropic 但模型名不像 claude → 仍判原生（旧判据如此）。
    ["some-internal-name", { provider: "anthropic" }, "anthropic-native"],
    ["claude-unreleased-model", {}, "anthropic-native"],
    ["o9-future", {}, "o-series"],
    ["glm-99-future", {}, "glm-openai"],
    ["x-grok-mini", {}, "grok-openai"], // grok 是**非锚定**正则，中间匹配也算
    // ⚠ deepseek 优先于 anthropic 判定：provider=anthropic 且名字含 deepseek → deepseek 族
    ["deepseek-r2", { provider: "anthropic" }, "deepseek-openai"],

    // ── 刻意落 unknown 的（这几条是「不按模型名硬编码」的护栏）──
    // gpt-5.x 未注册时**不**判 openai-responses：那由 shouldUseResponsesAPI 裁决。
    ["gpt-5.9-unreleased", {}, "unknown"],
    ["kimi-k3", {}, "unknown"],
    ["qwen3-coder-plus", {}, "unknown"],
  ];

  for (const [model, opts, expected] of CASES) {
    test(`${model}${opts.baseURL ? " @anthropic端点" : ""}${opts.provider ? ` provider=${opts.provider}` : ""} → ${expected}`, () => {
      expect(classifyProtocolFamily({ model, ...opts })).toBe(expected);
    });
  }
});

describe("isChatCompletionsFamily：白名单谓词（替代重构前的排除式）", () => {
  // 走 Chat Completions 顶层字段透传的族。
  for (const kind of [
    "deepseek-openai",
    "glm-openai",
    "grok-openai",
    "o-series",
    "unknown",
  ] as const) {
    test(`${kind} → 走 Chat Completions 线`, () => {
      expect(isChatCompletionsFamily(kind)).toBe(true);
    });
  }
  // 有独立请求构造器的族，**必须**被排除——否则 Responses 专属的 xhigh/max
  // 会被当普通 reasoning_effort 发到 Chat 线上（2026-08-08 前的真实缺陷形态）。
  for (const kind of ["anthropic-native", "deepseek-anthropic", "openai-responses"] as const) {
    test(`${kind} → 不走 Chat Completions 线`, () => {
      expect(isChatCompletionsFamily(kind)).toBe(false);
    });
  }
});

describe("各族线格式描述符：逐字段锁死（期望值来自重构前实读，非从实现反推）", () => {
  // 每一格都对应重构前一处具体的 if 条件，列在注释里便于溯源。
  // 期望值用 WireDialect 自己的字段类型，而不是宽松的 string：
  // 写错一个字面量（如 "auto_only"）应当是**编译期**错误，而不是留到跑测试才发现。
  const WIRE: Record<
    ProtocolFamily,
    {
      toggle: WireDialect["thinkingToggle"];
      sendsEffort: boolean;
      gated: boolean;
      allowsMax: boolean;
      toolChoice: WireDialect["toolChoice"];
    }
  > = {
    // 旧：if (isDeepSeek || isGLM) { thinking:{type}; if (effort && !thinkingDisabled) ... }
    "deepseek-openai": {
      toggle: "type-enum",
      sendsEffort: true,
      gated: true,
      allowsMax: true,
      toolChoice: "reject-when-thinking",
    },
    "glm-openai": {
      toggle: "type-enum",
      sendsEffort: true,
      gated: true,
      allowsMax: true,
      toolChoice: "auto-only",
    },
    // 旧：if (isGrok && effort && effort !== "max" && !thinkingDisabled)
    //     ⚠ 带 !thinkingDisabled，尽管 Grok 无思考开关 —— 已知不对称，原样保留。
    "grok-openai": {
      toggle: "none",
      sendsEffort: true,
      gated: true,
      allowsMax: false,
      toolChoice: "full",
    },
    // 旧：if (isOSeries && effort && effort !== "max")
    //     ⚠ **没有** !thinkingDisabled —— 与 Grok 那支不对称，也原样保留。
    "o-series": {
      toggle: "none",
      sendsEffort: true,
      gated: false,
      allowsMax: false,
      toolChoice: "full",
    },
    // 旧：if (isUnknownFamily && effort && !thinkingDisabled)
    //     sendsEffort 必须为 true——它是 400 自愈闭环的入口。
    unknown: {
      toggle: "none",
      sendsEffort: true,
      gated: true,
      allowsMax: true,
      toolChoice: "full",
    },
    // 以下三族不走 Chat 线，wire 仅为描述符完整性。
    "anthropic-native": {
      toggle: "none",
      sendsEffort: false,
      gated: true,
      allowsMax: true,
      toolChoice: "full",
    },
    "deepseek-anthropic": {
      toggle: "none",
      sendsEffort: false,
      gated: true,
      allowsMax: true,
      toolChoice: "full",
    },
    "openai-responses": {
      toggle: "none",
      sendsEffort: false,
      gated: false,
      allowsMax: true,
      toolChoice: "full",
    },
  };

  for (const [kind, exp] of Object.entries(WIRE) as [
    ProtocolFamily,
    (typeof WIRE)[ProtocolFamily],
  ][]) {
    test(`${kind}`, () => {
      const w = getDialectWire(kind);
      expect(w.thinkingToggle).toBe(exp.toggle);
      expect(w.sendsReasoningEffort).toBe(exp.sendsEffort);
      expect(w.effortGatedByThinking).toBe(exp.gated);
      expect(w.allowsMaxEffort).toBe(exp.allowsMax);
      expect(w.toolChoice).toBe(exp.toolChoice);
    });
  }

  test("未知族的 sendsReasoningEffort 必须为 true（400 自愈闭环的入口）", () => {
    // 单独立一条并写明理由：这一位若被改成 false，整套动态能力采集对未知模型
    // （kimi / qwen / 任意新模型 —— 它唯一的目标人群）就全链空转，且**不会有任何测试红**
    // 除了这一条。2026-08-01 真实发生过。
    expect(getDialectWire("unknown").sendsReasoningEffort).toBe(true);
  });
});

describe("applyToSendParams：各族档位 → SendParams 的映射与重构前一致", () => {
  /** 跑一遍某族的 applier，返回被 patch 后的关键字段 */
  function apply(
    model: string,
    effort: EffortLevel | undefined,
    thinking: boolean,
    opts: { provider?: string; baseURL?: string } = {},
  ) {
    const cap = resolveEffortCapability({ model, provider: opts.provider ?? "openai", ...opts });
    const p = mkParams(model);
    cap.applyToSendParams(p, effort, thinking);
    return {
      reasoningEffort: p.reasoningEffort,
      thinking: p.thinking,
      outputConfig: p.outputConfig,
    };
  }

  test("DeepSeek/OpenAI 端点：只认 high/max，低档全升 high", () => {
    // 旧 applyDeepSeekOpenAI：clampToMaxWire(effort) === "max" ? "max" : "high"
    expect(apply("deepseek-v9-x", "low", true).reasoningEffort).toBe("high");
    expect(apply("deepseek-v9-x", "medium", true).reasoningEffort).toBe("high");
    expect(apply("deepseek-v9-x", "high", true).reasoningEffort).toBe("high");
    expect(apply("deepseek-v9-x", "xhigh", true).reasoningEffort).toBe("max");
    expect(apply("deepseek-v9-x", "max", true).reasoningEffort).toBe("max");
  });

  test("DeepSeek：思考关闭时不下发 effort，但仍下发 thinking:{enabled:false}", () => {
    const r = apply("deepseek-v9-x", "max", false);
    expect(r.reasoningEffort).toBeUndefined();
    expect(r.thinking).toEqual({ enabled: false, budgetTokens: 0 });
  });

  test("DeepSeek/Anthropic 端点：强度走 outputConfig.effort，不是 reasoningEffort", () => {
    // 这一对是「布尔位表达不了族差异」的最短证明：同模型换端点，字段位置就变了。
    const r = apply("deepseek-v9-x", "max", true, { baseURL: "https://gw/anthropic/v1" });
    expect(r.outputConfig).toEqual({ effort: "max" });
    expect(r.reasoningEffort).toBeUndefined();
  });

  test("GLM：认四档且 xhigh→max（与 DeepSeek 的 high/max 二档不同）", () => {
    // 旧 applyGLMOpenAI：clampToMaxWire(effort)，即只把 xhigh 折成 max，其余原样。
    expect(apply("glm-99-x", "low", true).reasoningEffort).toBe("low");
    expect(apply("glm-99-x", "medium", true).reasoningEffort).toBe("medium");
    expect(apply("glm-99-x", "xhigh", true).reasoningEffort).toBe("max");
    expect(apply("glm-99-x", "max", true).reasoningEffort).toBe("max");
  });

  test("Grok：无 max，max/xhigh 均→high；且不下发 thinking", () => {
    // 旧 applyGrokOpenAI：clampToHighWire + 不碰 params.thinking
    expect(apply("x-grok-mini", "max", true).reasoningEffort).toBe("high");
    expect(apply("x-grok-mini", "xhigh", true).reasoningEffort).toBe("high");
    expect(apply("x-grok-mini", "low", true).reasoningEffort).toBe("low");
    // 关键：本族无思考开关，applier 刻意不写 params.thinking（发了是白撞 400）。
    expect(apply("x-grok-mini", "low", true).thinking).toBeUndefined();
  });

  test("o-series：无 max，且不受 thinking=false 影响（内置推理）", () => {
    expect(apply("o9-future", "max", true).reasoningEffort).toBe("high");
    // thinking=false 仍下发 effort —— o-series 的 applier 不看 thinking 参数。
    expect(apply("o9-future", "low", false).reasoningEffort).toBe("low");
    expect(apply("o9-future", "low", false).thinking).toBeUndefined();
  });

  test("auto（effort=undefined）时不下发 effort 字段", () => {
    // 所有族一致：undefined = 跟随服务端默认，不显式下发。
    for (const m of ["deepseek-v9-x", "glm-99-x", "x-grok-mini", "o9-future"]) {
      expect(apply(m, undefined, true).reasoningEffort).toBeUndefined();
    }
  });
});

describe("openai.ts 的族判定**不得**吃 baseURL（重构中真实踩到的回归）", () => {
  /**
   * 这条锁的是一次在本次重构过程中真实制造、又当场发现的回归。
   *
   * `classifyProtocolFamily` 支持 `baseURL`，用途是把**未注册**的 DeepSeek 模型按
   * 路径含 `/anthropic` 分到 `deepseek-anthropic` 族。但 `openai.ts` 是 OpenAI 协议
   * provider —— 走到它的请求定义上就在 Chat Completions 线上，重构前它的判据
   * （`kind === undefined && /deepseek/i.test(model)`）**根本不看 baseURL**。
   *
   * 顺手把 `baseURL: this.baseURL` 传进去（看着更「完整」）会造成：企业网关路由前缀
   * 带 `/anthropic` 时，未注册 DeepSeek 模型被判成 `deepseek-anthropic`
   * → 被 `isChatCompletionsFamily` 早退挡掉 → thinking 与 reasoning_effort 全不下发，
   * **且 `applyToolChoice` 会开始下发 `tool_choice`**（DeepSeek V4 思考模式实测 400）。
   *
   * 即：一个「顺手补全参数」的动作，能把线上从「正常」变成「稳定 400」。
   * 现有单测全绿放过 —— 因为没有一条测试跑「网关路径带 /anthropic 的未注册 DeepSeek」。
   */
  test("同一未注册 DeepSeek 模型：带/不带 /anthropic 路径分属不同族", () => {
    const model = "deepseek-v9-unregistered";
    expect(classifyProtocolFamily({ model })).toBe("deepseek-openai");
    expect(classifyProtocolFamily({ model, baseURL: "https://gw.corp/anthropic/v1" })).toBe(
      "deepseek-anthropic",
    );
  });

  test("deepseek-anthropic 不走 Chat 线，故 tool_choice 无族级拦截（这就是危险所在）", () => {
    // 若 openai.ts 误判成本族，`reject-when-thinking` 的保护就失效了。
    expect(getDialectWire("deepseek-anthropic").toolChoice).toBe("full");
    expect(getDialectWire("deepseek-openai").toolChoice).toBe("reject-when-thinking");
  });

  test("openai.ts 全部调用点均不传 baseURL（源码级断言，防后人「补全」）", async () => {
    // 直接读源码断言，而不是靠行为测 —— 行为测需要构造真实 provider + 网关，
    // 而这条约束的本质是「别给这个调用点加参数」，源码级最直接。
    //
    // ⚠ 调用点数量从 2 涨到 3：新增的是 `convertTools`（工具 schema 方言层要按族取
    // 裁剪规则）。**这个数字本身不是不变量**，真正的不变量是下面那个循环——
    // 每一处都不许吃 baseURL。故数字只做「有新调用点时提醒人来看一眼」的哨兵，
    // 加调用点时更新它是预期动作；把断言删掉才是错的。
    const src = await Bun.file(new URL("../../src/llm/openai.ts", import.meta.url).pathname).text();
    const calls = src.match(/classifyProtocolFamily\(\{[^}]*\}\)/g) ?? [];
    expect(calls.length).toBe(3);
    for (const c of calls) {
      expect(c).not.toContain("baseURL");
    }
  });
});

describe("Anthropic 原生：两条协议路径 + 预算钳制（本族为何需要函数而非描述符）", () => {
  function applyAnthropic(model: string, effort: EffortLevel | undefined, thinking: boolean) {
    const cap = resolveEffortCapability({ model, provider: "anthropic" });
    const p = mkParams(model);
    cap.applyToSendParams(p, effort, thinking);
    return p;
  }

  test("manual 路径（未注册的旧模型名）：强度是 budget_tokens 数值，不是档位字符串", () => {
    // 这正是布尔位/枚举表达不了的东西——强度载体是数值。
    expect(applyAnthropic("claude-legacy-x", "low", true).thinking).toEqual({
      enabled: true,
      budgetTokens: 2_000,
    });
    expect(applyAnthropic("claude-legacy-x", "medium", true).thinking).toEqual({
      enabled: true,
      budgetTokens: 10_000,
    });
    expect(applyAnthropic("claude-legacy-x", "high", true).thinking).toEqual({
      enabled: true,
      budgetTokens: 20_000,
    });
    expect(applyAnthropic("claude-legacy-x", "xhigh", true).thinking).toEqual({
      enabled: true,
      budgetTokens: 32_000,
    });
    expect(applyAnthropic("claude-legacy-x", "max", true).thinking).toEqual({
      enabled: true,
      budgetTokens: 50_000,
    });
  });

  test("manual + auto：兜底 medium 预算（10K），不是不下发", () => {
    expect(applyAnthropic("claude-legacy-x", undefined, true).thinking?.budgetTokens).toBe(10_000);
  });

  test("思考关闭：下发 enabled:false + 预算 0", () => {
    expect(applyAnthropic("claude-legacy-x", "max", false).thinking).toEqual({
      enabled: false,
      budgetTokens: 0,
    });
  });
});
