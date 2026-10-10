/**
 * 2026-10-08「一次判死」根治 —— §8 A 组：不变量穷举测试。
 *
 * 回答「错误措辞无法穷举」：不测具体措辞，测**输入空间**。
 *   - A1（I1）：除 I1-例外闭集外，首次观测（attempts=1）的决策永远不是 give_up；
 *     上下文溢出文案的每一格都是 handoff，与状态码无关。纯函数，全量。
 *   - A2（I2）：持续返回同一错误的 mock provider 下，总尝试次数有界且有限步结束。
 *     要驱动 executeWithFallback，状态码按「每个百位段代表 + 全部已命名状态码」取代表集，
 *     零退避注入（retryBackoffBaseMs=0），不真睡。
 *   - A3（I3）：① 归一化层：同一 (status, message, upstreamType) 以 thrown 与 stream_event
 *     （带 / 不带 streamLevel）三种形态归一化后，除 raw/arrival 外字段逐一相等；
 *     ② 执行层：两种形态的 mock provider 驱动 executeWithFallback，provider 调用次数与
 *     放弃证据（reason / family / attempts）逐一相同。
 *
 * 变异自证见 PR 描述：把 401 映射回立即 give_up / 恢复事件分支直退 / 把溢出判定挪到族查表
 * 之后，A1 / A3 必须变红。
 */

import { describe, test, expect } from "bun:test";
import {
  normalizeStreamEvent,
  normalizeThrown,
  type NormalizedLLMError,
} from "@sid-code/core/llm/error-normalize.ts";
import {
  decideRecovery,
  I1_EXCEPTIONS,
  type AttemptHistory,
  type CallBudget,
} from "@sid-code/core/llm/recovery-policy.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { ModelAvailabilityService } from "@sid-code/core/llm/availability.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";
import type { RetryTelemetryEvent } from "@sid-code/core/llm/retry-telemetry.ts";

// ─── 输入空间 ───

/** 已命名状态码 + 每个百位段的代表（含表外的 418/499/520/522/530） */
const STATUSES: (number | undefined)[] = [
  undefined,
  400,
  401,
  402,
  403,
  404,
  408,
  409,
  413,
  418,
  422,
  429,
  499,
  500,
  502,
  503,
  504,
  520,
  522,
  529,
  530,
];
const MESSAGES = [
  "Token已失效，请重试",
  "Invalid token",
  "invalid x-api-key",
  "upstream_error",
  "Connection error.",
  "当前分组上游负载已饱和",
  "Service Unavailable",
  "",
  "some never-seen gateway wording 7f3a9c",
  "model not found",
  "content policy violation",
];
const UPSTREAM_TYPES: (string | undefined)[] = [
  undefined,
  "upstream_error",
  "authentication_error",
  "invalid_request_error",
  "rate_limit_error",
  "overloaded_error",
  "not_found_error",
];
const OVERFLOW_MESSAGES = [
  "prompt is too long: 210000 tokens > 200000 maximum",
  "This model's maximum context length is 128000 tokens",
  "context_length_exceeded",
  "Request too large",
];

const freshHistory = (): AttemptHistory => ({
  attempts: [],
  totalRetries: 0,
  consecutive529: 0,
  degradeTried: false,
  startedAt: Date.now(),
});

const budget = (over: Partial<CallBudget> = {}): CallBudget => ({
  callerMaxRetries: 5,
  maxRetriesPerCall: 12,
  persistent: false,
  retry529: true,
  backoffBaseMs: 0,
  backoff: () => 0,
  ...over,
});

const thrownOf = (
  status: number | undefined,
  message: string,
  type?: string,
): NormalizedLLMError => {
  const e = new Error(message) as Error & { status?: number; error?: { type?: string } };
  if (status !== undefined) e.status = status;
  if (type) e.error = { type };
  return normalizeThrown(e);
};

// ═══ A1：I1 ═══

