/**
 * D5：MCP 输出上限必须按 token 守住，不能按英文启发式放行中文。
 *
 * 旧实现：字符数 ≤ maxChars×0.5（5 万）直接放行。TokenEstimator 对非 ASCII
 * 按 0.65 tok/char，「中」×50000 = 32501 token，已经超过默认 25000，却标成没超。
 * 超限后按 maxChars=100000 切，截完仍是上限的 2.6 倍。
 *
 * 判据：截断后喂给模型的正文（去掉引导语）用同一套 estimator 估，必须 ≤ maxTokens。
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  enforceMcpOutputTokenLimit,
  getMaxMcpOutputTokens,
  DEFAULT_MAX_MCP_OUTPUT_TOKENS,
} from "@sid-code/core/mcp/mcp-output-limit.ts";
import { TokenEstimator } from "@sid-code/core/llm/token-estimator.ts";

const estimator = new TokenEstimator();

function restoreEnv(key: string, orig: string | undefined): void {
  if (orig === undefined) delete process.env[key];
  else process.env[key] = orig;
}

describe("getMaxMcpOutputTokens", () => {
  const origSid = process.env.SID_CODE_MAX_MCP_OUTPUT_TOKENS;
  const origCc = process.env.MAX_MCP_OUTPUT_TOKENS;
  afterEach(() => {
    restoreEnv("SID_CODE_MAX_MCP_OUTPUT_TOKENS", origSid);
    restoreEnv("MAX_MCP_OUTPUT_TOKENS", origCc);
  });

  test("默认 25000", () => {
    delete process.env.SID_CODE_MAX_MCP_OUTPUT_TOKENS;
    delete process.env.MAX_MCP_OUTPUT_TOKENS;
    expect(getMaxMcpOutputTokens()).toBe(DEFAULT_MAX_MCP_OUTPUT_TOKENS);
  });

  test("SID_CODE_MAX_MCP_OUTPUT_TOKENS 优先于无前缀兜底", () => {
    process.env.SID_CODE_MAX_MCP_OUTPUT_TOKENS = "1000";
    process.env.MAX_MCP_OUTPUT_TOKENS = "9999";
    expect(getMaxMcpOutputTokens()).toBe(1000);
  });

  test("非法值回退默认", () => {
    process.env.SID_CODE_MAX_MCP_OUTPUT_TOKENS = "-1";
    expect(getMaxMcpOutputTokens()).toBe(DEFAULT_MAX_MCP_OUTPUT_TOKENS);
  });
});

describe("enforceMcpOutputTokenLimit", () => {
  test("短 ASCII 不截断", () => {
    const r = enforceMcpOutputTokenLimit("hello world", 25000);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe("hello world");
  });

  test("「a」×50000 不截断（英文路径符合设计，约 1 万 token）", () => {
    const text = "a".repeat(50_000);
    const r = enforceMcpOutputTokenLimit(text, 25000);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe(text);
    expect(estimator.estimateText(text)).toBeLessThanOrEqual(25000);
  });

  test("「中」×50000 必须截断，且截完正文 ≤ 25000 token（守 D5）", () => {
    const text = "中".repeat(50_000);
    expect(estimator.estimateText(text)).toBeGreaterThan(25000);

    const r = enforceMcpOutputTokenLimit(text, 25000);
    expect(r.truncated).toBe(true);
    expect(r.estimatedTokens).toBeGreaterThan(25000);
    expect(r.text).toContain("输出截断");

    const body = r.text.slice(0, r.text.indexOf("\n\n[输出截断"));
    expect(estimator.estimateText(body)).toBeLessThanOrEqual(25000);
    expect(body.length).toBeGreaterThan(0);
    expect(body.length).toBeLessThan(text.length);
  });

  test("「中」×60000 截完仍 ≤ 上限（旧实现按 100000 字符切，截完 39001 token）", () => {
    const text = "中".repeat(60_000);
    const r = enforceMcpOutputTokenLimit(text, 25000);
    expect(r.truncated).toBe(true);
    const body = r.text.slice(0, r.text.indexOf("\n\n[输出截断"));
    expect(estimator.estimateText(body)).toBeLessThanOrEqual(25000);
  });

  test("刚好压在上限内的中文不截断", () => {
    // 25000 / 0.65 ≈ 38461 字；取更小一截保证 ceil 后仍 ≤ 25000
    const text = "中".repeat(30_000);
    expect(estimator.estimateText(text)).toBeLessThanOrEqual(25000);
    const r = enforceMcpOutputTokenLimit(text, 25000);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe(text);
  });

  test("自定义上限：1000 token 的中文超限同样守住", () => {
    const text = "中".repeat(5_000);
    const r = enforceMcpOutputTokenLimit(text, 1000);
    expect(r.truncated).toBe(true);
    const body = r.text.slice(0, r.text.indexOf("\n\n[输出截断"));
    expect(estimator.estimateText(body)).toBeLessThanOrEqual(1000);
  });
});
