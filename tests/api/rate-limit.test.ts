/**
 * rate-limit.ts 测试
 * 从 headers 提取 / 利用率 / 状态判定 / Headers 与 Record 两种入参
 */

import { describe, test, expect } from "bun:test";
import {
  extractRateLimitFromHeaders,
  updateRateLimitStatus,
  getCurrentRateLimitStatus,
  resetRateLimitStatus,
  formatRateLimitWarning,
} from "@sid-code/core/api/rate-limit.ts";

describe("extractRateLimitFromHeaders", () => {
  test("Record 入参 + 正常利用率", () => {
    const s = extractRateLimitFromHeaders({
      "anthropic-ratelimit-requests-limit": "1000",
      "anthropic-ratelimit-requests-remaining": "900",
      "anthropic-ratelimit-tokens-limit": "100000",
      "anthropic-ratelimit-tokens-remaining": "90000",
    });
    expect(s.status).toBe("ok");
    expect(s.remainingRequests).toBe(900);
    expect(s.remainingTokens).toBe(90000);
    expect(s.utilization).toBeCloseTo(0.1, 5);
  });

  test("利用率 >= 80% → warning", () => {
    const s = extractRateLimitFromHeaders({
      "anthropic-ratelimit-tokens-limit": "100000",
      "anthropic-ratelimit-tokens-remaining": "15000", // 用了 85%
    });
    expect(s.status).toBe("warning");
  });

  test("利用率 >= 100% → exceeded", () => {
    const s = extractRateLimitFromHeaders({
      "anthropic-ratelimit-tokens-limit": "100000",
      "anthropic-ratelimit-tokens-remaining": "0",
    });
    expect(s.status).toBe("exceeded");
  });

  test("取请求和 token 中较高的利用率", () => {
    const s = extractRateLimitFromHeaders({
      "anthropic-ratelimit-requests-limit": "100",
      "anthropic-ratelimit-requests-remaining": "10", // 90%
      "anthropic-ratelimit-tokens-limit": "100000",
      "anthropic-ratelimit-tokens-remaining": "90000", // 10%
    });
    expect(s.utilization).toBeCloseTo(0.9, 5);
    expect(s.status).toBe("warning");
  });

  test("Headers 实例入参", () => {
    const h = new Headers();
    h.set("anthropic-ratelimit-tokens-limit", "1000");
    h.set("anthropic-ratelimit-tokens-remaining", "500");
    h.set("retry-after", "30");
    const s = extractRateLimitFromHeaders(h);
    expect(s.utilization).toBeCloseTo(0.5, 5);
    expect(s.retryAfterSeconds).toBe(30);
  });

  test("reset 为 Unix 秒数 → 转毫秒", () => {
    const s = extractRateLimitFromHeaders({
      "anthropic-ratelimit-requests-reset": "1700000000",
    });
    expect(s.resetsAt).toBe(1700000000 * 1000);
  });

  test("reset 为 ISO 串", () => {
    const s = extractRateLimitFromHeaders({
      "anthropic-ratelimit-requests-reset": "2026-06-01T00:00:00Z",
    });
    expect(s.resetsAt).toBe(new Date("2026-06-01T00:00:00Z").getTime());
  });

  test("无相关 header → ok 且字段 undefined", () => {
    const s = extractRateLimitFromHeaders({});
    expect(s.status).toBe("ok");
    expect(s.remainingTokens).toBeUndefined();
    expect(s.utilization).toBeUndefined();
  });

  test("大小写不敏感（Record）", () => {
    const s = extractRateLimitFromHeaders({
      "Anthropic-RateLimit-Tokens-Limit": "1000",
      "Anthropic-RateLimit-Tokens-Remaining": "100",
    });
    expect(s.utilization).toBeCloseTo(0.9, 5);
  });

  // G8：OpenAI 系 header 兼容
  test("OpenAI x-ratelimit-*（limit-tokens 词序）", () => {
    const s = extractRateLimitFromHeaders({
      "x-ratelimit-limit-tokens": "100000",
      "x-ratelimit-remaining-tokens": "15000", // 用了 85%
      "x-ratelimit-limit-requests": "1000",
      "x-ratelimit-remaining-requests": "900", // 10%
    });
    expect(s.remainingTokens).toBe(15000);
    expect(s.remainingRequests).toBe(900);
    expect(s.utilization).toBeCloseTo(0.85, 5);
    expect(s.status).toBe("warning");
  });

  test("OpenAI x-ratelimit-*（tokens-remaining 词序也兼容）", () => {
    const s = extractRateLimitFromHeaders({
      "x-ratelimit-tokens-limit": "100000",
      "x-ratelimit-tokens-remaining": "0",
    });
    expect(s.status).toBe("exceeded");
  });

  test("OpenAI x-ratelimit-reset-tokens（Unix 秒）", () => {
    const s = extractRateLimitFromHeaders({
      "x-ratelimit-reset-tokens": "1700000000",
    });
    expect(s.resetsAt).toBe(1700000000 * 1000);
  });

  test("Anthropic 命名优先于 OpenAI 命名（两族并存时）", () => {
    const s = extractRateLimitFromHeaders({
      "anthropic-ratelimit-tokens-limit": "1000",
      "anthropic-ratelimit-tokens-remaining": "500", // 50%
      "x-ratelimit-limit-tokens": "1000",
      "x-ratelimit-remaining-tokens": "0", // 100%
    });
    // 取 anthropic 的 500 剩余 → 50%
    expect(s.remainingTokens).toBe(500);
    expect(s.utilization).toBeCloseTo(0.5, 5);
  });
});

describe("全局状态", () => {
  test("update / get / reset", () => {
    resetRateLimitStatus();
    expect(getCurrentRateLimitStatus().status).toBe("ok");
    updateRateLimitStatus({
      "anthropic-ratelimit-tokens-limit": "100",
      "anthropic-ratelimit-tokens-remaining": "0",
    });
    expect(getCurrentRateLimitStatus().status).toBe("exceeded");
    resetRateLimitStatus();
    expect(getCurrentRateLimitStatus().status).toBe("ok");
  });
});

describe("formatRateLimitWarning", () => {
  test("ok 返回 null", () => {
    expect(formatRateLimitWarning({ status: "ok" })).toBeNull();
  });
  test("warning 含利用率", () => {
    const msg = formatRateLimitWarning({ status: "warning", utilization: 0.85, remainingTokens: 1500 });
    expect(msg).toContain("接近速率限制");
    expect(msg).toContain("85%");
  });
  test("exceeded 文案", () => {
    const msg = formatRateLimitWarning({ status: "exceeded", utilization: 1 });
    expect(msg).toContain("已超出");
  });
});
