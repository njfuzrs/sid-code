/**
 * 事故复现：会话 20261008-173228-baeb949d —— 网关回流内事件
 * `{message:"Token已失效，请重试", type:"upstream_error", statusCode:401, streamLevel:true}`，
 * 旧实现 5ms 内判死、零重试、主模型被进程内永久拉黑（设计 §1 / §8 B 组）。
 *
 * 一律注入零退避（retryBackoffBaseMs=0 同时关掉各族最小间隔下限），不真睡。
 */

import { describe, test, expect } from "bun:test";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { ModelAvailabilityService } from "@sid-code/core/llm/availability.ts";
import { normalizeThrown } from "@sid-code/core/llm/error-normalize.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";
import type { RetryTelemetryEvent } from "@sid-code/core/llm/retry-telemetry.ts";

const PARAMS: SendParams = {
  model: "m1",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 1024,
};

const INCIDENT_EVENT = {
  type: "error",
  error: {
    message: "Token已失效，请重试",
    type: "upstream_error",
    statusCode: 401,
    streamLevel: true,
  },
} as StreamEvent;

const OK: StreamEvent[] = [
  { type: "message_start", message: { usage: { inputTokens: 1, outputTokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { inputTokens: 1, outputTokens: 1 },
  },
  { type: "message_stop" },
];

/** 第 i 次调用（1-based）返回 script(i) 产出的行为 */
function scripted(script: (i: number) => StreamEvent[] | Error): {
  provider: Provider;
  calls: () => number;
} {
  let n = 0;
  const provider = {
    name: () => "mock",
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      n++;
      const r = script(n);
      if (r instanceof Error) throw r;
      for (const e of r) yield e;
    },
  } as unknown as Provider;
  return { provider, calls: () => n };
}

function harness(extra: Record<string, unknown> = {}) {
  const availability = new ModelAvailabilityService();
  const telemetry: RetryTelemetryEvent[] = [];
  let fallbackAsked = 0;
  const fb = new ModelFallback({
    availability,
    retryBackoffBaseMs: 0,
    retryBackoffMaxMs: 0,
    respectSharedCooldown: false,
    onTelemetry: (e) => telemetry.push(e),
    fallbackSwitchMode: "ask",
    onFallbackDecision: async () => {
      fallbackAsked++;
      return { action: "abort" };
    },
    onAuthRefresh: async () => false,
    ...extra,
  });
  const drain = async (provider: Provider, maxRetries = 5) => {
    const out: StreamEvent[] = [];
    for await (const e of fb.executeWithFallback(provider, PARAMS, undefined, {
      querySource: "main_thread",
      maxRetries,
    })) {
      out.push(e);
    }
    return out;
  };
  return { fb, availability, telemetry, drain, fallbackAsked: () => fallbackAsked };
}

const errorTexts = (out: StreamEvent[]) =>
  out
    .filter((e) => e.type === "error")
    .map((e) => (e as { error: { message: string } }).error.message);

describe("事故 20261008：Token已失效（401 流内事件）", () => {
  test("首次 401、第二次正常 → 主模型上自愈，不降级、无嫌疑、刷新过凭据", async () => {
    const h = harness();
    const { provider, calls } = scripted((i) => (i === 1 ? [INCIDENT_EVENT] : OK));
    const out = await h.drain(provider);
    expect(calls()).toBe(2);
    expect(out.some((e) => e.type === "message_stop")).toBe(true);
    expect(h.fallbackAsked()).toBe(0);
    expect(h.availability.isSuspect("m1")).toBe(false);
    expect(h.telemetry.filter((e) => e.type === "auth_refresh").length).toBeGreaterThanOrEqual(1);
  });

  test("持续 401 → 尝试 3 次后放弃，RecoveryGiveUp 带证据（attempts=3，指纹一致）", async () => {
    const h = harness();
    const { provider, calls } = scripted(() => [INCIDENT_EVENT]);
    const out = await h.drain(provider);
    expect(calls()).toBe(3);
    const g = h.telemetry.filter((e) => e.type === "recovery_give_up");
    expect(g.length).toBe(1);
    expect(g[0].attempts).toBe(3);
    expect(g[0].family).toBe("auth_suspect");
    expect(new Set(g[0].fingerprints).size).toBe(1);
    expect(g[0].statuses).toEqual([401, 401, 401]);
    // 放弃只作用于本次调用：嫌疑有时效，主线程下一次照样能发
    expect(h.availability.isSuspect("m1")).toBe(true);
    expect(h.availability.isAvailable("m1", "main_thread").available).toBe(true);
    // 文案给出真实可执行的下一步
    expect(errorTexts(out).join(" ")).toContain("直接重发消息会重新请求该模型");
  });

  test("Connection error.（无状态码 throw，会话 20261005-234012 原文）→ transient 重试", async () => {
    const h = harness();
    const { provider, calls } = scripted((i) => (i === 1 ? new Error("Connection error.") : OK));
    const out = await h.drain(provider);
    expect(calls()).toBe(2);
    expect(out.some((e) => e.type === "message_stop")).toBe(true);
  });
});

describe("上下文溢出：零重试转交，不拉黑、不降级、原文透传（§2.7）", () => {
  for (const [label, ev] of [
    [
      "400 prompt is too long（不带 streamLevel，生产真实形态）",
      { message: "prompt is too long: 210000 tokens > 200000 maximum", statusCode: 400 },
    ],
    ["413 Request too large", { message: "Request too large", statusCode: 413 }],
  ] as const) {
    test(label, async () => {
      const h = harness();
      const { provider, calls } = scripted(() => [{ type: "error", error: ev } as StreamEvent]);
      const out = await h.drain(provider);
      expect(calls()).toBe(1);
      expect(errorTexts(out)).toEqual([ev.message]);
      expect(h.availability.isSuspect("m1")).toBe(false);
      expect(h.fallbackAsked()).toBe(0);
      expect(h.telemetry.some((e) => e.type === "fallback" || e.type === "recovery_give_up")).toBe(
        false,
      );
    });
  }

  test("反例：413 image exceeds 5 MB maximum 不转交，按 request_suspect 重试", async () => {
    const h = harness();
    const { provider, calls } = scripted(() => [
      {
        type: "error",
        error: { message: "image exceeds 5 MB maximum", statusCode: 413 },
      } as StreamEvent,
    ]);
    await h.drain(provider);
    expect(calls()).toBe(2);
    const g = h.telemetry.find((e) => e.type === "recovery_give_up");
    expect(g?.family).toBe("request_suspect");
  });
});

describe("origin 判定：本地缺陷 vs 网络失败", () => {
  test("本地 TypeError: Cannot read properties of undefined → 2 次后放弃，reason=local_fault", async () => {
    const h = harness();
    const { provider, calls } = scripted(
      () => new TypeError("Cannot read properties of undefined (reading 'x')"),
    );
    await h.drain(provider);
    expect(calls()).toBe(2);
    expect(h.telemetry.find((e) => e.type === "recovery_give_up")?.giveUpReason).toBe(
      "local_fault",
    );
  });

  test("反例：TypeError: fetch failed → origin=network，进 transient 重试，不是 local_fault", async () => {
    expect(normalizeThrown(new TypeError("fetch failed")).origin).toBe("network");
    const h = harness();
    const { provider, calls } = scripted((i) => (i < 3 ? new TypeError("fetch failed") : OK));
    const out = await h.drain(provider);
    expect(calls()).toBe(3);
    expect(out.some((e) => e.type === "message_stop")).toBe(true);
  });

  test("反例：持续 429（同指纹）、maxRetries=5 → 尝试 6 次，未被同指纹封顶截断", async () => {
    const h = harness();
    const { provider, calls } = scripted(() => [
      {
        type: "error",
        error: { message: "rate limit", type: "rate_limit_error", statusCode: 429 },
      } as StreamEvent,
    ]);
    await h.drain(provider, 5);
    expect(calls()).toBe(6);
  });
});

describe("§4.4：放弃后就地重试当前模型", () => {
  test("弹窗选「重试当前模型」→ 全新族预算重入并成功；canRetrySame 随次数关闭", async () => {
    const seen: boolean[] = [];
    let decisions = 0;
    const h = harness({
      onFallbackDecision: async (ctx: { canRetrySame?: boolean }) => {
        seen.push(!!ctx.canRetrySame);
        decisions++;
        return decisions <= 2 ? { action: "retry_same" } : { action: "abort" };
      },
    });
    // 前 6 次 401（两轮各 3 次），第 7 次成功
    const { provider, calls } = scripted((i) => (i <= 6 ? [INCIDENT_EVENT] : OK));
    const out = await h.drain(provider);
    expect(calls()).toBe(7);
    expect(out.some((e) => e.type === "message_stop")).toBe(true);
    expect(seen).toEqual([true, true]);
  });

  test("持续失败：retry_same 最多 2 次，之后不再提供该选项（I2 有界）", async () => {
    const seen: boolean[] = [];
    const h = harness({
      onFallbackDecision: async (ctx: { canRetrySame?: boolean }) => {
        seen.push(!!ctx.canRetrySame);
        return ctx.canRetrySame ? { action: "retry_same" } : { action: "abort" };
      },
    });
    const { provider, calls } = scripted(() => [INCIDENT_EVENT]);
    await h.drain(provider);
    expect(seen).toEqual([true, true, false]);
    expect(calls()).toBe(9);
  });
});
