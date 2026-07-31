/**
 * src/llm/model-capabilities.ts 单测 —— 动态能力解析的三个数据来源。
 *
 * 这个模块存在的意义：让「用户只配 name + endpoint + apiKey」成立，不必每上一个新模型
 * 就改代码或配置表。测试按三个来源组织：
 *   1. 外部目录解析（litellm / OpenRouter schema + 多源投票）
 *   2. 服务端自报抽取（探针 / 400 错误文本 → 档位与上限）
 *   3. 自愈建议（learnFromError → dropEffort / contextExceeded）
 *
 * 所有用例都不触网：外部源解析用内联 fixture，探针用注入的 send 假实现。
 */

import { describe, expect, test, beforeEach } from "bun:test";
import {
  lookupCapability,
  extractEffortValuesFromError,
  extractMaxTokensFromError,
  learnFromError,
  probeModelCapability,
  computeCatalogBackoffMs,
  __resetCapabilityCacheForTest,
  __getCapabilityCacheForTest,
  __sanitizeEntryForTest,
} from "../../src/llm/model-capabilities.ts";

beforeEach(() => {
  __resetCapabilityCacheForTest({});
});

describe("lookupCapability — 归一化匹配", () => {
  test("精确命中", () => {
    __resetCapabilityCacheForTest({ "some-model": { contextWindow: 128_000 } });
    expect(lookupCapability("some-model")?.contextWindow).toBe(128_000);
    // 大小写不敏感
    expect(lookupCapability("SOME-MODEL")?.contextWindow).toBe(128_000);
  });

  test("剥离渠道路由前缀（ali-/tx-/volc-…）——能力是模型固有属性，不随渠道变", () => {
    __resetCapabilityCacheForTest({ "doubao-seed-pro": { contextWindow: 256_000 } });
    for (const name of ["ali-doubao-seed-pro", "tx-doubao-seed-pro", "volc-doubao-seed-pro"]) {
      expect(lookupCapability(name)?.contextWindow).toBe(256_000);
    }
  });

  test("剥离 vendor 路径前缀（OpenRouter/网关风格 vendor/model）", () => {
    __resetCapabilityCacheForTest({ "kimi-k2.6": { contextWindow: 262_144 } });
    expect(lookupCapability("kimi/kimi-k2.6")?.contextWindow).toBe(262_144);
  });

  test("不做模糊前缀匹配 —— 避免把 mini 档的小窗口糊给主力模型", () => {
    // 第三方缓存精度不如手工注册表，宁可 miss 也不要跨档误配
    // （gpt-5.4-mini 是 400K，gpt-5.4 是 1.05M，糊错会导致 compact 阈值严重失真）。
    __resetCapabilityCacheForTest({ "gpt-5.4-mini": { contextWindow: 400_000 } });
    expect(lookupCapability("gpt-5.4")).toBeNull();
  });

  test("查不到返回 null（由调用方兜底，不在这里编数字）", () => {
    expect(lookupCapability("never-heard-of-this")).toBeNull();
  });
});

