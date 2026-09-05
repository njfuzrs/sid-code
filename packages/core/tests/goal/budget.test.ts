/**
 * Goal Budget 单测
 *
 * 验证预算门控逻辑：token 用量累加、三档阈值判定（ok/warning/exceeded）、
 * 无预算时始终 ok。
 */

import { describe, test, expect } from "bun:test";
import {
  accumulateGoalTokens,
  checkGoalBudget,
  buildBudgetLimitMessage,
  buildBudgetWarningMessage,
} from "@sid-code/core/goal/budget.ts";
import { createGoal } from "@sid-code/core/goal/state.ts";

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

// ─── F1：未设预算时 tokensUsed 恒为 0（2026-09-03 排查）───
//
// 缺陷形态：累加与门控耦合在同一个 `if (!goal.tokenBudget) return "ok"` 短路之后，
// 而 DEFAULT_GOAL_CONFIG.defaultTokenBudget = 0 → createGoal 把 0 转成 undefined
// → 默认配置下 tokensUsed 永远是 0。后果不止「显示为 0」：中途 /goal budget 100k
// 时这 100k 从 0 重新计，用户设的上限会失真（排查实测 7.8 倍）。
describe("F1：累加与门控解耦", () => {
  test("无预算时也累加 tokensUsed（变异自证：修复前这条必失败）", () => {
    const goal = createGoal("让测试全绿"); // 默认无预算
    accumulateGoalTokens(goal, { inputTokens: 30000, outputTokens: 2000 });
    expect(goal.tokensUsed).toBe(32000);
  });

  test("无预算跑 10 轮后 tokensUsed 等于各轮之和（含 cacheCreation）", () => {
    const goal = createGoal("让测试全绿");
    for (let t = 0; t < 10; t++) {
      accumulateGoalTokens(goal, {
        inputTokens: 30000,
        outputTokens: 2000,
        cacheCreationTokens: 500,
      });
    }
    expect(goal.tokensUsed).toBe(325000);
    expect(goal.tokenBudget).toBeUndefined();
  });

  test("有预算时同一轮用量只入账一次（防双算）", () => {
    // checkGoalBudget 内部仍含累加（保持既有调用方兼容）。goal-gate 改成
    // 「无条件 accumulate → 有预算才 check」后，若两处都累加就会翻倍，
    // 于是预算上限被腰斩。这条专门钉住「一轮用量只入账一次」。
    const goal = createGoal("测试", { tokenBudget: 100000 });
    checkGoalBudget(goal, { inputTokens: 20000, outputTokens: 10000 });
    expect(goal.tokensUsed).toBe(30000); // 不是 60000
  });

  test("两个入口在有预算时口径一致", () => {
    const a = createGoal("测试", { tokenBudget: 100000 });
    const b = createGoal("测试", { tokenBudget: 100000 });
    const usage = { inputTokens: 11111, outputTokens: 2222, cacheCreationTokens: 333 };
    accumulateGoalTokens(a, usage);
    checkGoalBudget(b, usage);
    expect(a.tokensUsed).toBe(b.tokensUsed);
  });
});
