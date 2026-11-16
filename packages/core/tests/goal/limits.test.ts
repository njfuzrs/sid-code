/**
 * Goal 硬约束检查（每轮执行）— 单元测试
 *
 * 守的是 2026-11-16 事故的根因分支：轮次 / 预算上限**只在 end_turn 评估时才检查**，
 * 于是模型连续 tool_use 空转时上限一次都没生效。这里的用例只验判定本身
 * （不启动主循环），「每轮真的被调用」由 `tests/integration/goal-hard-limits-loop.test.ts` 守。
 */

import { describe, test, expect } from "bun:test";
import {
  checkGoalHardLimits,
  buildGoalTurnsLimitMessage,
  buildGoalLimitSummaryPrompt,
} from "@sid-code/core/goal/limits.ts";
import { createGoal } from "@sid-code/core/goal/state.ts";
import { GOAL_BUDGET_WARNING_RATIO } from "@sid-code/core/goal/budget.ts";

const usage = (inputTokens: number, outputTokens = 0) => ({ inputTokens, outputTokens });

describe("checkGoalHardLimits · 轮次", () => {
  test("turnsUsed 达到 maxTurns → turns_limited（>= 而非 >）", () => {
    const goal = createGoal("推进目标", { maxTurns: 3 });
    goal.turnsUsed = 3;
    expect(checkGoalHardLimits(goal, usage(10)).kind).toBe("turns_limited");
  });

  test("turnsUsed 差一轮 → ok，让人把最后一轮跑完", () => {
    const goal = createGoal("推进目标", { maxTurns: 3 });
    goal.turnsUsed = 2;
    expect(checkGoalHardLimits(goal, usage(10)).kind).toBe("ok");
  });

  test("预算耗尽优先于轮次耗尽（两条归因不能粘在一起）", () => {
    const goal = createGoal("推进目标", { maxTurns: 3, tokenBudget: 100 });
    goal.turnsUsed = 3;
    const r = checkGoalHardLimits(goal, usage(200));
    expect(r.kind).toBe("budget_limited");
    expect(goal.status).not.toBe("turns_limited"); // 函数本身不改 status
  });
});

describe("checkGoalHardLimits · 预算", () => {
  test("超过 100% → budget_limited", () => {
    const goal = createGoal("推进目标", { tokenBudget: 1000 });
    expect(checkGoalHardLimits(goal, usage(1100)).kind).toBe("budget_limited");
  });

  test("≥85% 但未超 100% → budget_warning", () => {
    const goal = createGoal("推进目标", { tokenBudget: 1000 });
    const r = checkGoalHardLimits(goal, usage(Math.ceil(1000 * GOAL_BUDGET_WARNING_RATIO)));
    expect(r.kind).toBe("budget_warning");
    if (r.kind === "budget_warning") expect(r.firstNotice).toBe(true);
  });

  test("告警只报一次：持续处于告警档时第二次 firstNotice=false", () => {
    const goal = createGoal("推进目标", { tokenBudget: 1000 });
    goal.tokensUsed = 850;
    const first = checkGoalHardLimits(goal, usage(1));
    const second = checkGoalHardLimits(goal, usage(1));
    expect(first.kind).toBe("budget_warning");
    expect(second.kind).toBe("budget_warning");
    if (first.kind === "budget_warning") expect(first.firstNotice).toBe(true);
    if (second.kind === "budget_warning") expect(second.firstNotice).toBe(false);
  });

  test("无预算时也记账，但只返回 ok（门控不生效 ≠ 不统计）", () => {
    const goal = createGoal("推进目标");
    expect(checkGoalHardLimits(goal, usage(500, 200)).kind).toBe("ok");
    expect(goal.tokensUsed).toBe(700);
  });

  test("自带累加：连续两次检查各入账一次（调用方不得再调 accumulateGoalTokens）", () => {
    const goal = createGoal("推进目标", { tokenBudget: 100000 });
    checkGoalHardLimits(goal, usage(100));
    checkGoalHardLimits(goal, usage(100));
    expect(goal.tokensUsed).toBe(200);
  });
});

describe("goal 上限文案", () => {
  test("轮次耗尽提示点名 /goal turns，不误导成 --max-turns", () => {
    const goal = createGoal("推进目标", { maxTurns: 5 });
    goal.turnsUsed = 5;
    const msg = buildGoalTurnsLimitMessage(goal);
    expect(msg).toContain("5 / 5 轮");
    expect(msg).toContain("总结已完成");
  });

  test("总结轮提示按来源区分，且给出对应的 /goal 调整出口", () => {
    const goal = createGoal("推进目标", { maxTurns: 5, tokenBudget: 1000 });
    goal.turnsUsed = 5;
    goal.tokensUsed = 1000;
    expect(buildGoalLimitSummaryPrompt(goal, "turns")).toContain("/goal turns");
    expect(buildGoalLimitSummaryPrompt(goal, "budget")).toContain("/goal budget");
  });

  test("goal 已被清掉时（undefined）仍能产出不含数字的提示，不抛异常", () => {
    const msg = buildGoalLimitSummaryPrompt(undefined, "turns");
    expect(msg).toContain("轮次预算已用尽");
    expect(msg).not.toContain("NaN");
  });
});
