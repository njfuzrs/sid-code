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

// ─── G5：等待也是推进 ───
//
// 缺陷形态：模型挂着 monitor / wait_until 等 CI 时，reminder 仍无条件写
// 「继续推进目标」，模型把它读成「不能停下来等」→ 回前台反复 `gh pr checks` 空转。
// 判据必须是**显式声明**的外部等待（isDeclaredExternalWait），不是 hasPromisedWait。
describe("G5：等待版 reminder", () => {
  /** 构造一个 deadline 型等待源（monitor 盯 PR CI） */
  const monitorWait = (deadlineAt: number) => ({
    id: "m7",
    kind: "monitor" as const,
    promise: { kind: "deadline" as const, deadlineAt },
    description: "盯 PR #662 的 CI",
    registeredAt: Date.now(),
  });

  test("有声明等待源时不催「继续推进」，改为说明在等什么、最晚何时回报", () => {
    const goal = createGoal("等 PR CI 通过后合并");
    goal.turnsUsed = 6;
    const deadlineAt = new Date(2026, 10, 16, 14, 32, 0).getTime();
    const reminder = buildGoalReminder(goal, { waitingSources: [monitorWait(deadlineAt)] });

    // 等待源被点名，且带承诺的回报时刻（说明「在等什么、最晚何时」）
    expect(reminder).toContain("监控 m7（盯 PR #662 的 CI）");
    expect(reminder).toContain("最晚 14:32 前回报");
    // 关键：不再出现「继续推进目标」这句祈使句
    expect(reminder).not.toContain("继续推进目标");
    // 明确「挂着等待结束本轮是合法推进」，并禁止前台轮询
    expect(reminder).toContain("结束本轮");
    expect(reminder).toContain("合法推进");
    expect(reminder).toContain("反复查询");
  });

  test("无等待源时保持原有「继续推进」文案，并保留等待指引", () => {
    const goal = createGoal("把测试修到全绿");
    goal.turnsUsed = 3;
    const reminder = buildGoalReminder(goal, { waitingSources: [] });

    expect(reminder).toContain("继续推进目标");
    // G5 第 2 点：即使当前没挂等待，也要告诉模型「等待也是推进」，否则它不敢收尾
    expect(reminder).toContain("等待也是推进");
    expect(reminder).not.toContain("最晚");
  });

  test("等待版文案随等待源内容变化，不是固定字符串（变异自证：去掉 opts 传入即失败）", () => {
    const goal = createGoal("等部署完成");
    const a = buildGoalReminder(goal, {
      waitingSources: [
        {
          id: "w1",
          kind: "wakeup" as const,
          promise: { kind: "deadline" as const, deadlineAt: Date.now() + 60_000 },
          description: "20 分钟后回来复查部署",
          registeredAt: Date.now(),
        },
      ],
    });
    expect(a).toContain("定时唤醒 w1（20 分钟后回来复查部署）");
    // 另一类承诺的措辞也不同（terminal → 「结束即通知」）
    const b = buildGoalReminder(goal, {
      waitingSources: [
        {
          id: "a1",
          kind: "agent" as const,
          promise: { kind: "terminal" as const },
          description: "迁移剩余 3 个文件",
          registeredAt: Date.now(),
        },
      ],
    });
    expect(b).toContain("子代理 a1（迁移剩余 3 个文件），结束即通知");
  });
});

describe("buildFirstTurnPrompt", () => {
  test("包含目标条件和工作指令", () => {
    const goal = createGoal("清空所有 lint 错误");
    const prompt = buildFirstTurnPrompt(goal);
    expect(prompt).toContain("清空所有 lint 错误");
    expect(prompt).toContain("goal");
  });

  // G5：旧文案「在满足上述条件之前，系统不会让你停止」是半真半假的——goal gate 确实会
  // 打回未达成的 end_turn，但挂着等待源收尾是放行的。模型照字面理解就不敢停，只能前台轮询。
  test("不再断言「系统不会让你停止」，改为把「未达成会被推回」与「挂等待可收尾」分开说", () => {
    const goal = createGoal("等 CI 通过并合并 PR");
    const prompt = buildFirstTurnPrompt(goal);
    expect(prompt).not.toContain("系统不会让你停止");
    expect(prompt).toContain("会被评估一次并推回继续");
    expect(prompt).toContain("不会被打回");
    expect(prompt).toContain("等待也是推进");
    // 必须点名具体原语，否则模型不知道「挂等待」怎么落地
    expect(prompt).toContain("monitor");
    expect(prompt).toContain("schedule_wakeup");
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

  test("G5：恢复轮也给出「等外部状态时先挂等待再收尾」的出口", () => {
    const goal = createGoal("等部署完成");
    goal.turnsUsed = 4;
    const prompt = buildResumeTurnPrompt(goal);
    expect(prompt).toContain("先挂上显式等待再收尾");
    expect(prompt).not.toContain("反复轮询状态");
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
