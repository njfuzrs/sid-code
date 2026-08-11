/**
 * api/errors.ts 测试
 * 错误分类标签 + 用户友好消息 + 细粒度谓词
 */

import { describe, test, expect } from "bun:test";
import {
  classifyAPIError,
  getErrorMessageForUser,
  parseMaxTokensOverflowError,
  extractRetryAfter,
  is429Error,
  is529Error,
  is401Error,
  is404Error,
  isPromptTooLong,
  isTimeoutError,
  isImageTooLarge,
  isConnectionError,
} from "@sid-code/core/api/errors.ts";

describe("classifyAPIError", () => {
  test("用户中止", () => {
    expect(classifyAPIError(new Error("Request aborted"))).toBe("aborted");
  });

  test("超时", () => {
    expect(classifyAPIError(new Error("connection timeout"))).toBe("api_timeout");
    expect(classifyAPIError(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBe("api_timeout");
  });

  test("max_tokens 溢出（input + max > context）优先于 prompt_too_long", () => {
    const err = new Error("input length and max_tokens exceed context limit: 188059 + 20000 > 200000");
    expect(classifyAPIError(err)).toBe("max_tokens_overflow");
  });

  test("prompt 过长（无加法表达式）", () => {
    const err = new Error("prompt is too long: 137500 tokens > 135000 maximum");
    expect(classifyAPIError(err)).toBe("prompt_too_long");
  });

  test("429 限流", () => {
    expect(classifyAPIError(new Error("HTTP 429 rate_limit_error"))).toBe("rate_limit");
    expect(classifyAPIError(Object.assign(new Error("x"), { status: 429 }))).toBe("rate_limit");
  });

  test("529 过载", () => {
    expect(classifyAPIError(new Error("overloaded_error"))).toBe("server_overload");
    expect(classifyAPIError(Object.assign(new Error("x"), { status: 529 }))).toBe("server_overload");
  });

  test("401 认证", () => {
    expect(classifyAPIError(new Error("401 authentication_error: invalid x-api-key"))).toBe("invalid_api_key");
  });

  test("404 模型不存在", () => {
    expect(classifyAPIError(new Error("404 not_found_error: model"))).toBe("invalid_model");
  });

  test("图片超限", () => {
    expect(classifyAPIError(new Error("image exceeds 5MB limit too large"))).toBe("image_too_large");
  });

  test("余额不足", () => {
    expect(classifyAPIError(new Error("Your credit balance is too low"))).toBe("credit_balance_low");
  });

  test("SSL 证书错误", () => {
    const err = Object.assign(new Error("tls"), { code: "CERT_HAS_EXPIRED" });
    expect(classifyAPIError(err)).toBe("ssl_cert_error");
  });

  test("连接错误", () => {
    expect(classifyAPIError(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe("connection_error");
  });

  test("5xx 服务端错误", () => {
    expect(classifyAPIError(Object.assign(new Error("x"), { status: 502 }))).toBe("server_error");
  });

  test("未知错误兜底", () => {
    expect(classifyAPIError(new Error("something weird happened"))).toBe("unknown");
  });

  test("覆盖 15+ 种错误类型", () => {
    const cases = [
      new Error("Request aborted"),
      new Error("timeout"),
      new Error("188059 + 20000 > 200000"),
      new Error("prompt is too long"),
      Object.assign(new Error(), { status: 429 }),
      Object.assign(new Error(), { status: 529 }),
      new Error("credit balance too low"),
      new Error("401 invalid api key"),
      new Error("404 model_not_found"),
      new Error("image too large"),
      new Error("pdf too large"),
      Object.assign(new Error(), { code: "CERT_HAS_EXPIRED" }),
      Object.assign(new Error(), { code: "ECONNRESET" }),
      Object.assign(new Error(), { status: 500 }),
      new Error("weird"),
    ];
    const categories = new Set(cases.map(classifyAPIError));
    expect(categories.size).toBeGreaterThanOrEqual(13);
  });
});

describe("getErrorMessageForUser", () => {
  test("每种错误都有可操作的 content + category", () => {
    const r = getErrorMessageForUser(new Error("401 invalid api key"), "claude-sonnet-4");
    expect(r.category).toBe("invalid_api_key");
    expect(r.content).toContain("API Key");
  });

  test("invalid_model 提示 /model 切换", () => {
    const r = getErrorMessageForUser(new Error("404 model not found"), "claude-x");
    expect(r.content).toContain("/model");
    expect(r.content).toContain("claude-x");
  });

  test("prompt_too_long 保留 errorDetails 供压缩解析", () => {
    const err = new Error("prompt is too long: 137500 tokens > 135000");
    const r = getErrorMessageForUser(err, "m");
    expect(r.category).toBe("prompt_too_long");
    expect(r.errorDetails).toContain("137500");
  });

  test("429 带短 Retry-After 显示秒数", () => {
    const err = new Error("429 rate_limit retry-after: 5");
    const r = getErrorMessageForUser(err, "m");
    expect(r.content).toContain("5");
  });

  test("交互式 / 非交互式图片消息不同", () => {
    const err = new Error("image too large");
    const interactive = getErrorMessageForUser(err, "m", { isInteractive: true });
    const noninteractive = getErrorMessageForUser(err, "m", { isInteractive: false });
    expect(interactive.content).not.toBe(noninteractive.content);
  });

  test("SSL 错误带诊断建议", () => {
    const err = Object.assign(new Error("tls"), { code: "SELF_SIGNED_CERT_IN_CHAIN" });
    const r = getErrorMessageForUser(err, "m");
    expect(r.category).toBe("ssl_cert_error");
    expect(r.content).toContain("NODE_EXTRA_CA_CERTS");
  });
});

describe("parseMaxTokensOverflowError", () => {
  test("加法表达式", () => {
    const r = parseMaxTokensOverflowError(new Error("188059 + 20000 > 200000"));
    expect(r).toEqual({ inputTokens: 188059, contextLimit: 200000 });
  });
  test("tokens > maximum 表达式", () => {
    const r = parseMaxTokensOverflowError(new Error("137500 tokens > 135000"));
    expect(r).toEqual({ inputTokens: 137500, contextLimit: 135000 });
  });
  test("无匹配返回 undefined", () => {
    expect(parseMaxTokensOverflowError(new Error("nope"))).toBeUndefined();
  });
});

describe("extractRetryAfter", () => {
  test("retry-after: 30", () => {
    expect(extractRetryAfter(new Error("rate limited, retry-after: 30"))).toBe(30);
  });
  test("retry_after 30", () => {
    expect(extractRetryAfter(new Error('"retry_after":30'))).toBe(30);
  });
  test("超出范围(>600)忽略", () => {
    expect(extractRetryAfter(new Error("retry-after: 9999"))).toBeUndefined();
  });
});

describe("细粒度谓词", () => {
  test("is429/is529/is401/is404", () => {
    expect(is429Error(new Error("429"))).toBe(true);
    expect(is529Error(new Error("overloaded"))).toBe(true);
    expect(is401Error(new Error("401"))).toBe(true);
    expect(is404Error(new Error("404"))).toBe(true);
  });
  test("isPromptTooLong/isTimeout/isImageTooLarge/isConnection", () => {
    expect(isPromptTooLong(new Error("context length exceeded"))).toBe(true);
    expect(isTimeoutError(new Error("timed out"))).toBe(true);
    expect(isImageTooLarge(new Error("image too large"))).toBe(true);
    expect(isConnectionError(Object.assign(new Error(), { code: "ECONNREFUSED" }))).toBe(true);
  });
});
