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
import {
  createGoal,
  serializeGoalState,
  serializeGoalStateForPersist,
  deserializeGoalState,
} from "@sid-code/core/goal/state.ts";
import {
  buildGoalReminder,
  buildFirstTurnPrompt,
  buildResumeTurnPrompt,
} from "@sid-code/core/goal/reminder.ts";

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

// ─── F6：evidenceLog 写放大（2026-09-03 排查）───
//
// 缺陷形态：`evidenceLog` 无上限 + 每次变更**全量序列化**落盘（appendMetadata 是
// append 语义），于是第 N 轮那一次写入就有 N 条证据的完整体积。实测 150 轮：
// 单次序列化 328KB、累计写入约 24MB，而**评估器真正读的只有最近 20 条**。
//
// 修法刻意不裁内存（原设计「全量保留用于持久化和 resume」是有意的），只裁落盘：
// 内存全量不变，落盘写「最近 N 条 + 总数」。
describe("F6：持久化与内存分离", () => {
  /** 造一条约 2.2KB 的证据（summary 500 + raw 2000 是字段上限） */
  const makeEvidence = (turn: number) => ({
    turn,
    timestamp: Date.now(),
    type: "test_result" as const,
    summary: `第 ${turn} 轮测试结果 `.padEnd(500, "x"),
    raw: `原始输出 ${turn} `.padEnd(2000, "y"),
  });

  test("落盘只写最近 N 条，内存保持全量（变异自证：修复前必失败）", () => {
    const goal = createGoal("长任务");
    for (let t = 1; t <= 150; t++) goal.evidenceLog.push(makeEvidence(t));

    const persisted = JSON.parse(serializeGoalStateForPersist(goal, 30));
    // 落盘被裁
    expect(persisted.evidenceLog).toHaveLength(30);
    // 内存不受影响（原设计意图：resume 侧保留全量的可能性）
    expect(goal.evidenceLog).toHaveLength(150);
    // 保留的是**最近**的 30 条，不是最早的
    expect(persisted.evidenceLog[29].turn).toBe(150);
    expect(persisted.evidenceLog[0].turn).toBe(121);
  });

  test("总数单独留字段，/goal status 仍能显示真实条数", () => {
    const goal = createGoal("长任务");
    for (let t = 1; t <= 150; t++) goal.evidenceLog.push(makeEvidence(t));
    const persisted = JSON.parse(serializeGoalStateForPersist(goal, 30));
    expect(persisted.evidenceTotalCount).toBe(150);
  });

  test("150 轮单次落盘体积 < 100KB（原为 328KB）", () => {
    const goal = createGoal("长任务");
    for (let t = 1; t <= 150; t++) goal.evidenceLog.push(makeEvidence(t));
    const full = serializeGoalState(goal).length;
    const trimmed = serializeGoalStateForPersist(goal, 30).length;
    expect(trimmed).toBeLessThan(100_000);
    // 相对全量必须有量级差，否则这条修复没意义
    expect(trimmed).toBeLessThan(full / 3);
  });

  test("只对较早的证据剥 raw，最近 5 条保留（评估器输入不回退）", () => {
    // 方案 C：raw 是 2000 字符上限，20 条 × 2000 = 40K 字符对小模型上下文已不小。
    const goal = createGoal("长任务");
    for (let t = 1; t <= 40; t++) goal.evidenceLog.push(makeEvidence(t));
    const persisted = JSON.parse(serializeGoalStateForPersist(goal, 30));
    const kept = persisted.evidenceLog;
    // 最后 5 条留 raw
    expect(kept[kept.length - 1].raw).toBeDefined();
    // 更早的只留 summary
    expect(kept[0].raw).toBeUndefined();
    // summary 一条都不能丢——它才是评估器的主判据
    expect(kept.every((e: { summary?: string }) => typeof e.summary === "string")).toBe(true);
  });

  test("证据少于上限时行为与全量序列化一致（不引入差异）", () => {
    const goal = createGoal("短任务");
    for (let t = 1; t <= 3; t++) goal.evidenceLog.push(makeEvidence(t));
    const persisted = JSON.parse(serializeGoalStateForPersist(goal, 30));
    expect(persisted.evidenceLog).toHaveLength(3);
    expect(persisted.evidenceTotalCount).toBe(3);
    // 短 goal 的 raw 全部保留
    expect(persisted.evidenceLog[0].raw).toBeDefined();
  });

  test("裁剪后的记录仍能被 deserializeGoalState 正常读回", () => {
    const goal = createGoal("长任务", { tokenBudget: 50000 });
    goal.turnsUsed = 150;
    goal.tokensUsed = 987654;
    for (let t = 1; t <= 150; t++) goal.evidenceLog.push(makeEvidence(t));

    const restored = deserializeGoalState(serializeGoalStateForPersist(goal, 30));
    expect(restored.turnsUsed).toBe(150);
    expect(restored.tokensUsed).toBe(987654);
    expect(restored.tokenBudget).toBe(50000);
    expect(restored.evidenceLog).toHaveLength(30);
  });
});
