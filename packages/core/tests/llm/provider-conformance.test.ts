/**
 * Provider 层一致性测试矩阵 — provider-conformance.test.ts
 *
 * 覆盖方案 §8 要求的核心测试场景：
 * - stream-guard 集成测试
 * - model-capability-filter 参数过滤测试
 * - guardOutgoingMessages 协议校验测试
 * - effort.ts classifyCapability 与 catalog protocolKind 整合测试
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { __resetCapabilityCacheForTest } from "@sid-code/core/llm/model-capabilities.ts";
import { guardedStream } from "@sid-code/core/llm/stream-guard.ts";
import { filterParamsForModel } from "@sid-code/core/llm/model-capability-filter.ts";
import { lookupCatalog } from "@sid-code/core/llm/model-params-catalog.ts";
import { resolveEffortCapability } from "@sid-code/core/llm/effort.ts";

// ─── stream-guard.ts 测试 ───────────────────────────────────────────────

describe("stream-guard", () => {
  /** 辅助：创建一个可控的 async iterable */
  async function* makeStream<T>(items: T[], delayMs = 0): AsyncGenerator<T> {
    for (const item of items) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      yield item;
    }
  }

  test("正常流：所有事件透传且统计正确", async () => {
    const events = ["a", "b", "c"];
    const collected: string[] = [];
    let completedEvent: any = null;

    const guarded = guardedStream(makeStream(events), {
      idleTimeoutMs: 5000,
      stallWarnMs: 3000,
      label: "TEST",
      onTelemetry: (evt) => {
        if (evt.type === "stream_completed") completedEvent = evt;
      },
    });

    for await (const event of guarded) {
      collected.push(event);
    }

    expect(collected).toEqual(["a", "b", "c"]);
    expect(completedEvent).not.toBeNull();
    expect(completedEvent.totalEvents).toBe(3);
    expect(completedEvent.provider).toBe("test");
  });

  test("空流：zero events，stream_completed 正确触发", async () => {
    let completedEvent: any = null;

    const guarded = guardedStream(makeStream([]), {
      idleTimeoutMs: 5000,
      label: "EMPTY",
      onTelemetry: (evt) => {
        if (evt.type === "stream_completed") completedEvent = evt;
      },
    });

    const collected: any[] = [];
    for await (const event of guarded) {
      collected.push(event);
    }

    expect(collected).toEqual([]);
    expect(completedEvent).not.toBeNull();
    expect(completedEvent.totalEvents).toBe(0);
    expect(completedEvent.ttftMs).toBeUndefined();
  });

  test("idle timeout 触发 onTimeout 回调", async () => {
    let timeoutCalled = false;
    let timeoutEvent: any = null;
    const abortCtl = new AbortController();

    // 创建一个用 AbortSignal 可中断的慢流
    async function* abortableStream(signal: AbortSignal): AsyncGenerator<string> {
      yield "first";
      // 等待被 abort 或超时
      await new Promise((resolve, _reject) => {
        const onAbort = () => {
          resolve(undefined);
        };
        if (signal.aborted) {
          resolve(undefined);
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }

    const guarded = guardedStream(abortableStream(abortCtl.signal), {
      idleTimeoutMs: 100, // 100ms 超时
      stallWarnMs: 50,
      label: "TIMEOUT",
      onTimeout: () => {
        timeoutCalled = true;
        abortCtl.abort(); // 中断源流
      },
      onTelemetry: (evt) => {
        if (evt.type === "stream_idle_timeout") timeoutEvent = evt;
      },
    });

    const collected: string[] = [];
    for await (const event of guarded) {
      collected.push(event);
    }

    expect(collected).toEqual(["first"]);
    expect(timeoutCalled).toBe(true);
    expect(timeoutEvent).not.toBeNull();
    expect(timeoutEvent.timeoutMs).toBe(100);
  });

  test("stall 告警触发 onTelemetry stream_stall 事件", async () => {
    let stallEvent: any = null;

    async function* slowStream(): AsyncGenerator<string> {
      yield "fast";
      await new Promise((r) => setTimeout(r, 120)); // 超过 stallWarnMs
      yield "slow";
    }

    const guarded = guardedStream(slowStream(), {
      idleTimeoutMs: 5000,
      stallWarnMs: 80, // 80ms stall 告警
      label: "STALL",
      onTelemetry: (evt) => {
        if (evt.type === "stream_stall") stallEvent = evt;
      },
    });

    const collected: string[] = [];
    for await (const event of guarded) {
      collected.push(event);
    }

    expect(collected).toEqual(["fast", "slow"]);
    expect(stallEvent).not.toBeNull();
    expect(stallEvent.gapMs).toBeGreaterThanOrEqual(80);
  });
});

// ─── model-capability-filter.ts 测试 ────────────────────────────────────

describe("model-capability-filter", () => {
  test("o3: system → developer role", () => {
    const params: any = {
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hello" },
      ],
      max_tokens: 4096,
      temperature: 0.7,
    };

    filterParamsForModel("o3", params);

    expect(params.messages[0].role).toBe("developer");
    expect(params.messages[1].role).toBe("user");
  });

  test("o3: max_tokens → max_completion_tokens", () => {
    const params: any = {
      messages: [],
      max_tokens: 4096,
    };

    filterParamsForModel("o3", params);

    expect(params.max_completion_tokens).toBe(4096);
    expect(params.max_tokens).toBeUndefined();
  });

  test("o3: temperature/top_p 被删除", () => {
    const params: any = {
      messages: [],
      max_tokens: 4096,
      temperature: 0.7,
      top_p: 0.9,
    };

    filterParamsForModel("o3", params);

    expect(params.temperature).toBeUndefined();
    expect(params.top_p).toBeUndefined();
  });

  test("o3-mini: reasoning_effort max → high（钳制）", () => {
    const params: any = {
      messages: [],
      max_tokens: 4096,
      reasoning_effort: "max",
    };

    filterParamsForModel("o3-mini", params);

    expect(params.reasoning_effort).toBe("high");
  });

  test("o4-mini: 与 o3 同协议族", () => {
    const params: any = {
      messages: [{ role: "system", content: "test" }],
      max_tokens: 4096,
      temperature: 0.5,
      reasoning_effort: "low",
    };

    filterParamsForModel("o4-mini", params);

    expect(params.messages[0].role).toBe("developer");
    expect(params.max_completion_tokens).toBe(4096);
    expect(params.max_tokens).toBeUndefined();
    expect(params.temperature).toBeUndefined();
    expect(params.reasoning_effort).toBe("low"); // low 在支持列表中，不钳制
  });

  test("gpt-4o: 无特殊处理（标准参数透传）", () => {
    const params: any = {
      messages: [{ role: "system", content: "test" }],
      max_tokens: 4096,
      temperature: 0.7,
    };

    filterParamsForModel("gpt-4o", params);

    expect(params.messages[0].role).toBe("system"); // 不改
    expect(params.max_tokens).toBe(4096); // 不改
    expect(params.temperature).toBe(0.7); // 不改
  });

  test("未注册模型: 完全透传", () => {
    const params: any = {
      messages: [{ role: "system", content: "test" }],
      max_tokens: 4096,
      temperature: 0.7,
      reasoning_effort: "max",
    };

    filterParamsForModel("some-unknown-model", params);

    expect(params.messages[0].role).toBe("system");
    expect(params.max_tokens).toBe(4096);
    expect(params.temperature).toBe(0.7);
    expect(params.reasoning_effort).toBe("max");
  });

  test("DeepSeek 模型: 不声明 protocolKind，透传（由 runtime 处理）", () => {
    const params: any = {
      messages: [{ role: "system", content: "test" }],
      max_tokens: 4096,
      temperature: 0.7,
    };

    filterParamsForModel("deepseek-v4-pro", params);

    // DeepSeek 没声明 systemRole 等字段，不做转换
    expect(params.messages[0].role).toBe("system");
    expect(params.max_tokens).toBe(4096);
    expect(params.temperature).toBe(0.7);
  });
});

