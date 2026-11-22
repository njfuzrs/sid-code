/**
 * D8 回归门禁 —— 服务端明确要求的等待超过退避上限时，必须 give_up 而不是
 * 「钳到上限继续重试」或「丢弃后落回指数退避」。
 *
 * 修复前同一条服务端观测信号有三种处置：
 *   ① Retry-After header：钳到 120s 后继续重试；
 *   ② 归一化 retryAfterMs：同上；
 *   ③ rate-limit-reset：超限被丢弃，落回 5s 起的指数退避。
 * 三种都不告诉调用方「服务端其实要求等 10 分钟」——预算被误算成「还有余量」。
 *
 * fix_type: regression_guard
 */

import { describe, test, expect } from "bun:test";
import {
  decideRecovery,
  type AttemptHistory,
  type CallBudget,
} from "@sid-code/core/llm/recovery-policy.ts";
import type { NormalizedLLMError } from "@sid-code/core/llm/error-normalize.ts";

const NOW = Date.UTC(2026, 0, 1);

function makeErr(overrides: Partial<NormalizedLLMError> = {}): NormalizedLLMError {
  return {
    raw: new Error("429 Too Many Requests"),
    status: 429,
    message: "429 Too Many Requests",
    origin: "http",
    arrival: "thrown",
    fingerprint: "fp",
    presetReason: "rate_limit",
    ...overrides,
  };
}

function history(): AttemptHistory {
  return {
    attempts: [],
    totalRetries: 0,
    consecutiveOverloaded: 0,
    degradeTried: false,
    startedAt: NOW,
  };
}

function budget(overrides: Partial<CallBudget> = {}): CallBudget {
  return {
    callerMaxRetries: 5,
    maxRetriesPerCall: 5,
    persistent: false,
    retry529: true,
    backoffBaseMs: 5_000,
    backoff: () => 5_000,
    ...overrides,
  };
}

function giveUpReasonOf(action: ReturnType<typeof decideRecovery>): string | undefined {
  return action.kind === "give_up" ? action.evidence.reason : undefined;
}

describe("D8：服务端要求等待超限 → server_wait_too_long", () => {
  test("路径①：Retry-After header 600s → give_up，wantedDelayMs 是真实等待", () => {
    const raw = Object.assign(new Error("429"), {
      status: 429,
      headers: { "retry-after": "600" },
    });
    const action = decideRecovery(makeErr({ raw }), history(), budget(), NOW);
    expect(action.kind).toBe("give_up");
    if (action.kind !== "give_up") return;
    expect(action.evidence.reason).toBe("server_wait_too_long");
    expect(action.evidence.wantedDelayMs).toBe(600_000);
  });

  test("路径②：归一化 retryAfterMs 600s → give_up，wantedDelayMs 是真实等待", () => {
    const action = decideRecovery(makeErr({ retryAfterMs: 600_000 }), history(), budget(), NOW);
    expect(action.kind).toBe("give_up");
    if (action.kind !== "give_up") return;
    expect(action.evidence.reason).toBe("server_wait_too_long");
    expect(action.evidence.wantedDelayMs).toBe(600_000);
  });

  test("路径③：rate-limit-reset 在 600s 后 → give_up，wantedDelayMs 是真实等待", () => {
    const raw = Object.assign(new Error("429"), {
      status: 429,
      headers: {
        "anthropic-ratelimit-unified-reset": new Date(NOW + 600_000).toISOString(),
      },
    });
    const action = decideRecovery(makeErr({ raw }), history(), budget(), NOW);
    expect(action.kind).toBe("give_up");
    if (action.kind !== "give_up") return;
    expect(action.evidence.reason).toBe("server_wait_too_long");
    expect(action.evidence.wantedDelayMs).toBe(600_000);
  });

  test("服务端要求 60s（未超 120s 上限）→ 仍然 retry，不误判", () => {
    const action = decideRecovery(makeErr({ retryAfterMs: 60_000 }), history(), budget(), NOW);
    expect(action.kind).toBe("retry");
  });

  test("边界 120s 整 → 仍在允许范围内，不放弃", () => {
    const action = decideRecovery(makeErr({ retryAfterMs: 120_000 }), history(), budget(), NOW);
    expect(action.kind).toBe("retry");
  });

  test("persistent 模式同样 give_up（等 600s 已超出任何预算，早失败优于盲等）", () => {
    const action = decideRecovery(
      makeErr({ retryAfterMs: 600_000 }),
      history(),
      budget({ persistent: true }),
      NOW,
    );
    expect(giveUpReasonOf(action)).toBe("server_wait_too_long");
  });
});
