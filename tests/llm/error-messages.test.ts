/**
 * 错误文案映射表单测
 */

import { describe, test, expect } from "bun:test";
import {
  ERROR_USER_MESSAGES,
  inferErrorCode,
  lookupErrorMessage,
} from "@sid-code/core/llm/error-messages.ts";

describe("inferErrorCode", () => {
  test("空输入返回 undefined", () => {
    expect(inferErrorCode("")).toBeUndefined();
    expect(inferErrorCode(undefined as any)).toBeUndefined();
  });

  test("识别 auth_failed", () => {
    expect(inferErrorCode("Unauthorized: invalid api key")).toBe("auth_failed");
    expect(inferErrorCode("Error: Invalid API Key provided")).toBe("auth_failed");
  });

  test("识别 model_not_found", () => {
    expect(inferErrorCode("model_not_found: gpt-5-turbo does not exist")).toBe("model_not_found");
    expect(inferErrorCode("The model 'xxx' does not exist")).toBe("model_not_found");
  });

  test("识别 quota_exhausted", () => {
    expect(inferErrorCode("insufficient_quota: billing limit reached")).toBe("quota_exhausted");
    expect(inferErrorCode("Quota exceeded for this organization")).toBe("quota_exhausted");
  });

  test("识别 rate_limit (429)", () => {
    expect(inferErrorCode("Rate limit exceeded, retry after 30s")).toBe("rate_limit");
    expect(inferErrorCode("HTTP 429: Too Many Requests")).toBe("rate_limit");
  });

  test("识别 timeout", () => {
    expect(inferErrorCode("Request timed out after 60s")).toBe("timeout");
    expect(inferErrorCode("请求超时（已重试 3 次）")).toBe("timeout");
  });

  test("识别 network_error", () => {
    expect(inferErrorCode("fetch failed: ECONNREFUSED")).toBe("network_error");
    expect(inferErrorCode("Network error: ENOTFOUND api.openai.com")).toBe("network_error");
  });

  test("识别 empty_response", () => {
    expect(inferErrorCode("模型返回空响应（0 内容事件）")).toBe("empty_response");
    expect(inferErrorCode("empty_response: no content")).toBe("empty_response");
  });

  test("识别 html_error_page", () => {
    expect(inferErrorCode("响应 Content-Type 为 text/html，疑似网关错误页")).toBe("html_error_page");
    expect(inferErrorCode("no available channel for model xxx")).toBe("html_error_page");
  });

  test("识别 server_error (500/502)", () => {
    expect(inferErrorCode("HTTP 500 Internal Server Error")).toBe("server_error");
    expect(inferErrorCode("502 Bad Gateway")).toBe("server_error");
  });

  test("识别 overloaded (529/503)", () => {
    expect(inferErrorCode("HTTP 529: Service Overloaded")).toBe("overloaded");
    expect(inferErrorCode("503 Service Unavailable")).toBe("overloaded");
  });

  test("识别 unknown_stop_reason", () => {
    expect(inferErrorCode("模型以未识别的停止原因结束（stopReason: length）")).toBe("unknown_stop_reason");
  });

  test("无法识别时返回 undefined", () => {
    expect(inferErrorCode("some random error we cannot classify")).toBeUndefined();
  });
});

describe("lookupErrorMessage", () => {
  test("已知 code 返回对应文案", () => {
    const msg = lookupErrorMessage("anything", "auth_failed");
    expect(msg.title).toBe("API Key 无效或已过期");
    expect(msg.suggestion).toContain("apiKey");
  });

  test("无 code 时通过文本推断", () => {
    const msg = lookupErrorMessage("Request timed out after 60s");
    expect(msg.title).toBe("请求超时");
    expect(msg.suggestion).toContain("网络");
  });

  test("完全无法识别时返回通用 fallback", () => {
    const msg = lookupErrorMessage("xyzzy unrecognizable");
    expect(msg.title).toBe("运行错误");
    expect(msg.suggestion).toContain("重试");
  });

  test("所有 ERROR_USER_MESSAGES 条目有 title 和 suggestion", () => {
    for (const [_code, entry] of Object.entries(ERROR_USER_MESSAGES)) {
      expect(entry.title).toBeTruthy();
      expect(entry.suggestion).toBeTruthy();
    }
  });
});