// ─── model-params-catalog.ts 协议能力字段测试 ────────────────────────────

describe("model-params-catalog — 协议能力字段", () => {
  test("o3 声明了完整的协议能力", () => {
    const entry = lookupCatalog("o3");
    expect(entry).not.toBeNull();
    expect(entry!.protocolKind).toBe("o-series");
    expect(entry!.systemRole).toBe("developer");
    expect(entry!.maxTokensField).toBe("max_completion_tokens");
    expect(entry!.supportsTemperature).toBe(false);
    expect(entry!.reasoningEffortValues).toEqual(["low", "medium", "high"]);
  });

  test("o1 声明了 o-series 协议", () => {
    const entry = lookupCatalog("o1");
    expect(entry).not.toBeNull();
    expect(entry!.protocolKind).toBe("o-series");
  });

  test("o4-mini 声明了 o-series 协议", () => {
    const entry = lookupCatalog("o4-mini");
    expect(entry).not.toBeNull();
    expect(entry!.protocolKind).toBe("o-series");
    expect(entry!.systemRole).toBe("developer");
  });

  test("claude-opus-4-8 声明了 anthropic-native 协议", () => {
    const entry = lookupCatalog("claude-opus-4-8");
    expect(entry).not.toBeNull();
    expect(entry!.protocolKind).toBe("anthropic-native");
    // Claude 不声明 systemRole 等 OpenAI 专有字段
    expect(entry!.systemRole).toBeUndefined();
  });

  test("deepseek-v4-pro 不声明 protocolKind（由 runtime 推断）", () => {
    const entry = lookupCatalog("deepseek-v4-pro");
    expect(entry).not.toBeNull();
    expect(entry!.protocolKind).toBeUndefined();
  });

  test("gpt-4o 不声明 protocolKind（标准模型无特殊处理）", () => {
    const entry = lookupCatalog("gpt-4o");
    expect(entry).not.toBeNull();
    expect(entry!.protocolKind).toBeUndefined();
  });
});

