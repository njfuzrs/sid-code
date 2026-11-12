/**
 * 请求输出预算（`llm/output-budget.ts`）单测
 *
 * 锁住 F1 修复的语义：`config.maxTokens` 是**本次请求预留多少输出**（预算），
 * 不是模型物理输出上限（属性）。旧实现把物理上限（DeepSeek 384k）当 max_tokens 发出去，
 * 而 OpenAI 兼容协议族按「输入 + max_tokens ≤ 窗口」校验 → 输入过 664k 即 400。
 *
 * 覆盖 7 条（对应方案文档 §6.1 的「新增：output-budget.test.ts」清单）：
 *   ① 默认 32,768；
 *   ② 不超过物理上限；
 *   ③ 输入 + 预算不超过窗口；
 *   ④ 用户显式值同样受窗口约束；
 *   ⑤ 思考预算下限：manual max 档 budget_tokens=50K 时结果 ≥ 58K 且 > budget；
 *   ⑥ 窗口不足时 thinkingBudget 同步下调（保证 budget_tokens < max_tokens）；
 *   ⑦ 窗口钳制结果低于 floor 时返回「拒绝发请求」而不是 0 / 负数。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  DEFAULT_REQUEST_MAX_TOKENS,
  THINKING_BODY_RESERVE,
  MIN_THINKING_BUDGET,
  resolveRequestOutputBudget,
  resolveFloorOutputTokens,
} from "@sid-code/core/llm/output-budget.ts";

/** 一份「正常主会话」的基准输入：1M 窗口、45k 输入、DeepSeek 的 384K 物理上限。 */
const BASE = {
  requestBudget: DEFAULT_REQUEST_MAX_TOKENS,
  modelMaxOutputTokens: 393_216,
  contextWindow: 1_048_576,
  estimatedInputTokens: 45_000,
};

const ORIGINAL_FLOOR_ENV = process.env.SID_RECOVERY_FLOOR_TOKENS;

beforeEach(() => {
  // floor 的 env 覆盖会同时影响恢复与发送前检查，测里必须显式清掉，避免吃宿主环境
  delete process.env.SID_RECOVERY_FLOOR_TOKENS;
});

afterEach(() => {
  // 存/恢复原值，不要无条件 delete（同批多文件跑在同一进程里）
  if (ORIGINAL_FLOOR_ENV === undefined) delete process.env.SID_RECOVERY_FLOOR_TOKENS;
  else process.env.SID_RECOVERY_FLOOR_TOKENS = ORIGINAL_FLOOR_ENV;
});

