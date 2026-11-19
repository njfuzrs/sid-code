/**
 * D2 / D3 归因回归门禁 —— 「遥测里到底落盘了什么」。
 *
 * D2（fallback 事件的 `error` 恒为硬编码「主模型失败」）：实测 9/9 条 fallback
 * 事件全是同一句，回答不了「这 9 次分别因为什么降级」。本文件钉住：
 * `error` 带得回结构化证据、`querySource` 能归因到来源、`viaDecision` 能区分
 * 「用户手选」与「链路自救」、`attempts` 与 `recovery_give_up` 同口径。
 *
 * D3（6 类事件不带 `querySource`）：实测 29/29 条 `shared_cooldown_wait`、
 * 791 条 `retry` 都没有该字段。字段本身早就存在，只是调用点没传。
 *
 * 全部断言都必须在实现被改坏时变红 —— 不写「只要事件存在就算过」的伪断言。
 *
 * fix_type: regression_guard
 */

import { describe, test, expect } from "bun:test";
import { ModelFallback as RealModelFallback } from "@sid-code/core/llm/fallback.ts";
import { ModelAvailabilityService } from "@sid-code/core/llm/availability.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";
import type { RetryTelemetryEvent } from "@sid-code/core/llm/retry-telemetry.ts";

/**
 * 与 fallback.test.ts 同口径：本文件测的是「落了什么字段」，不测退避时长，
 * 所以缺省注入零退避，避免每条用例都真睡。
 */
class ModelFallback extends RealModelFallback {
  constructor(...args: ConstructorParameters<typeof RealModelFallback>) {
    const [cfg, listener] = args;
    super({ retryBackoffBaseMs: 0, retryBackoffMaxMs: 0, ...cfg }, listener);
  }
}

const defaultParams: SendParams = {
  model: "test-model",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 1024,
};

/** 固定成功流（scripted AsyncIterable），供 fallback 目标 provider 使用。 */
function successProvider(): Provider {
  return {
    name: () => "mock-success",
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      const scripted: StreamEvent[] = [
        { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { inputTokens: 10, outputTokens: 5 },
        },
        { type: "message_stop" },
      ];
      for (const e of scripted) yield e;
    },
  };
}

/** 每次调用都抛「连接阶段」503 的 provider（快速耗尽重试预算 → 进 fallback）。 */
function alwaysThrowProvider(): Provider {
  return {
    name: () => "mock-fail",
    // eslint-disable-next-line require-yield
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      throw new Error("503 Service Unavailable");
    },
  } as unknown as Provider;
}

/** 流内 yield 一次 429 error 的 provider（触发流式重试，供 `retry` 事件用例）。 */
function rateLimitedOnceProvider(counter: { n: number }): Provider {
  return {
    name: () => "mock-429",
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      counter.n++;
      if (counter.n === 1) {
        yield {
          type: "error",
          error: {
            message: "429 rate limit exceeded",
            type: "rate_limit_error",
            statusCode: 429,
            streamLevel: true,
          },
        } as unknown as StreamEvent;
        return;
      }
      yield* successProvider().sendMessageStream(defaultParams) as AsyncGenerator<StreamEvent>;
    },
  } as unknown as Provider;
}

