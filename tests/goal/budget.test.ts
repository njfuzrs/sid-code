/**
 * Goal Budget 单测
 *
 * 验证预算门控逻辑：token 用量累加、三档阈值判定（ok/warning/exceeded）、
 * 无预算时始终 ok。
 */

import { describe, test, expect } from "bun:test";
import { checkGoalBudget, buildBudgetLimitMessage, buildBudgetWarningMessage } from "../../src/goal/budget.ts";
import { createGoal } from "../../src/goal/state.ts";

describe("checkGoalBudget", () => {
  test("无预算时始终返回 ok", () => {
    const goal = createGoal("测试");
    // tokenBudget 默认为 undefined
    const result = checkGoalBudget(goal, { inputTokens: 100000, outputTokens: 50000 });
    expect(result).toBe("ok");
  });

  test("用量低于 85% 返回 ok", () => {
    const goal = createGoal("测试", { tokenBudget: 100000 });
    const result = checkGoalBudget(goal, { inputTokens: 40000, outputTokens: 20000 });
    expect(result).toBe("ok");
    expect(goal.tokensUsed).toBe(60000);
  });

  test("用量达到 85% 返回 warning", () => {
    const goal = createGoal("测试", { tokenBudget: 100000 });
    goal.tokensUsed = 0;
    const result = checkGoalBudget(goal, { inputTokens: 50000, outputTokens: 40000 });
    expect(result).toBe("warning");
    expect(goal.tokensUsed).toBe(90000);
  });

  test("用量达到 100% 返回 exceeded", () => {
    const goal = createGoal("测试", { tokenBudget: 100000 });
    goal.tokensUsed = 80000;
    const result = checkGoalBudget(goal, { inputTokens: 10000, outputTokens: 15000 });
    expect(result).toBe("exceeded");
    expect(goal.tokensUsed).toBe(105000);
  });

  test("cacheCreationTokens 计入用量", () => {
    const goal = createGoal("测试", { tokenBudget: 100000 });
    const result = checkGoalBudget(goal, {
      inputTokens: 30000,
      outputTokens: 20000,
      cacheCreationTokens: 40000,
    });
    // 30000 + 20000 + 40000 = 90000，达到 90% → warning
    expect(result).toBe("warning");
    expect(goal.tokensUsed).toBe(90000);
  });

  test("tokensUsed 跨轮累加", () => {
    const goal = createGoal("测试", { tokenBudget: 100000 });
    checkGoalBudget(goal, { inputTokens: 20000, outputTokens: 10000 });
    expect(goal.tokensUsed).toBe(30000);
    checkGoalBudget(goal, { inputTokens: 20000, outputTokens: 10000 });
    expect(goal.tokensUsed).toBe(60000);
  });
});

describe("buildBudgetLimitMessage", () => {
  test("包含目标和用量信息", () => {
    const goal = createGoal("修复所有 bug", { tokenBudget: 100000 });
    goal.tokensUsed = 105000;
    const msg = buildBudgetLimitMessage(goal);
    expect(msg).toContain("修复所有 bug");
    expect(msg).toContain("105,000");
    expect(msg).toContain("100,000");
    expect(msg).toContain("预算已耗尽");
  });
});

describe("buildBudgetWarningMessage", () => {
  test("包含百分比和剩余量", () => {
    const goal = createGoal("测试", { tokenBudget: 100000 });
    goal.tokensUsed = 90000;
    const msg = buildBudgetWarningMessage(goal);
    expect(msg).toContain("90%");
    expect(msg).toContain("10,000");
  });
});
