/**
 * PR-6 / F7 第 3 条：spawn 子进程的请求输出预算。
 *
 * 背景：`headless.ts` 曾把 `maxTokens` 写死 4096 —— 子代理在大窗口模型下写长文件 /
 * 长回答会被硬截断，父进程只看到一次 `max_tokens` 停止，无从归因到「子代理的输出预算太小」。
 * 修法是接入与主循环**同一个** `resolveRequestOutputBudget()`，物理上限由父进程随
 * init 的 `max_output_tokens` 传入。
 *
 * 这些断言的意义在于钉死三条容易走反的口径：
 * 1. 物理上限**只作 min**，不是预算（否则 DeepSeek 384k 会被当 max_tokens 发出去）；
 * 2. 未知物理上限时走默认预算，而不是退回 4096；
 * 3. 真正的值由「窗口 − 输入估算 − 安全缓冲」决定，窗口不足时如实拒绝，不发必然 400 的请求。
 */

import { describe, test, expect } from "bun:test";
import { resolveHeadlessSendBudget } from "@sid-code/cli/entrypoints/headless.ts";
import { DEFAULT_REQUEST_MAX_TOKENS } from "@sid-code/core/llm/output-budget.ts";

describe("headless 请求输出预算（PR-6）", () => {
  test("物理上限只作 min：输出上限 8k 的模型 → 8,192，而不是默认 32,768", () => {
    const budget = resolveHeadlessSendBudget(
      { context_window: 200_000, max_output_tokens: 8_192 },
      200_000,
      1_000,
    );
    expect(budget.ok).toBe(true);
    if (budget.ok) {
      expect(budget.maxTokens).toBe(8_192);
      expect(budget.clampedBy).toBe("model");
    }
  });

  test("物理上限未知 → 默认预算，且绝不再是旧的写死值 4096", () => {
    const budget = resolveHeadlessSendBudget({ context_window: 200_000 }, 200_000, 1_000);
    expect(budget.ok).toBe(true);
    if (budget.ok) {
      expect(budget.maxTokens).toBe(DEFAULT_REQUEST_MAX_TOKENS);
      // 回归哨兵：旧实现写死 4096，任何回到「写死小值」的改法都会在这里变红。
      expect(budget.maxTokens).toBeGreaterThan(4_096);
    }
  });

  test("窗口剩余决定本次能发多少（物理上限与默认预算都只作上限）", () => {
    const budget = resolveHeadlessSendBudget(
      { context_window: 10_000, max_output_tokens: 64_000 },
      10_000,
      6_000,
    );
    expect(budget.ok).toBe(true);
    if (budget.ok) {
      // 10,000 窗口 − 6,000 输入 − 1,000 安全缓冲 = 3,000
      expect(budget.maxTokens).toBe(3_000);
      expect(budget.clampedBy).toBe("window");
    }
  });

  test("窗口连 floor 都放不下 → 如实拒绝（不发 0 / 负数换一次必然 400）", () => {
    const budget = resolveHeadlessSendBudget({ context_window: 5_000 }, 5_000, 4_500);
    expect(budget.ok).toBe(false);
    if (!budget.ok) {
      expect(budget.reason).toBe("window_exhausted");
      expect(budget.contextWindow).toBe(5_000);
      expect(budget.estimatedInputTokens).toBe(4_500);
    }
  });

  test("context_window 与 ContextManager 窗口同值：协议字段语义是窗口，不是输出预算", () => {
    // 父进程把 1M 窗口传进来，子进程的 ContextManager 就该是 1M —— 若再把字段当
    // 「输出预算」用，这里会在 32,768 上截住（预算恒 ≤ 窗口，无法直接区分，
    // 所以额外断言：窗口远大于任何输出预算时仍取默认预算）。
    const budget = resolveHeadlessSendBudget(
      { context_window: 1_048_576, max_output_tokens: 64_000 },
      1_048_576,
      10_000,
    );
    expect(budget.ok).toBe(true);
    if (budget.ok) expect(budget.maxTokens).toBe(DEFAULT_REQUEST_MAX_TOKENS);
  });
});
