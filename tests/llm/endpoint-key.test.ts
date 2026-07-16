/**
 * endpoint-key.ts 测试 — 端点归一化（计费复合键的端点侧）
 */

import { describe, test, expect } from "bun:test";
import { normalizeBaseURL, sameEndpoint } from "../../src/llm/endpoint-key.ts";

describe("normalizeBaseURL", () => {
  test("空/undefined → 空串（= 官方默认端点）", () => {
    expect(normalizeBaseURL(undefined)).toBe("");
    expect(normalizeBaseURL(null)).toBe("");
    expect(normalizeBaseURL("")).toBe("");
    expect(normalizeBaseURL("   ")).toBe("");
  });

  test("去末尾斜杠", () => {
    expect(normalizeBaseURL("https://gateway.example.com/v1/")).toBe("https://gateway.example.com/v1");
    expect(normalizeBaseURL("https://gateway.example.com/")).toBe("https://gateway.example.com");
  });

  test("协议与 host 小写", () => {
    expect(normalizeBaseURL("HTTPS://UniAPI.Ruijie.COM.cn/v1")).toBe("https://gateway.example.com/v1");
  });

  test("不剥 /v1：anthropic(不带) 与 openai(带) 同 host 是不同端点", () => {
    const anthropic = normalizeBaseURL("https://gateway.example.com");
    const openai = normalizeBaseURL("https://gateway.example.com/v1");
    expect(anthropic).not.toBe(openai);
  });

  test("非法 URL best-effort（去尾斜杠+小写）", () => {
    expect(normalizeBaseURL("not a url/")).toBe("not a url");
  });
});

describe("sameEndpoint", () => {
  test("斜杠/大小写差异视为同端点", () => {
    expect(sameEndpoint("https://X.com/v1", "https://x.com/v1/")).toBe(true);
  });
  test("带/不带 /v1 视为不同端点", () => {
    expect(sameEndpoint("https://x.com", "https://x.com/v1")).toBe(false);
  });
  test("两个 undefined（都走官方默认）视为同端点", () => {
    expect(sameEndpoint(undefined, undefined)).toBe(true);
  });
});