describe("A1（I1）：除 I1-例外外，首次观测不放弃", () => {
  test("全量输入空间 × 两种到达形态：attempts=1 的决策不是 give_up（或 give_up 原因属于闭集）", () => {
    let cells = 0;
    for (const status of STATUSES) {
      for (const message of MESSAGES) {
        for (const type of UPSTREAM_TYPES) {
          for (const n of [
            normalizeStreamEvent({ message, type, statusCode: status }),
            normalizeStreamEvent({ message, type, statusCode: status, streamLevel: true }),
            thrownOf(status, message, type),
          ]) {
            const a = decideRecovery(n, freshHistory(), budget());
            cells++;
            if (a.kind === "give_up") {
              // 失败时打印格子，便于定位
              expect({
                status,
                message,
                type,
                reason: a.evidence.reason,
                inClosedSet: I1_EXCEPTIONS.has(a.evidence.reason),
              }).toEqual({
                status,
                message,
                type,
                reason: a.evidence.reason,
                inClosedSet: true,
              });
            }
          }
        }
      }
    }
    expect(cells).toBe(STATUSES.length * MESSAGES.length * UPSTREAM_TYPES.length * 3);
  });

  test("调用方 maxRetries=0 也至少重试一次（下限 2）", () => {
    for (const status of [401, 400, 429, 503, undefined]) {
      const n = normalizeStreamEvent({ message: "x", statusCode: status });
      expect(decideRecovery(n, freshHistory(), budget({ callerMaxRetries: 0 })).kind).toBe("retry");
    }
  });

  test("上下文溢出的每一格都转交（与状态码 / 到达形态无关），且先于族查表", () => {
    for (const message of OVERFLOW_MESSAGES) {
      for (const status of [undefined, 400, 413, 422, 500]) {
        for (const n of [
          normalizeStreamEvent({ message, statusCode: status }),
          normalizeStreamEvent({
            message,
            statusCode: status,
            type: "invalid_request_error",
            streamLevel: true,
          }),
          thrownOf(status, message),
        ]) {
          expect(decideRecovery(n, freshHistory(), budget())).toEqual({
            kind: "handoff",
            to: "context_overflow",
          });
        }
      }
    }
  });

  test("413 附件过大不是溢出：按 request_suspect 重试，不转交", () => {
    const n = normalizeStreamEvent({ message: "image exceeds 5 MB maximum", statusCode: 413 });
    const a = decideRecovery(n, freshHistory(), budget());
    expect(a.kind).toBe("retry");
  });

  test("I1-例外闭集只有这些（新增条目必须同步改本断言）", () => {
    expect([...I1_EXCEPTIONS].map(String).sort()).toEqual(
      ["background_529", "context_overflow", "deadline", "server_declined", "user_abort"].sort(),
    );
  });
});

// ═══ A2：I2 ═══

const PARAMS: SendParams = {
  model: "m1",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 1024,
};

function persistentErrorProvider(
  status: number | undefined,
  message: string,
  arrival: "thrown" | "stream_event",
  type?: string,
): { provider: Provider; calls: () => number } {
  let n = 0;
  const provider: Provider = {
    name: () => "mock",
    // eslint-disable-next-line require-yield
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      n++;
      if (arrival === "thrown") {
        const e = new Error(message) as Error & { status?: number; error?: { type?: string } };
        if (status !== undefined) e.status = status;
        if (type) e.error = { type };
        throw e;
      }
      yield {
        type: "error",
        error: {
          message,
          ...(status !== undefined && { statusCode: status }),
          ...(type && { type }),
        },
      } as StreamEvent;
    },
  } as Provider;
  return { provider, calls: () => n };
}