describe("resolveRequestOutputBudget", () => {
  test("① 默认请求预算 = 32,768（不按模型族分档）", () => {
    const r = resolveRequestOutputBudget(BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.maxTokens).toBe(DEFAULT_REQUEST_MAX_TOKENS);
    expect(r.clampedBy).toBe("request");
  });

  test("② 不超过模型物理上限（物理上限只作钳制）", () => {
    const r = resolveRequestOutputBudget({
      ...BASE,
      requestBudget: 500_000,
      modelMaxOutputTokens: 100_000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.maxTokens).toBe(100_000);
    expect(r.clampedBy).toBe("model");
  });

  test("③ 输入 + 预算不超过窗口：窗口剩余参与钳制", () => {
    const r = resolveRequestOutputBudget({
      ...BASE,
      contextWindow: 200_000,
      estimatedInputTokens: 150_000,
      requestBudget: 100_000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 窗口 200k − 输入 150k − 安全余量 1k = 49k
    expect(r.maxTokens).toBe(200_000 - 150_000 - 1_000);
    expect(r.clampedBy).toBe("window");
    expect(150_000 + r.maxTokens).toBeLessThanOrEqual(200_000);
  });

  test("④ 用户显式值同样受窗口约束（写多大都不会导致超窗 400）", () => {
    const r = resolveRequestOutputBudget({
      ...BASE,
      contextWindow: 200_000,
      estimatedInputTokens: 150_000,
      // 用户显式把预算开到很大
      requestBudget: 1_000_000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.maxTokens).toBe(49_000);
  });

  test("⑤ 思考预算下限：manual max 档 50K → max_tokens ≥ 58,192 且 > budget", () => {
    const r = resolveRequestOutputBudget({
      ...BASE,
      requestBudget: DEFAULT_REQUEST_MAX_TOKENS,
      thinkingBudgetTokens: 50_000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 只「一并计入」不够：必须给正文留出 THINKING_BODY_RESERVE，否则全是思考、正文没写就截断
    expect(r.maxTokens).toBe(50_000 + THINKING_BODY_RESERVE);
    expect(r.maxTokens).toBeGreaterThan(50_000);
    expect(r.thinkingBudgetTokens).toBe(50_000);
  });

  test("⑥ 窗口不足时 thinkingBudget 同步下调，保证 budget_tokens < max_tokens", () => {
    const r = resolveRequestOutputBudget({
      ...BASE,
      contextWindow: 100_000,
      estimatedInputTokens: 55_000,
      thinkingBudgetTokens: 50_000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 窗口 100k − 输入 55k − 1k = 44k，把 max_tokens 压到 44k
    expect(r.maxTokens).toBe(44_000);
    expect(r.clampedBy).toBe("window");
    // 只钳 max_tokens 会让 budget(50k) ≥ max_tokens(44k) → Anthropic 必然 400
    expect(r.thinkingBudgetTokens).toBe(44_000 - THINKING_BODY_RESERVE);
    expect(r.thinkingBudgetTokens!).toBeLessThan(r.maxTokens);
  });

  test("⑥b 窗口连「思考 + 正文余量」都放不下时关闭思考（不留非法组合）", () => {
    const r = resolveRequestOutputBudget({
      ...BASE,
      contextWindow: 100_000,
      estimatedInputTokens: 91_000,
      thinkingBudgetTokens: 50_000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 窗口剩余 8k：budget 只能给到 −192，低于 Anthropic 下限 → 关掉思考
    expect(r.maxTokens).toBe(8_000);
    expect(r.thinkingBudgetTokens).toBeUndefined();
    expect(8_000).toBeGreaterThan(MIN_THINKING_BUDGET);
  });

  test("⑦ 窗口剩余低于 floor → 返回拒绝发请求（不是 0 / 负数）", () => {
    const r = resolveRequestOutputBudget({
      ...BASE,
      contextWindow: 100_000,
      estimatedInputTokens: 96_000,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("window_exhausted");
    // 窗口剩余 3k < floor（100k × 5% = 5k）
    expect(r.windowLimitTokens).toBe(3_000);
    expect(r.floorTokens).toBe(5_000);
  });

  test("⑦b 输入估算本身超过窗口 → 同样拒绝，不产生负数 max_tokens", () => {
    const r = resolveRequestOutputBudget({
      ...BASE,
      contextWindow: 200_000,
      estimatedInputTokens: 250_000,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.windowLimitTokens).toBeLessThan(0);
  });

  test("floor 可经 SID_RECOVERY_FLOOR_TOKENS 覆盖（与溢出恢复共用同一常量）", () => {
    process.env.SID_RECOVERY_FLOOR_TOKENS = "8000";
    expect(resolveFloorOutputTokens(100_000)).toBe(8_000);
    const r = resolveRequestOutputBudget({
      ...BASE,
      contextWindow: 100_000,
      estimatedInputTokens: 96_000,
    });
    // 窗口剩余 3k < 覆盖后的 floor 8k → 拒绝
    expect(r.ok).toBe(false);
  });

  test("非法预算（NaN / ≤0）回落到默认 32,768", () => {
    for (const bad of [Number.NaN, 0, -1]) {
      const r = resolveRequestOutputBudget({ ...BASE, requestBudget: bad });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.maxTokens).toBe(DEFAULT_REQUEST_MAX_TOKENS);
    }
  });
});
