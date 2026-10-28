/**
 * #8 / #9（2026-10-27）：`-p` JSON 的 usage_normalized 必须跨 provider 同口径。
 * 数据取自 bug2mr P3 两个真实会话（文档 §7.1 表格）。
 */

import { describe, test, expect } from "bun:test";
import { normalizeModelUsage, providersOf } from "../src/headless-usage.ts";

const anthropic = {
  cumulativePromptTokens: 7_849,
  outputTokens: 100,
  cacheReadInputTokens: 507_935,
  cacheCreationInputTokens: 174_899,
  provider: "anthropic",
};
const glm = {
  cumulativePromptTokens: 3_244_574,
  outputTokens: 200,
  cacheReadInputTokens: 3_039_680,
  cacheCreationInputTokens: 0,
  provider: "openai",
};

describe("normalizeModelUsage", () => {
  test("anthropic：prompt_total = 三段之和（账本 690,683）", () => {
    const n = normalizeModelUsage({ "claude-opus-5-5": anthropic });
    expect(n.prompt_total).toBe(690_683);
    expect(n.uncached).toBe(7_849);
  });

  test("openai 兼容：prompt_total = inputTokens 本身（账本 3,244,574），不是 628 万", () => {
    const n = normalizeModelUsage({ "glm-5.3-uniapi": glm });
    expect(n.prompt_total).toBe(3_244_574);
    expect(n.uncached).toBe(3_244_574 - 3_039_680);
    expect(n.cache_read).toBe(3_039_680);
  });

  test("中途换 provider：逐模型归一化后再相加", () => {
    const n = normalizeModelUsage({ a: anthropic, b: glm });
    expect(n.prompt_total).toBe(690_683 + 3_244_574);
    expect(n.uncached + n.cache_read + n.cache_write).toBe(n.prompt_total);
    expect(n.output).toBe(300);
  });

  test("providersOf：单值原样，多值拼接，空为 undefined", () => {
    expect(providersOf({ a: anthropic })).toBe("anthropic");
    expect(providersOf({ a: anthropic, b: glm })).toBe("anthropic,openai");
    expect(providersOf({})).toBeUndefined();
  });
});