async function run(
  provider: Provider,
  opts: { maxRetries?: number; maxRetriesPerCall?: number } = {},
): Promise<{ telemetry: RetryTelemetryEvent[]; events: StreamEvent[] }> {
  const telemetry: RetryTelemetryEvent[] = [];
  const fb = new ModelFallback({
    availability: new ModelAvailabilityService(),
    retryBackoffBaseMs: 0,
    retryBackoffMaxMs: 0,
    respectSharedCooldown: false,
    allowNonStreamingFallback: false,
    maxRetriesPerCall: opts.maxRetriesPerCall ?? 12,
    onTelemetry: (e) => telemetry.push(e),
  });
  const events: StreamEvent[] = [];
  for await (const e of fb.executeWithFallback(provider, PARAMS, undefined, {
    querySource: "agent:builtin",
    switchMode: "off",
    maxRetries: opts.maxRetries ?? 5,
  })) {
    events.push(e);
  }
  return { telemetry, events };
}

describe("A2（I2）：持续同一错误下，尝试次数有界", () => {
  test("代表状态码 × 两种形态：调用次数 ≤ min(maxRetries+1, maxRetriesPerCall+1)，且 ≥ 2", async () => {
    for (const status of STATUSES) {
      if (status === 413) continue; // 溢出转交，A1 已覆盖
      for (const arrival of ["thrown", "stream_event"] as const) {
        for (const [maxRetries, perCall] of [
          [5, 12],
          [8, 3],
          [0, 12],
        ]) {
          const { provider, calls } = persistentErrorProvider(status, "boom", arrival);
          await run(provider, { maxRetries, maxRetriesPerCall: perCall });
          const cap = Math.min(Math.max(2, maxRetries + 1), perCall + 1);
          expect({
            status,
            arrival,
            maxRetries,
            perCall,
            calls: calls() <= cap && calls() >= 2,
          }).toEqual({
            status,
            arrival,
            maxRetries,
            perCall,
            calls: true,
          });
        }
      }
    }
  });
});

// ═══ A3：I3 ═══

describe("A3（I3）：两种到达形态归一成同一对象、走同一命运", () => {
  const strip = (n: NormalizedLLMError) => {
    const { raw: _raw, arrival: _arrival, ...rest } = n;
    return rest;
  };

  test("① 归一化层：thrown 与 stream_event（带 / 不带 streamLevel）除 raw/arrival 外逐字段相等", () => {
    for (const status of STATUSES) {
      for (const message of MESSAGES) {
        for (const type of UPSTREAM_TYPES) {
          const a = strip(thrownOf(status, message, type));
          const b = strip(normalizeStreamEvent({ message, type, statusCode: status }));
          const c = strip(
            normalizeStreamEvent({ message, type, statusCode: status, streamLevel: true }),
          );
          expect(b).toEqual(a);
          expect(c).toEqual(a);
        }
      }
    }
  });

  test("② 执行层：两种形态的调用次数与放弃证据逐一相同", async () => {
    const cases: [number | undefined, string, string | undefined][] = [
      [401, "Token已失效，请重试", "upstream_error"],
      [401, "invalid x-api-key", "authentication_error"],
      [400, "bad request", undefined],
      [404, "model not found", "not_found_error"],
      [429, "rate limit", "rate_limit_error"],
      [520, "upstream_error", undefined],
      [undefined, "Connection error.", undefined],
      [undefined, "some never-seen gateway wording", undefined],
    ];
    for (const [status, message, type] of cases) {
      const outcome = async (arrival: "thrown" | "stream_event") => {
        const { provider, calls } = persistentErrorProvider(status, message, arrival, type);
        const { telemetry } = await run(provider);
        const g = telemetry.find((e) => e.type === "recovery_give_up");
        return {
          calls: calls(),
          reason: g?.giveUpReason,
          family: g?.family,
          attempts: g?.attempts,
          retries: telemetry.filter((e) => e.type === "retry").map((e) => e.reopenReason),
        };
      };
      const thrown = await outcome("thrown");
      const event = await outcome("stream_event");
      expect({ status, message, ...event }).toEqual({ status, message, ...thrown });
      expect(thrown.calls).toBeGreaterThanOrEqual(2);
    }
  });
});
