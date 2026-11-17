/**
 * G2（2026-11-16）：goal 等待挂起判据单测
 *
 * 覆盖修复方案 §4.2 的四条验收：
 * - T-G2-1：有显式等待源 → 放行 end_turn、不调评估器、goal 仍 active
 * - T-G2-2：只有普通后台 shell / 派生任务 → 照常评估（窄口径，不是 hasPromisedWait）
 * - T-G2-3：同一组等待源连续放行到上限后 → 回到评估器
 * - T-G2-4：有待投递通知 → 也放行
 *
 * 外加两条边界：换组重置、等待源释放清零。
 *
 * 本文件只测纯函数（`collectGoalWaitingFacts` / `decideWaitSuspend`），
 * 端到端接线在 goal-gate.test.ts 的「G2 等待挂起」describe 里。
 */

import { describe, test, expect } from "bun:test";
import {
  collectGoalWaitingFacts,
  decideWaitSuspend,
  MAX_CONSECUTIVE_WAIT_PASSES,
} from "@sid-code/core/query/goal-waiting.ts";
import { createGoal } from "@sid-code/core/goal/state.ts";
import type { GoalState } from "@sid-code/core/goal/state.ts";
import type { WaitSource } from "@sid-code/core/task/index.ts";

/** 最小 WaitSource 工厂（只填判据读得到的字段，其余取缺省）。 */
function waitSource(over: Partial<WaitSource> & { id: string }): WaitSource {
  return {
    kind: "monitor",
    promise: { kind: "terminal" },
    description: `等待 ${over.id}`,
    registeredAt: Date.now(),
    ...over,
  };
}

/** 走一次「判定 + 写回」，模拟 goal-gate 的用法。 */
function step(goal: GoalState, waits: readonly WaitSource[], pending = false) {
  const decision = decideWaitSuspend(goal, collectGoalWaitingFacts(waits, pending));
  goal.waitPass = decision.nextWaitPass;
  return decision;
}

// ─── 窄口径：收集事实 ───

describe("collectGoalWaitingFacts · 窄口径", () => {
  test("monitor / wakeup / 带 deadline 的 shell 都算显式等待", () => {
    const monitor = collectGoalWaitingFacts([waitSource({ id: "mon_1" })], false);
    expect(monitor.hasDeclaredExternalWait).toBe(true);
    expect(monitor.waitIds).toEqual(["mon_1"]);

    const wakeup = collectGoalWaitingFacts(
      [waitSource({ id: "wake_1", kind: "wakeup", promise: { kind: "deadline", deadlineAt: 0 } })],
      false,
    );
    expect(wakeup.hasDeclaredExternalWait).toBe(true);

    const deadlineShell = collectGoalWaitingFacts(
      [
        waitSource({
          id: "sh_1",
          kind: "shell",
          promise: { kind: "deadline", deadlineAt: 0 },
        }),
      ],
      false,
    );
    expect(deadlineShell.hasDeclaredExternalWait).toBe(true);
  });

  test("普通后台 shell（exit_or_quiescent）与派生 agent / workflow 不算", () => {
    // 这一条是 T-G2-2 的根：判据若换成 hasPromisedWait，这里会变成 true，
    // 一次无关的 `bun test &` 就能让 goal 永远不评估（D12 的教训）。
    const plainShell = waitSource({
      id: "sh_plain",
      kind: "shell",
      promise: { kind: "exit_or_quiescent" },
    });
    const agent = waitSource({ id: "agent_1", kind: "agent" });
    const workflow = waitSource({ id: "wf_1", kind: "workflow" });

    const facts = collectGoalWaitingFacts([plainShell, agent, workflow], false);
    expect(facts.hasDeclaredExternalWait).toBe(false);
    expect(facts.waitIds).toEqual([]);
  });

  test("混合时只挑出显式等待的 id", () => {
    const facts = collectGoalWaitingFacts(
      [
        waitSource({ id: "mon_1" }),
        waitSource({ id: "sh_plain", kind: "shell", promise: { kind: "exit_or_quiescent" } }),
        waitSource({ id: "sh_2", kind: "shell", promise: { kind: "deadline", deadlineAt: 0 } }),
      ],
      false,
    );
    expect(facts.waitIds.sort()).toEqual(["mon_1", "sh_2"]);
  });
});

// ─── 放行判定 ───

describe("decideWaitSuspend · 放行", () => {
  test("没有事实（调用方未注入）→ 不放行，计数清零", () => {
    const goal = createGoal("完成迁移工作");
    const decision = decideWaitSuspend(goal, undefined);
    expect(decision.release).toBe(false);
    expect(decision.nextWaitPass).toBeUndefined();
  });

  test("只有待投递通知 → 放行，键为 notification 占位", () => {
    const goal = createGoal("完成迁移工作");
    const d = step(goal, [], true);
    expect(d.release).toBe(true);
    expect(d.count).toBe(1);
    expect(goal.waitPass).toEqual({ key: "notification", count: 1 });
  });

  test("显式等待第 1 次 → 放行并记 count=1", () => {
    const goal = createGoal("完成迁移工作");
    const d = step(goal, [waitSource({ id: "mon_1" })]);
    expect(d.release).toBe(true);
    expect(d.waitIds).toEqual(["mon_1"]);
    // 计数键是等待**类型**，不是实例 id：id 天然唯一，拿它当键会被「每轮换一个新
    // monitor」绕过（见 goal-waiting.ts 的 waitKinds 注释与下面的防回归用例）。
    expect(goal.waitPass).toEqual({ key: "monitor", count: 1 });
  });

  test("同一类型的多个实例归为一组：键不随实例数量/顺序变化", () => {
    const goalA = createGoal("完成迁移工作");
    step(goalA, [waitSource({ id: "b" }), waitSource({ id: "a" })]);
    const goalB = createGoal("完成迁移工作");
    step(goalB, [waitSource({ id: "a" })]);
    expect(goalA.waitPass!.key).toBe(goalB.waitPass!.key);
    expect(goalA.waitPass!.key).toBe("monitor");
  });
});

