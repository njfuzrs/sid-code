/**
 * ModelConfig.compat 布尔位 —— 归一化、三处族判定接线、以及**必须保留的旧行为**。
 *
 * 这个文件锁三类不变量，第三类最容易在后续重构里被无声破掉：
 *
 * 1. **归一化的容错**：脏值一律丢弃且不抛（本函数在 loadConfig 链上，抛出即进程起不来）。
 * 2. **compat 优先于内置判定**，且**只覆盖声明了的位**（`undefined` ≠ `false`）。
 * 3. **不配 compat 时行为与此前逐字节相同** —— 这是「纯增量」这个说法唯一的实证判据。
 *    另含一条防漂移断言：`withCapabilityHealing` 必须仍然在（PR 正文承诺不删它）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  normalizeModelCompat,
  setModelCompat,
  lookupModelCompat,
  resetModelCompat,
  buildModelCompatMap,
  exportModelCompat,
  setModelCompatFromMap,
  MODEL_COMPAT_KEYS,
} from "@sid-code/core/llm/model-compat.ts";
import { resolveEffortCapability } from "@sid-code/core/llm/effort.ts";
import { OpenAIProvider } from "@sid-code/core/llm/openai.ts";

// 进程级表是全局态，每个用例前后都清干净，避免跨用例串味（同 resetWireModelAliases 口径）。
beforeEach(() => resetModelCompat());
afterEach(() => resetModelCompat());

class TestableProvider extends OpenAIProvider {
  applyThinking(params: any, model: string) {
    const body: any = {};
    (this as any).applyDeepSeekThinking(body, params, model);
    return body;
  }
  applyTools(params: any, model: string) {
    const body: any = {};
    (this as any).applyToolChoice(body, params, model);
    return body;
  }
  requiresReasoningContent(model: string, alias?: string): boolean {
    return (this as any).requiresReasoningContentForToolCalls(model, alias);
  }
}

describe("normalizeModelCompat：脏值一律丢弃且不抛", () => {
  test("非对象输入全部返回 undefined（不抛）", () => {
    for (const bad of [null, undefined, "true", 123, [], [{ a: 1 }], false]) {
      expect(() => normalizeModelCompat(bad)).not.toThrow();
      expect(normalizeModelCompat(bad)).toBeUndefined();
    }
  });

  test("字符串 'false' 刻意不做真值转换，直接丢弃", () => {
    // 两个方向猜错的后果相反（多发字段 400 / 该发的没发静默失效），故一律不猜。
    expect(normalizeModelCompat({ supportsToolChoice: "false" })).toBeUndefined();
    expect(normalizeModelCompat({ supportsToolChoice: 0 })).toBeUndefined();
  });

  test("未知键丢弃，合法键保留", () => {
    const out = normalizeModelCompat({
      supportsToolChoice: false,
      supportsSomethingWeNeverImplemented: true,
    });
    expect(out).toEqual({ supportsToolChoice: false });
  });

  test("snake_case 与 camelCase 两种写法都认，且值相同", () => {
    const snake = normalizeModelCompat({ supports_thinking_toggle: false });
    const camel = normalizeModelCompat({ supportsThinkingToggle: false });
    expect(snake).toEqual({ supportsThinkingToggle: false });
    expect(snake).toEqual(camel!);
  });

  test("全部 6 个字段的 snake_case 写法都能命中（漏一个就是用户配了却被静默丢弃）", () => {
    // 用键清单反推 snake_case，避免这里手写第二份清单跟着漂移。
    for (const key of MODEL_COMPAT_KEYS) {
      const snake = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
      const out = normalizeModelCompat({ [snake]: true });
      expect(out, `snake_case 键 ${snake} 未被识别`).toEqual({ [key]: true });
    }
  });

  test("只有非法字段时返回 undefined 而非空对象", () => {
    // 空对象会让下游 `compat ? ... : ...` 误判为「有声明」。
    expect(normalizeModelCompat({ nope: 1 })).toBeUndefined();
  });
});

describe("setModelCompat / lookupModelCompat：按渠道别名建键", () => {
  test("按 name（别名）而非 modelId 查得到", () => {
    setModelCompat([{ name: "gw-deepseek", compat: { supportsToolChoice: false } } as any]);
    expect(lookupModelCompat("gw-deepseek")).toEqual({ supportsToolChoice: false });
    expect(lookupModelCompat("deepseek-chat")).toBeUndefined();
  });

  test("同名多条保留第一条（与选择侧 find-first 同语义）", () => {
    setModelCompat([
      { name: "dup", compat: { supportsMaxEffort: false } },
      { name: "dup", compat: { supportsMaxEffort: true } },
    ] as any);
    expect(lookupModelCompat("dup")).toEqual({ supportsMaxEffort: false });
  });

  test("传空/undefined 即清空（否则旧声明残留会让新配置按旧声明发字段）", () => {
    setModelCompat([{ name: "m", compat: { supportsToolChoice: false } }] as any);
    expect(lookupModelCompat("m")).toBeDefined();
    setModelCompat();
    expect(lookupModelCompat("m")).toBeUndefined();
    setModelCompat([{ name: "m", compat: { supportsToolChoice: false } }] as any);
    setModelCompat([]);
    expect(lookupModelCompat("m")).toBeUndefined();
  });

  test("脏 name（数字/null/空白）不入表且不抛", () => {
    expect(() =>
      setModelCompat([
        { name: 123, compat: { supportsToolChoice: false } },
        { name: null, compat: { supportsToolChoice: false } },
        { name: "   ", compat: { supportsToolChoice: false } },
      ] as any),
    ).not.toThrow();
    expect(exportModelCompat()).toBeUndefined();
  });

  test("没配 compat 的条目不入表（空表短路，零开销）", () => {
    setModelCompat([{ name: "plain" }, { name: "plain2", compat: {} }] as any);
    expect(exportModelCompat()).toBeUndefined();
    expect(lookupModelCompat("plain")).toBeUndefined();
  });
});

describe("跨进程播种：export / setFromMap / buildMap 三者口径一致", () => {
  test("export → setFromMap 往返后查得到同样的声明", () => {
    setModelCompat([{ name: "a", compat: { supportsThinkingToggle: false } }] as any);
    const exported = exportModelCompat();
    expect(exported).toEqual({ a: { supportsThinkingToggle: false } });

    resetModelCompat();
    setModelCompatFromMap(exported);
    expect(lookupModelCompat("a")).toEqual({ supportsThinkingToggle: false });
  });

  test("setFromMap 对脏 payload 容错（老版本父进程 / 手工构造的 init）", () => {
    expect(() => setModelCompatFromMap({ a: "not-an-object", b: null } as any)).not.toThrow();
    expect(lookupModelCompat("a")).toBeUndefined();
    expect(() => setModelCompatFromMap("garbage" as any)).not.toThrow();
    expect(() => setModelCompatFromMap([] as any)).not.toThrow();
  });

  test("buildModelCompatMap 不读也不写全局表（不依赖调用时序）", () => {
    const built = buildModelCompatMap([
      { name: "x", compat: { supports_max_effort: false } },
    ] as any);
    expect(built).toEqual({ x: { supportsMaxEffort: false } });
    // 关键：构造过程没有污染全局表。
    expect(lookupModelCompat("x")).toBeUndefined();
  });

  test("空列表返回 undefined（便于直接塞进可选协议字段，管道零多余字节）", () => {
    expect(buildModelCompatMap([])).toBeUndefined();
    expect(buildModelCompatMap(undefined)).toBeUndefined();
    expect(buildModelCompatMap([{ name: "n" }] as any)).toBeUndefined();
  });
});

describe("接线①：effort.ts resolveEffortCapability 读 compat", () => {
  const OPTS = { model: "deepseek-chat", provider: "openai", alias: "gw-ds" };

  test("不配 compat → 能力描述符与此前完全一致（纯增量的实证）", () => {
    const withoutTable = resolveEffortCapability({ ...OPTS });
    setModelCompat([{ name: "other-model", compat: { supportsMaxEffort: false } }] as any);
    const withUnrelatedTable = resolveEffortCapability({ ...OPTS });
    expect(withUnrelatedTable.supportsEffort).toBe(withoutTable.supportsEffort);
    expect(withUnrelatedTable.supportsMaxEffort).toBe(withoutTable.supportsMaxEffort);
    expect(withUnrelatedTable.supportsThinkingToggle).toBe(withoutTable.supportsThinkingToggle);
  });

  test("supportsReasoningEffort:false → 标志位与线上字段**同时**关掉", () => {
    const before = resolveEffortCapability({ ...OPTS });
    expect(before.supportsEffort).toBe(true); // 前提：DeepSeek 本来支持

    setModelCompat([{ name: "gw-ds", compat: { supportsReasoningEffort: false } }] as any);
    const cap = resolveEffortCapability({ ...OPTS });
    expect(cap.supportsEffort).toBe(false);

    // 只改标志位不改 applier 是本仓「开关改了链路没改」的经典形态：UI 说不支持、请求体照发。
    const params: any = {};
    cap.applyToSendParams(params, "high", true);
    expect(params.reasoningEffort).toBeUndefined();
  });

  test("supportsThinkingToggle:false → 不下发 thinking，且 thinkingDefaultOn 一并置 false", () => {
    setModelCompat([{ name: "gw-ds", compat: { supportsThinkingToggle: false } }] as any);
    const cap = resolveEffortCapability({ ...OPTS });
    expect(cap.supportsThinkingToggle).toBe(false);
    // 否则状态栏显示「思考默认开」却没有开关字段下发，是同一句话的两个矛盾说法。
    expect(cap.thinkingDefaultOn).toBe(false);

    const params: any = {};
    cap.applyToSendParams(params, "high", true);
    expect(params.thinking).toBeUndefined();
  });

  test("supportsMaxEffort:false → max 钳到 high（不是丢弃）", () => {
    setModelCompat([{ name: "gw-ds", compat: { supportsMaxEffort: false } }] as any);
    const cap = resolveEffortCapability({ ...OPTS });
    expect(cap.supportsMaxEffort).toBe(false);

    const params: any = {};
    cap.applyToSendParams(params, "max", true);
    // DeepSeek applier 把非 max 档一律映射到 high；关键是**没有**发出 max。
    expect(params.reasoningEffort).toBe("high");
  });

  test("只声明一位时，其余位不受影响（undefined ≠ false）", () => {
    const baseline = resolveEffortCapability({ ...OPTS });
    setModelCompat([{ name: "gw-ds", compat: { supportsMaxEffort: false } }] as any);
    const cap = resolveEffortCapability({ ...OPTS });
    expect(cap.supportsEffort).toBe(baseline.supportsEffort);
    expect(cap.supportsThinkingToggle).toBe(baseline.supportsThinkingToggle);
  });

  test("alias 缺省时退化为按 model 查（没配 modelId 的绝大多数情况）", () => {
    setModelCompat([{ name: "deepseek-chat", compat: { supportsMaxEffort: false } }] as any);
    const cap = resolveEffortCapability({ model: "deepseek-chat", provider: "openai" });
    expect(cap.supportsMaxEffort).toBe(false);
  });

  test("alias 与真名不同时按 alias 生效 —— 同一真名的两个渠道声明可以不同", () => {
    setModelCompat([
      { name: "ds-official", compat: { supportsThinkingToggle: true } },
      { name: "ds-gateway", compat: { supportsThinkingToggle: false } },
    ] as any);
    const official = resolveEffortCapability({
      model: "deepseek-chat",
      provider: "openai",
      alias: "ds-official",
    });
    const gateway = resolveEffortCapability({
      model: "deepseek-chat",
      provider: "openai",
      alias: "ds-gateway",
    });
    expect(official.supportsThinkingToggle).toBe(true);
    expect(gateway.supportsThinkingToggle).toBe(false);
  });

  test("compat 也覆盖 supportsThinking:false 这条既有 early-return 路径", () => {
    setModelCompat([{ name: "gw-ds", compat: { supportsMaxEffort: true } }] as any);
    const cap = resolveEffortCapability({
      ...OPTS,
      modelConfig: { supportsThinking: false },
    });
    // 用户既声明了不支持思考、又声明了支持 max：两者不冲突（一个管 thinking、一个管档位）。
    expect(cap.supportsThinkingToggle).toBe(false);
    expect(cap.supportsMaxEffort).toBe(true);
  });

  test("Anthropic 族的 outputConfig.effort 这条线也被剥掉（不只剥 reasoningEffort）", () => {
    setModelCompat([{ name: "ds-anth", compat: { supportsReasoningEffort: false } }] as any);
    const cap = resolveEffortCapability({
      model: "deepseek-chat",
      provider: "anthropic",
      baseURL: "https://api.deepseek.com/anthropic",
      alias: "ds-anth",
    });
    const params: any = {};
    cap.applyToSendParams(params, "high", true);
    expect(params.reasoningEffort).toBeUndefined();
    // 同一语义两条线，只堵一条就是漏。
    expect(params.outputConfig?.effort).toBeUndefined();
  });
});

describe("接线②：openai.ts applyDeepSeekThinking 读 compat", () => {
  const provider = new TestableProvider("k", "deepseek-chat");

  test("不配 compat → 请求体与此前完全一致", () => {
    const body = provider.applyThinking(
      { model: "deepseek-chat", reasoningEffort: "high", thinking: { enabled: true } },
      "deepseek-chat",
    );
    expect(body.reasoning_effort).toBe("high");
    expect(body.thinking).toEqual({ type: "enabled" });
  });

  test("supportsReasoningEffort:false → 不发 reasoning_effort，但 user_id 仍下发", () => {
    setModelCompat([{ name: "ds", compat: { supportsReasoningEffort: false } }] as any);
    const body = provider.applyThinking(
      {
        model: "ds",
        reasoningEffort: "high",
        thinking: { enabled: true },
        userId: "u1",
      },
      "deepseek-chat",
    );
    expect(body.reasoning_effort).toBeUndefined();
    // early-return 整个函数会把不相关的通用字段一起关掉 —— 这条断言就是防那个。
    expect(body.user_id).toBe("u1");
    expect(body.thinking).toEqual({ type: "enabled" });
  });

  test("supportsThinkingToggle:false → 不发 thinking，但 effort 照发", () => {
    setModelCompat([{ name: "ds", compat: { supportsThinkingToggle: false } }] as any);
    const body = provider.applyThinking(
      { model: "ds", reasoningEffort: "high", thinking: { enabled: true } },
      "deepseek-chat",
    );
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_effort).toBe("high");
  });

  test("supportsMaxEffort:false → max 钳成 high 发出去（这里是所有请求的唯一咽喉）", () => {
    setModelCompat([{ name: "ds", compat: { supportsMaxEffort: false } }] as any);
    const body = provider.applyThinking(
      { model: "ds", reasoningEffort: "max", thinking: { enabled: true } },
      "deepseek-chat",
    );
    expect(body.reasoning_effort).toBe("high");
  });

  test("对未知族同样生效（自愈闭环入口那一支）", () => {
    setModelCompat([{ name: "mystery", compat: { supportsReasoningEffort: false } }] as any);
    const body = provider.applyThinking(
      { model: "mystery", reasoningEffort: "high" },
      "some-unregistered-model-v9",
    );
    // 声明了就不必再靠 400 学 —— 代价（关掉该模型的自愈探路）是刻意接受的。
    expect(body.reasoning_effort).toBeUndefined();
  });

  test("对 Grok 族同样生效（此前 max 守卫是硬编码的）", () => {
    setModelCompat([{ name: "gk", compat: { supportsReasoningEffort: false } }] as any);
    const body = provider.applyThinking({ model: "gk", reasoningEffort: "high" }, "grok-4");
    expect(body.reasoning_effort).toBeUndefined();
  });
});

describe("接线③：openai.ts applyToolChoice 读 compat", () => {
  const provider = new TestableProvider("k", "gpt-4o-mini");

  test("不配 compat → tool_choice 照常下发", () => {
    const body = provider.applyTools(
      { model: "gpt-4o-mini", toolChoice: "required" },
      "gpt-4o-mini",
    );
    expect(body.tool_choice).toBe("required");
  });

  test("supportsToolChoice:false → 不下发（保留模型自主调用）", () => {
    setModelCompat([{ name: "m", compat: { supportsToolChoice: false } }] as any);
    const body = provider.applyTools({ model: "m", toolChoice: "required" }, "gpt-4o-mini");
    expect(body.tool_choice).toBeUndefined();
  });

  test("toolChoiceAutoOnly:true → 非 auto 降级为不下发，auto 仍通过", () => {
    setModelCompat([{ name: "m", compat: { toolChoiceAutoOnly: true } }] as any);
    expect(
      provider.applyTools({ model: "m", toolChoice: "required" }, "gpt-4o-mini").tool_choice,
    ).toBeUndefined();
    expect(provider.applyTools({ model: "m", toolChoice: "auto" }, "gpt-4o-mini").tool_choice).toBe(
      "auto",
    );
  });

  test("supportsToolChoice:true 覆盖 DeepSeek 思考模式的按族拦截", () => {
    // 不配 compat 时：DeepSeek 思考模式下按族推导拦掉（既有行为，先锁住）。
    const blocked = provider.applyTools(
      { model: "deepseek-chat", toolChoice: "required", thinking: { enabled: true } },
      "deepseek-chat",
    );
    expect(blocked.tool_choice).toBeUndefined();

    // 显式声明支持 → 放行。用户的网关可能已经替他过滤/转换了该字段。
    setModelCompat([{ name: "deepseek-chat", compat: { supportsToolChoice: true } }] as any);
    const allowed = provider.applyTools(
      { model: "deepseek-chat", toolChoice: "required", thinking: { enabled: true } },
      "deepseek-chat",
    );
    expect(allowed.tool_choice).toBe("required");
  });

  test("toolChoiceAutoOnly:false 覆盖 GLM 的 auto-only 降级", () => {
    const blocked = provider.applyTools({ model: "glm-4.6", toolChoice: "required" }, "glm-4.6");
    expect(blocked.tool_choice).toBeUndefined();

    setModelCompat([{ name: "glm-4.6", compat: { toolChoiceAutoOnly: false } }] as any);
    const allowed = provider.applyTools({ model: "glm-4.6", toolChoice: "required" }, "glm-4.6");
    expect(allowed.tool_choice).toBe("required");
  });

  test("parallel_tool_calls 不受 compat 影响（不相关能力不连带关掉）", () => {
    setModelCompat([{ name: "m", compat: { supportsToolChoice: false } }] as any);
    const body = provider.applyTools(
      { model: "m", toolChoice: "required", parallelToolCalls: true },
      "gpt-4o-mini",
    );
    expect(body.tool_choice).toBeUndefined();
    expect(body.parallel_tool_calls).toBe(true);
  });
});

describe("接线④：requiresReasoningContentForToolCalls 的用户覆盖", () => {
  const provider = new TestableProvider("k", "deepseek-chat");

  test("私有网关上的私有模型名：注册表 miss → compat 救回来", () => {
    // 注册表按名匹配不到这种名字，默认 false —— 而 V4 thinking 系漏回传会 400 + 思维链断裂。
    expect(provider.requiresReasoningContent("gw-internal-r1")).toBe(false);
    setModelCompat([
      { name: "gw-r1", compat: { requiresReasoningContentForToolCalls: true } },
    ] as any);
    expect(provider.requiresReasoningContent("gw-internal-r1", "gw-r1")).toBe(true);
  });

  test("反方向也能覆盖：注册表说 true，用户声明 false", () => {
    // 前提断言：deepseek-v4-pro 在 model-registry 里确实是 true。少了这一句，
    // 万一模型名写错（注册表 miss → 默认 false），下面就变成 false vs false 的空断言 ——
    // 实测这个坑真踩到了，变异测试才暴露出来。
    expect(provider.requiresReasoningContent("deepseek-v4-pro")).toBe(true);

    setModelCompat([
      { name: "ds-old", compat: { requiresReasoningContentForToolCalls: false } },
    ] as any);
    expect(provider.requiresReasoningContent("deepseek-v4-pro", "ds-old")).toBe(false);
  });

  test("未声明时回落注册表（不改既有行为）", () => {
    setModelCompat([{ name: "ds", compat: { supportsToolChoice: false } }] as any);
    const withCompat = provider.requiresReasoningContent("deepseek-chat", "ds");
    resetModelCompat();
    expect(withCompat).toBe(provider.requiresReasoningContent("deepseek-chat"));
  });
});

describe("防漂移：compat 不得替代 400 自愈路径", () => {
  test("withCapabilityHealing 仍在 OpenAIProvider 上", async () => {
    // PR 正文承诺「compat 只是先验，自愈修正先验，两者互补」。有人日后觉得
    // 「有了 compat 就不需要自愈了」而删掉它，这条断言会红。
    expect(typeof (OpenAIProvider.prototype as any).withCapabilityHealing).toBe("function");

    const src = await Bun.file(new URL("../../src/llm/openai.ts", import.meta.url).pathname).text();
    expect(src).toContain("yield* this.withCapabilityHealing(params, signal)");
  });
});
