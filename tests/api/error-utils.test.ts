/**
 * error-utils.ts 测试
 * cause 链遍历 / SSL 诊断 / HTTP 状态提取
 */

import { describe, test, expect } from "bun:test";
import {
  extractConnectionErrorDetails,
  getSSLErrorHint,
  extractHTTPStatus,
  getErrorMessage,
  extractResponseHeaders,
  SSL_ERROR_HINTS,
} from "@sid-code/core/api/error-utils.ts";

describe("extractConnectionErrorDetails", () => {
  test("顶层带 code", () => {
    const err = Object.assign(new Error("boom"), { code: "ECONNRESET" });
    const d = extractConnectionErrorDetails(err);
    expect(d?.code).toBe("ECONNRESET");
    expect(d?.isSSLError).toBe(false);
  });

  test("cause 链下钻提取 code", () => {
    const root = Object.assign(new Error("tls fail"), { code: "CERT_HAS_EXPIRED" });
    const wrapped = new Error("fetch failed", { cause: root });
    const d = extractConnectionErrorDetails(wrapped);
    expect(d?.code).toBe("CERT_HAS_EXPIRED");
    expect(d?.isSSLError).toBe(true);
  });

  test("ERR_TLS_ 前缀识别为 SSL", () => {
    const err = Object.assign(new Error("x"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    expect(extractConnectionErrorDetails(err)?.isSSLError).toBe(true);
  });

  test("无 code 返回 undefined", () => {
    expect(extractConnectionErrorDetails(new Error("plain"))).toBeUndefined();
  });

  test("防御循环引用（不死循环）", () => {
    const a: any = new Error("a");
    const b: any = new Error("b");
    a.cause = b;
    b.cause = a;
    // 无 code，应在 MAX_CAUSE_DEPTH 内安全返回
    expect(extractConnectionErrorDetails(a)).toBeUndefined();
  });
});

describe("getSSLErrorHint", () => {
  test("已知 SSL 错误码给出建议", () => {
    const err = Object.assign(new Error("x"), { code: "SELF_SIGNED_CERT_IN_CHAIN" });
    expect(getSSLErrorHint(err)).toBe(SSL_ERROR_HINTS["SELF_SIGNED_CERT_IN_CHAIN"]);
  });

  test("未知 SSL 码给出兜底（含错误码）", () => {
    const err = Object.assign(new Error("x"), { code: "ERR_SSL_WEIRD" });
    expect(getSSLErrorHint(err)).toContain("ERR_SSL_WEIRD");
  });

  test("非 SSL 错误返回 undefined", () => {
    const err = Object.assign(new Error("x"), { code: "ECONNRESET" });
    expect(getSSLErrorHint(err)).toBeUndefined();
  });
});

describe("extractHTTPStatus", () => {
  test("error.status", () => {
    expect(extractHTTPStatus(Object.assign(new Error(), { status: 429 }))).toBe(429);
  });
  test("error.statusCode", () => {
    expect(extractHTTPStatus(Object.assign(new Error(), { statusCode: 503 }))).toBe(503);
  });
  test("error.response.status", () => {
    expect(extractHTTPStatus({ response: { status: 401 } })).toBe(401);
  });
  test("cause 链中的 status", () => {
    const root = Object.assign(new Error(), { status: 500 });
    expect(extractHTTPStatus(new Error("wrap", { cause: root }))).toBe(500);
  });
  test("无状态返回 undefined", () => {
    expect(extractHTTPStatus(new Error("x"))).toBeUndefined();
  });
});

describe("getErrorMessage", () => {
  test("Error 实例", () => {
    expect(getErrorMessage(new Error("hello"))).toBe("hello");
  });
  test("字符串", () => {
    expect(getErrorMessage("raw")).toBe("raw");
  });
  test("对象 JSON", () => {
    expect(getErrorMessage({ a: 1 })).toBe('{"a":1}');
  });
});

describe("extractResponseHeaders", () => {
  test("error.headers", () => {
    const h = { "retry-after": "5" };
    expect(extractResponseHeaders(Object.assign(new Error(), { headers: h }))).toBe(h);
  });
  test("error.response.headers", () => {
    const h = { "x": "y" };
    expect(extractResponseHeaders({ response: { headers: h } })).toBe(h);
  });
  test("无 headers 返回 undefined", () => {
    expect(extractResponseHeaders(new Error("x"))).toBeUndefined();
  });
});
