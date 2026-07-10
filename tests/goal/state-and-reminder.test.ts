/**
 * GoalState + Reminder 单测
 *
 * 验证：
 * - createGoal 正确初始化所有字段
 * - serializeGoalState / deserializeGoalState 往返一致
 * - buildGoalReminder 输出包含关键信息
 * - buildFirstTurnPrompt 输出包含目标条件
 */

import { describe, test, expect } from "bun:test";
import { createGoal, serializeGoalState, deserializeGoalState } from "../../src/goal/state.ts";
import { buildGoalReminder, buildFirstTurnPrompt, buildResumeTurnPrompt } from "../../src/goal/reminder.ts";

describe("createGoal", () => {
  test("使用默认值正确初始化", () => {
    const goal = createGoal("让 bun test 通过");
    expect(goal.id).toBeDefined();
    expect(goal.objective).toBe("让 bun test 通过");
    expect(goal.status).toBe("active");
    expect(goal.tokensUsed).toBe(0);
    expect(goal.turnsUsed).toBe(0);
    expect(goal.maxTurns).toBe(150);
    expect(goal.evidenceLog).toEqual([]);
    expect(goal.createdAt).toBeGreaterThan(0);
    expect(goal.updatedAt).toBeGreaterThan(0);
  });

  test("可指定 tokenBudget 和 maxTurns", () => {
    const goal = createGoal("测试", { tokenBudget: 200000, maxTurns: 30 });
    expect(goal.tokenBudget).toBe(200000);
    expect(goal.maxTurns).toBe(30);
  });
});

describe("serializeGoalState / deserializeGoalState", () => {
  test("往返序列化保持所有字段", () => {
    const original = createGoal("修复 lint 错误", { tokenBudget: 50000 });
    original.turnsUsed = 5;
    original.tokensUsed = 12000;
    original.status = "paused";
    original.lastEvalReason = "测试仍有 2 个失败";
    original.evidenceLog = [
      { turn: 3, timestamp: Date.now(), type: "test_result", summary: "2 failures" },
    ];

    const json = serializeGoalState(original);
    const restored = deserializeGoalState(json);

    expect(restored.id).toBe(original.id);
    expect(restored.objective).toBe(original.objective);
    expect(restored.status).toBe("paused");
    expect(restored.turnsUsed).toBe(5);
    expect(restored.tokensUsed).toBe(12000);
    expect(restored.tokenBudget).toBe(50000);
    expect(restored.lastEvalReason).toBe("测试仍有 2 个失败");
    expect(restored.evidenceLog).toHaveLength(1);
    expect(restored.evidenceLog[0].type).toBe("test_result");
  });

  test("缺失字段使用安全默认值", () => {
    const minimal = JSON.stringify({ objective: "最小" });
    const restored = deserializeGoalState(minimal);
    expect(restored.id).toBeDefined();
    expect(restored.objective).toBe("最小");
    expect(restored.status).toBe("active");
    expect(restored.tokensUsed).toBe(0);
    expect(restored.turnsUsed).toBe(0);
    expect(restored.evidenceLog).toEqual([]);
  });
});

describe("buildGoalReminder", () => {
  test("包含目标条件和轮次信息", () => {
    const goal = createGoal("让 bun test 通过");
    goal.turnsUsed = 3;
    goal.maxTurns = 50;
    const reminder = buildGoalReminder(goal);
    expect(reminder).toContain("让 bun test 通过");
    expect(reminder).toContain("3");
    expect(reminder).toContain("50");
  });

  test("有 lastEvalReason 时包含评估反馈", () => {
    const goal = createGoal("修复 bug");
    goal.turnsUsed = 5;
    goal.lastEvalReason = "测试仍有 3 个失败";
    goal.evidenceLog = [
      { turn: 2, timestamp: Date.now(), type: "test_result", summary: "3 failures" },
      { turn: 4, timestamp: Date.now(), type: "file_change", summary: "修改了 auth.ts" },
    ];
    const reminder = buildGoalReminder(goal);
    expect(reminder).toContain("测试仍有 3 个失败");
    expect(reminder).toContain("上次评估");
  });
});

describe("buildFirstTurnPrompt", () => {
  test("包含目标条件和工作指令", () => {
    const goal = createGoal("清空所有 lint 错误");
    const prompt = buildFirstTurnPrompt(goal);
    expect(prompt).toContain("清空所有 lint 错误");
    expect(prompt).toContain("goal");
  });
});

describe("buildResumeTurnPrompt", () => {
  test("包含断点信息和上次评估原因", () => {
    const goal = createGoal("迁移到新 API");
    goal.turnsUsed = 8;
    goal.lastEvalReason = "还有 3 个文件未迁移";
    const prompt = buildResumeTurnPrompt(goal);
    expect(prompt).toContain("迁移到新 API");
    expect(prompt).toContain("还有 3 个文件未迁移");
  });
});