async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  try {
    for await (const e of gen) out.push(e);
  } catch {
    /* 断言只看遥测副作用 */
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// D2：fallback 事件必须带得回根因
// ═══════════════════════════════════════════════════════════════════

describe("D2：fallback 事件归因", () => {
  const setup = async (perCall: Record<string, unknown>) => {
    const events: RetryTelemetryEvent[] = [];
    const onFallbackReasons: string[] = [];
    const fb = new ModelFallback(
      {
        fallbackProvider: successProvider(),
        fallbackModel: "fallback-model",
        onTelemetry: (e) => events.push(e),
      },
      {
        onFallback: (reason: string) => onFallbackReasons.push(reason),
      } as any,
    );
    await drain(
      fb.executeWithFallback(alwaysThrowProvider(), defaultParams, undefined, {
        switchMode: "auto",
        ...perCall,
      } as any),
    );
    const fallbackEvents = events.filter((e) => e.type === "fallback");
    return { events, fallbackEvents, onFallbackReasons };
  };

  test("error 带结构化证据（family/reason），不再是硬编码「主模型失败」", async () => {
    const { fallbackEvents } = await setup({ querySource: "main_thread" });

    // 必须真的发生了降级，否则下面的断言无从谈起。
    expect(fallbackEvents.length).toBe(1);
    const ev = fallbackEvents[0];

    // 形如 `transient/overloaded status=[503] attempts=3`：含 `/` 说明是结构化族/因，
    // 且绝不等于旧的那句通用文案。
    expect(ev.error).toContain("/");
    expect(ev.error).not.toBe("主模型失败");
    // 具体证据字段也要在里面 —— 只断言「非旧文案」的话，换成任意一句废话也能过。
    expect(ev.error).toContain("attempts=");
    expect(ev.error).toContain("status=[");
  });

  test("onFallback 钩子文案与遥测 error 是同一份拼装结果", async () => {
    const { fallbackEvents, onFallbackReasons } = await setup({ querySource: "main_thread" });

    expect(fallbackEvents.length).toBe(1);
    expect(onFallbackReasons.length).toBe(1);
    // D2 的核心主张：不许「遥测有证据、UI 文案仍无信息」。
    expect(onFallbackReasons[0]).toBe(fallbackEvents[0].error as string);
  });

  test("querySource 取 perCall 解析后的值（main_thread）", async () => {
    const { fallbackEvents } = await setup({ querySource: "main_thread" });

    expect(fallbackEvents.length).toBe(1);
    expect(fallbackEvents[0].querySource).toBe("main_thread");
  });

  test("querySource 在「未显式传、回落 config」时也能落盘（不是只认 perCall 显式值）", async () => {
    // 只配 config.querySource，perCall 不传 → 走 `?? this.config.querySource` 那条路径。
    // 用 params.querySource 会漏掉这一路，故这条断言专门钉它。
    const events: RetryTelemetryEvent[] = [];
    const fb = new ModelFallback({
      fallbackProvider: successProvider(),
      fallbackModel: "fallback-model",
      querySource: "main_thread",
      onTelemetry: (e) => events.push(e),
    });
    await drain(
      fb.executeWithFallback(alwaysThrowProvider(), defaultParams, undefined, {
        switchMode: "auto",
      } as any),
    );

    const fallbackEvents = events.filter((e) => e.type === "fallback");
    expect(fallbackEvents.length).toBe(1);
    expect(fallbackEvents[0].querySource).toBe("main_thread");
  });

  test("viaDecision 是布尔值（auto 模式为 false），attempts 与 recovery_give_up 同口径", async () => {
    const { events, fallbackEvents } = await setup({ querySource: "main_thread" });

    expect(fallbackEvents.length).toBe(1);
    expect(typeof fallbackEvents[0].viaDecision).toBe("boolean");
    // 无 onFallbackDecision 钩子 → 走 autoFallback()，不是「用户裁决」。
    expect(fallbackEvents[0].viaDecision).toBe(false);

    // attempts 语义 = 总尝试次数（含当前这次），必须 ≥ 1。
    expect(typeof fallbackEvents[0].attempts).toBe("number");
    expect(fallbackEvents[0].attempts).toBeGreaterThanOrEqual(1);

    // 与 recovery_give_up 同字段同义：两条事件同时出现时数字应当一致。
    const giveUp = events.find((e) => e.type === "recovery_give_up");
    expect(giveUp).toBeDefined();
    expect(fallbackEvents[0].attempts).toBe(giveUp!.attempts);
    // 并顺带钉住「不是 totalRetriesThisCall 原值」：503 至少重试 1 次，
    // 若实现漏了 +1，attempts 会与 giveUp.attempts 差一。
    expect(fallbackEvents[0].attempts).toBeGreaterThan(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// D3：retry 事件带 querySource
// ═══════════════════════════════════════════════════════════════════

describe("D3：retry 事件带 querySource", () => {
  test("429 流式重试 → retry 事件 querySource === 'agent:fork'", async () => {
    const events: RetryTelemetryEvent[] = [];
    const counter = { n: 0 };
    const fb = new ModelFallback({
      querySource: "main_thread", // 故意与 perCall 不同：证明取的是 perCall 解析值
      // 关掉共享冷却，避免退避向冷却对齐引入额外时长与噪声
      respectSharedCooldown: false,
      onTelemetry: (e) => events.push(e),
    });

    await drain(
      fb.executeWithFallback(rateLimitedOnceProvider(counter), defaultParams, undefined, {
        querySource: "agent:fork",
        switchMode: "auto",
      } as any),
    );

    // 必须真的重试了一次，否则没有 retry 事件可断言。
    expect(counter.n).toBe(2);
    const retryEvents = events.filter((e) => e.type === "retry");
    expect(retryEvents.length).toBeGreaterThan(0);
    for (const e of retryEvents) {
      expect(e.querySource).toBe("agent:fork");
    }
    // 成败成对：重试后成功，不应进 fallback。
    expect(events.some((e) => e.type === "fallback")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// D3：shared_cooldown_wait（入口侧 S2）带 querySource
// ═══════════════════════════════════════════════════════════════════

describe("D3：shared_cooldown_wait 事件带 querySource", () => {
  test("预置共享冷却 + 探针配额被占 → 入口侧 shared_cooldown_wait 带 querySource", async () => {
    const availability = new ModelAvailabilityService();
    // 500ms 是 MIN_COOLDOWN_MS 地板：冷却只能等不能探，成本可控（参考
    // cooldown-probe-integration.test.ts 的预置方式）。
    availability.markRateLimited("test-model", 500, "429", "rate_limit");
    // 先把探针配额拿走 → 本路必然走「被拒 + 等冷却」分支，而不是跳过等待。
    expect(availability.tryAcquireCooldownProbe("test-model").granted).toBe(true);

    const events: RetryTelemetryEvent[] = [];
    const fb = new ModelFallback({
      availability,
      onTelemetry: (e) => events.push(e),
    });

    await drain(
      fb.executeWithFallback(successProvider(), defaultParams, undefined, {
        querySource: "agent:builtin",
        switchMode: "auto",
      } as any),
    );

    const waits = events.filter((e) => e.type === "shared_cooldown_wait");
    expect(waits.length).toBe(1);
    expect(waits[0].querySource).toBe("agent:builtin");
    // 同一分支里「被拒」那一笔也必须有来源，否则轨迹上只剩「等过」不见「谁在等」。
    const denied = events.filter((e) => e.type === "cooldown_probe_denied");
    expect(denied.length).toBe(1);
    expect(denied[0].querySource).toBe("agent:builtin");
  }, 15_000);

  test("探针放行 → cooldown_probe 事件带 querySource（探针路径同样要能归因）", async () => {
    const availability = new ModelAvailabilityService();
    // 10s 冷却 + 探针放行：本路**不等**直接发（成本是「不等」，不是等满 10s）。
    availability.markRateLimited("test-model", 10_000, "429", "rate_limit");

    const events: RetryTelemetryEvent[] = [];
    const fb = new ModelFallback({
      availability,
      onTelemetry: (e) => events.push(e),
    });

    const started = Date.now();
    await drain(
      fb.executeWithFallback(successProvider(), defaultParams, undefined, {
        querySource: "main_thread",
        switchMode: "auto",
      } as any),
    );

    // 先钉住「真的走了探针路径」：否则下面断言的可能是一条根本不存在的事件。
    const probes = events.filter((e) => e.type === "cooldown_probe");
    expect(probes.length).toBe(1);
    expect(probes[0].probeDecision).toBe("granted");
    expect(probes[0].querySource).toBe("main_thread");
    // 成对：探针路径不该同时记 shared_cooldown_wait（它没等）。
    expect(events.filter((e) => e.type === "shared_cooldown_wait").length).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 15_000);
});