// ─── 连续放行上限 ───

describe("decideWaitSuspend · 连续放行上限", () => {
  test("同一组等待源放行到上限后不再放行（回到评估器）", () => {
    const goal = createGoal("完成迁移工作");
    const waits = [waitSource({ id: "mon_1" })];

    for (let i = 1; i <= MAX_CONSECUTIVE_WAIT_PASSES; i++) {
      const d = step(goal, waits);
      expect(d.release).toBe(true);
      expect(d.count).toBe(i);
    }

    const over = step(goal, waits);
    expect(over.release).toBe(false);
    // 计数保持不动：之后每次 end_turn 都会评估，直到释放或换组。
    expect(goal.waitPass).toEqual({ key: "monitor", count: MAX_CONSECUTIVE_WAIT_PASSES });
  });

  test("换等待源类型 → 从 0 起算（换一种等法是新的机会）", () => {
    const goal = createGoal("完成迁移工作");
    const first = [waitSource({ id: "mon_1" })];
    for (let i = 0; i < MAX_CONSECUTIVE_WAIT_PASSES; i++) step(goal, first);
    expect(step(goal, first).release).toBe(false);

    // monitor 到顶后改用 wakeup：类型集合变了，给满新的 3 次。
    const d = step(goal, [
      waitSource({ id: "wake_1", kind: "wakeup", promise: { kind: "deadline", deadlineAt: 0 } }),
    ]);
    expect(d.release).toBe(true);
    expect(d.count).toBe(1);
    expect(goal.waitPass).toEqual({ key: "wakeup", count: 1 });
  });

  test("换实例但类型不变 → 不重置：每轮重挂新 monitor 绕不过上限", () => {
    // 2026-11-16 复核发现的旁路：等待 id 由工具生成、天然唯一，用 id 当计数键时
    // 模型每轮重挂一个新 monitor 就重置为 0（实测连续 10 个新 id → 10 次全放行）。
    // 这条用例是本轮修复的防回归：期望值来自「上限必须真的封顶」这个契约，
    // 不是从修复后的实现反推。
    const goal = createGoal("完成迁移工作");
    const releases: boolean[] = [];
    for (let i = 1; i <= MAX_CONSECUTIVE_WAIT_PASSES + 2; i++) {
      releases.push(step(goal, [waitSource({ id: `mon_${i}` })]).release);
    }
    expect(releases).toEqual([true, true, true, false, false]);
    expect(goal.waitPass).toEqual({ key: "monitor", count: MAX_CONSECUTIVE_WAIT_PASSES });
  });

  test("等待源全部释放 → 清零，下次重新给满次数", () => {
    const goal = createGoal("完成迁移工作");
    const waits = [waitSource({ id: "mon_1" })];
    for (let i = 0; i < MAX_CONSECUTIVE_WAIT_PASSES; i++) step(goal, waits);
    expect(step(goal, waits).release).toBe(false);

    // 事件到达、等待源释放：这一步返回不放行（交回评估器），同时把计数清掉。
    const released = step(goal, []);
    expect(released.release).toBe(false);
    expect(goal.waitPass).toBeUndefined();

    // 用户又挂上同一个等待源：重新有 3 次机会。
    const again = step(goal, waits);
    expect(again.release).toBe(true);
    expect(again.count).toBe(1);
  });
});

// ─── trace 口径（C1 / C2，2026-11-17） ───

describe("decideWaitSuspend · trace 需要的两个判别位", () => {
  test("放行且是显式等待 → exhausted=false, notificationOnly=false", () => {
    const goal = createGoal("完成迁移工作");
    const d = step(goal, [waitSource({ id: "mon_1" })]);
    expect(d.release).toBe(true);
    expect(d.exhausted).toBe(false);
    expect(d.notificationOnly).toBe(false);
  });

  test("放行且只有待投递通知 → notificationOnly=true（`wait_ids` 为空时的唯一判别）", () => {
    const goal = createGoal("完成迁移工作");
    const d = step(goal, [], true);
    expect(d.waitIds).toEqual([]);
    expect(d.notificationOnly).toBe(true);
  });

  test("到顶 → exhausted=true（否则这一轮在 trace 里完全不存在）", () => {
    const goal = createGoal("完成迁移工作");
    const waits = [waitSource({ id: "mon_1" })];
    for (let i = 0; i < MAX_CONSECUTIVE_WAIT_PASSES; i++) step(goal, waits);

    const over = step(goal, waits);
    expect(over.release).toBe(false);
    expect(over.exhausted).toBe(true);
    // 到顶事件也要能对上是「在等谁」，所以 waitIds / count 必须带出来。
    expect(over.waitIds).toEqual(["mon_1"]);
    expect(over.count).toBe(MAX_CONSECUTIVE_WAIT_PASSES);
  });

  test("无等待（含调用方没给事实）→ 两个判别位都是 false，不会被误记成到顶", () => {
    const goal = createGoal("完成迁移工作");
    expect(decideWaitSuspend(goal, undefined).exhausted).toBe(false);
    expect(decideWaitSuspend(goal, undefined).notificationOnly).toBe(false);

    const released = step(goal, []);
    expect(released.exhausted).toBe(false);
    expect(released.notificationOnly).toBe(false);
  });
});