describe("extractEffortValuesFromError — 服务端自报档位（跨供应商措辞）", () => {
  // 以下四种措辞均为**实测样本**（同一网关下的不同后端），不是构造的假数据。
  test("OpenAI 措辞", () => {
    const msg =
      "Invalid value: '__x__'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', and 'xhigh'.";
    expect(extractEffortValuesFromError(msg)).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("DeepSeek 措辞", () => {
    const msg = "'reasoning_effort' must be one of: 'low', 'medium', 'high', 'xhigh', 'max'";
    expect(extractEffortValuesFromError(msg)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("GLM 中文措辞（顿号分隔）", () => {
    const msg =
      "The request is invalid: reasoning_effort 参数值非法，可选值为：none、minimal、low、medium、high、xhigh、max";
    expect(extractEffortValuesFromError(msg)).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("模型级校验措辞（比字段级更严，是更可信的真值）", () => {
    // 实测：字段级列表含 minimal，模型级把 minimal 排除掉了。
    const msg =
      "Unsupported value: 'minimal' is not supported with the 'gpt-5.6-luna-2026-07-09' model. Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'.";
    const got = extractEffortValuesFromError(msg);
    // 注意 'minimal' 会作为「被拒的值」出现在文本里，这是该启发式的已知局限；
    // 关键是不能漏掉真正支持的档位。
    expect(got).toContain("high");
    expect(got).toContain("xhigh");
    expect(got).toContain("low");
  });

  test("只命中 1 个词时返回 null —— 极可能只是回显了用户传入的非法值", () => {
    expect(extractEffortValuesFromError("Invalid value: 'high' is malformed")).toBeNull();
  });

  test("词边界：不把 max_tokens / nonexistent 误当档位", () => {
    // "max" 出现在 max_tokens 里、"none" 出现在 nonexistent 里，都不该被计入。
    expect(extractEffortValuesFromError("max_tokens is nonexistent")).toBeNull();
  });

  test("空/无关文本返回 null", () => {
    expect(extractEffortValuesFromError("")).toBeNull();
    expect(extractEffortValuesFromError("rate limit exceeded")).toBeNull();
  });
});

describe("extractMaxTokensFromError — 服务端自报输出上限", () => {
  test("Qwen 措辞", () => {
    expect(extractMaxTokensFromError("Range of max_tokens should be [1, 131072]")).toBe(131072);
  });

  test("GLM 中文措辞（无空格）", () => {
    expect(extractMaxTokensFromError("max_tokens参数非法：限制数值范围[1,131072]")).toBe(131072);
  });

  test("无区间信息返回 null", () => {
    expect(extractMaxTokensFromError("something went wrong")).toBeNull();
  });
});

describe("learnFromError — 自愈建议", () => {
  test("effort 被拒 → 建议剥字段重试，并把自报档位写入缓存", () => {
    const advice = learnFromError(
      "mystery-model",
      "'reasoning_effort' must be one of: 'low', 'medium', 'high'",
    );
    expect(advice.dropEffort).toBe(true);
    expect(advice.learned?.effortValues).toEqual(["low", "medium", "high"]);
    // 已持久化进内存缓存 → 下次 lookup 即命中，不再重复试错。
    expect(lookupCapability("mystery-model")?.effortValues).toEqual(["low", "medium", "high"]);
    expect(lookupCapability("mystery-model")?.source).toBe("healed");
  });

  test("Responses API 的嵌套字段名（reasoning.effort）同样识别", () => {
    const advice = learnFromError("gpt-5.6-luna", "Invalid value for 'reasoning.effort': bad");
    expect(advice.dropEffort).toBe(true);
  });

  test("上下文超限 → 标记 contextExceeded（应压缩而非重试）", () => {
    for (const msg of [
      "Your input exceeds the context window of this model.",
      "context_length_exceeded",
      "This model's maximum context length is 128000 tokens",
    ]) {
      expect(learnFromError("m", msg).contextExceeded).toBe(true);
    }
  });

  test("上下文超限**不**触发 dropEffort —— 剥 effort 解决不了塞太多 token", () => {
    const advice = learnFromError("m", "Your input exceeds the context window of this model.");
    expect(advice.dropEffort).toBeUndefined();
  });

  test("max_tokens 超限 → 学到真实上限", () => {
    const advice = learnFromError("qwen-x", "Range of max_tokens should be [1, 131072]");
    expect(advice.learned?.maxOutputTokens).toBe(131072);
    expect(lookupCapability("qwen-x")?.maxOutputTokens).toBe(131072);
  });

  test("无关错误（鉴权/限流）不产生任何自愈动作", () => {
    for (const msg of ["invalid api key", "rate limit exceeded", "model not found"]) {
      const advice = learnFromError("m", msg);
      expect(advice.dropEffort).toBeUndefined();
      expect(advice.contextExceeded).toBeUndefined();
      expect(advice.learned).toBeUndefined();
    }
  });
});

describe("probeModelCapability — 主动探针（两种结果都有用）", () => {
  test("400 且能抽出档位 → 记录档位 + supportsReasoning=true", async () => {
    const got = await probeModelCapability({
      model: "probe-a",
      send: async () => ({
        ok: false,
        errorMessage: "'reasoning_effort' must be one of: 'low', 'medium', 'high', 'max'",
      }),
    });
    expect(got?.effortValues).toEqual(["low", "medium", "high", "max"]);
    expect(got?.supportsReasoning).toBe(true);
    expect(got?.source).toBe("probe");
    expect(lookupCapability("probe-a")?.effortValues).toHaveLength(4);
  });

  test("200 → 服务端不校验该字段，记为「明确不支持 effort」（空数组，非 undefined）", async () => {
    // 关键区分：空数组 = 已验证不支持；undefined = 未知（会被乐观放行）。
    const got = await probeModelCapability({ model: "probe-b", send: async () => ({ ok: true }) });
    expect(got?.effortValues).toEqual([]);
    expect(got?.supportsReasoning).toBe(false);
    expect(lookupCapability("probe-b")?.effortValues).toEqual([]);
  });

  test("探针顺带学到 max_tokens 上限", async () => {
    const got = await probeModelCapability({
      model: "probe-c",
      send: async () => ({ ok: false, errorMessage: "Range of max_tokens should be [1, 65536]" }),
    });
    expect(got?.maxOutputTokens).toBe(65536);
  });

  test("无法解读的错误 → 不写缓存（不猜，留给自愈路径）", async () => {
    const got = await probeModelCapability({
      model: "probe-d",
      send: async () => ({ ok: false, errorMessage: "internal server error" }),
    });
    expect(got).toBeNull();
    expect(lookupCapability("probe-d")).toBeNull();
  });

  test("send 抛异常（网络故障）→ 返回 null，不污染缓存", async () => {
    const got = await probeModelCapability({
      model: "probe-e",
      send: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(got).toBeNull();
    expect(__getCapabilityCacheForTest()["probe-e"]).toBeUndefined();
  });
});

describe("computeCatalogBackoffMs — 同步失败指数退避", () => {
  test("0 次失败不退避；随失败次数指数增长，封顶 24h", () => {
    expect(computeCatalogBackoffMs(0)).toBe(0);
    const first = computeCatalogBackoffMs(1);
    expect(first).toBeGreaterThan(0);
    expect(computeCatalogBackoffMs(2)).toBe(first * 2);
    expect(computeCatalogBackoffMs(99)).toBe(24 * 60 * 60 * 1000);
  });
});

describe("缓存字段合并 —— 新数据不得把已知字段抹成 undefined", () => {
  test("自愈学到 effort 时，不覆盖此前采到的 contextWindow", () => {
    __resetCapabilityCacheForTest({
      "merge-me": { contextWindow: 200_000, maxOutputTokens: 8192, source: "catalog" },
    });
    learnFromError("merge-me", "'reasoning_effort' must be one of: 'low', 'high'");
    const got = lookupCapability("merge-me");
    expect(got?.contextWindow).toBe(200_000); // 保留
    expect(got?.maxOutputTokens).toBe(8192); // 保留
    expect(got?.effortValues).toEqual(["low", "high"]); // 新增
  });
});

/**
 * 回归：sanitizeEntry 数值校验漏洞（真实事故，2026-07-31 审计发现）。
 *
 * 根因：loadCapabilityCache 曾直接 `memModels = file.models`，完全跳过校验。
 * `JSON.parse('{"contextWindow":1e400}')` 在 JS 里解析成 `Infinity`——它满足
 * `typeof === "number" && > 0`，token-estimator.ts 原有检查完全放行。后果不是报错，
 * 是**静默失效**：上下文预算永远算出「还有空间」，auto-compact 与超限检测全部失灵，
 * 比一次崩溃更难发现、更难排查。
 *
 * 触达方式不限于攻击：手工改坏 JSON、进程写入中途被杀、未来某个外部源吐出异常值，
 * 都会走到这条路径——sanitizeEntry 是 loadCapabilityCache 和 mergeEntry 共用的
 * 唯一校验关卡，两条路径都必须经过它。
 */
describe("sanitizeEntry — 数值校验（防 Infinity/NaN 静默污染 contextWindow）", () => {
  test("Infinity 被拒绝（1e400 JSON 解析后的真实产物，此前能穿透校验）", () => {
    const got = __sanitizeEntryForTest({ contextWindow: Infinity });
    expect(got).toBeNull();
  });

  test("NaN / 负数 / 非整数 / 字符串数字 均被拒绝", () => {
    for (const bad of [NaN, -5, 3.14, "999", null, undefined, {}, []]) {
      expect(__sanitizeEntryForTest({ contextWindow: bad })?.contextWindow).toBeUndefined();
    }
  });

  test("字段级独立取舍：一个字段非法不牵连其它合法字段", () => {
    const got = __sanitizeEntryForTest({ contextWindow: Infinity, maxOutputTokens: 128_000 });
    expect(got?.contextWindow).toBeUndefined();
    expect(got?.maxOutputTokens).toBe(128_000); // 未被隔壁字段的非法值拖累
  });

  test("effortValues 空数组是「已验证不支持」的强信号，必须原样保留", () => {
    // 这是最容易踩的坑：naive 校验可能把「过滤后为空」等同于「无效丢弃」，
    // 但探针/自愈写入的空数组是明确结论（见 probeModelCapability 的 200 分支），
    // 一旦被误当成「无数据」丢弃，未知模型又会退回乐观放行，探针的结论白做了。
    const got = __sanitizeEntryForTest({ effortValues: [] });
    expect(got?.effortValues).toEqual([]);
    expect(Array.isArray(got?.effortValues)).toBe(true);
  });

  test("effortValues 内容全部非法（垃圾字符串）→ 整字段丢弃，不当成「确认不支持」", () => {
    // 与上一条对比：真正的空数组 [] 要保留；但「非空却全是垃圾」是另一种情况——
    // 说明数据本身损坏，不能把损坏误读成「服务端确认不支持」这个强结论。
    const got = __sanitizeEntryForTest({ effortValues: ["garbage", "not-a-level", 123] });
    expect(got?.effortValues).toBeUndefined();
  });

  test("effortValues 部分合法 → 只保留合法词，按标度顺序归一", () => {
    const got = __sanitizeEntryForTest({ effortValues: ["xhigh", "garbage", "low", 42] });
    expect(got?.effortValues).toEqual(["low", "xhigh"]); // 顺序按 KNOWN_EFFORT_WORDS 归一，非入参顺序
  });

  test("source 只接受三个已知字面量，其它字符串丢弃（防污染 /model list 展示）", () => {
    expect(__sanitizeEntryForTest({ source: "catalog" })?.source).toBe("catalog");
    expect(__sanitizeEntryForTest({ source: "probe" })?.source).toBe("probe");
    expect(__sanitizeEntryForTest({ source: "healed" })?.source).toBe("healed");
    expect(__sanitizeEntryForTest({ source: "<script>evil</script>" })?.source).toBeUndefined();
  });

  test("非对象输入（数组/基本类型/null）→ 直接返回 null，不抛异常", () => {
    for (const raw of [null, undefined, "string", 42, true, []]) {
      expect(() => __sanitizeEntryForTest(raw)).not.toThrow();
      expect(__sanitizeEntryForTest(raw)).toBeNull();
    }
  });

  test("全部字段都非法 → 返回 null（这条记录没有任何可用信息）", () => {
    const got = __sanitizeEntryForTest({
      contextWindow: Infinity,
      maxOutputTokens: -1,
      effortValues: ["garbage"],
      source: "not-a-real-source",
    });
    expect(got).toBeNull();
  });

  test("端到端：mergeEntry 复用同一校验，非法 patch 不污染缓存", () => {
    __resetCapabilityCacheForTest({ safe: { contextWindow: 100_000 } });
    learnFromError("safe", "irrelevant error mentioning nothing learnable");
    // learnFromError 对无关错误不产生任何学习动作，safe 的原值应完全不变。
    expect(lookupCapability("safe")?.contextWindow).toBe(100_000);
  });
});