// ─── effort.ts classifyCapability 与 catalog 整合测试 ────────────────────

describe("effort.ts — catalog protocolKind 优先于 runtime 推断", () => {
  // 隔离真实能力缓存：未知模型分支会查 ~/.sid-code/model-capabilities.json，
  // 开发机同步过 2900+ 条真实数据后，断言结果会随磁盘状态漂移。见 effort.test.ts 同注释。
  beforeEach(() => {
    __resetCapabilityCacheForTest({});
  });

  test("o3 通过 catalog.protocolKind 识别为 o-series", () => {
    const cap = resolveEffortCapability({
      model: "o3",
      provider: "openai",
      baseURL: "https://api.openai.com",
    });
    expect(cap.supportsEffort).toBe(true);
    expect(cap.supportsMaxEffort).toBe(false); // o-series 无 max
    expect(cap.supportsThinkingToggle).toBe(false); // 内置推理
  });

  test("o4-mini 通过 catalog.protocolKind 识别为 o-series", () => {
    const cap = resolveEffortCapability({
      model: "o4-mini",
      provider: "openai",
      baseURL: "https://api.openai.com",
    });
    expect(cap.supportsEffort).toBe(true);
    expect(cap.supportsMaxEffort).toBe(false);
  });

  test("claude-opus-4-8 通过 catalog.protocolKind 识别为 anthropic-native", () => {
    const cap = resolveEffortCapability({
      model: "claude-opus-4-8",
      provider: "anthropic",
    });
    expect(cap.supportsEffort).toBe(true);
    expect(cap.supportsMaxEffort).toBe(true);
    expect(cap.supportsThinkingToggle).toBe(true);
    expect(cap.thinkingDefaultOn).toBe(false);
  });

  test("deepseek-v4-pro 无 catalog.protocolKind，走 runtime 推断 → deepseek-openai", () => {
    const cap = resolveEffortCapability({
      model: "deepseek-v4-pro",
      provider: "openai",
      baseURL: "https://api.deepseek.com",
    });
    expect(cap.supportsEffort).toBe(true);
    expect(cap.supportsMaxEffort).toBe(true);
    expect(cap.thinkingDefaultOn).toBe(true);
  });

  test("deepseek-v4-pro + Anthropic 端点 → deepseek-anthropic", () => {
    const cap = resolveEffortCapability({
      model: "deepseek-v4-pro",
      provider: "openai",
      baseURL: "https://proxy.example.com/anthropic/v1",
    });
    expect(cap.supportsEffort).toBe(true);
    expect(cap.thinkingDefaultOn).toBe(true);
  });

  // ⚠ 契约变更（原用例名「未知模型走 unknown 兜底」）：未知模型不再判「不支持 effort」。
  //
  // 旧行为下 /effort 对任何未注册模型直接报错，用户只能等注册表补条目——这是
  // 「出一个新模型改一次代码」的根源。新行为改为**乐观放行 + 400 自愈**：
  // 真发请求被拒时，withCapabilityHealing 剥掉 effort 字段重试并把结论写进能力缓存
  //（见 model-capabilities.ts）。thinking 开关仍保持不猜。
  test("未知模型：effort 乐观放行（可自愈），thinking 仍不猜", () => {
    const cap = resolveEffortCapability({
      model: "some-random-model",
      provider: "openai",
    });
    expect(cap.supportsEffort).toBe(true);
    expect(cap.supportsThinkingToggle).toBe(false);
    expect(cap.thinkingDefaultOn).toBe(false);
  });
});
