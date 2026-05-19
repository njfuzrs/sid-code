/**
 * W12.D2 单元测试 — PlanModeManager.recordPlanFileWrite + getPlanFileUpdateCount
 *
 * 见 docs/specs/active/W12-plan-recovery-mechanism.md §3
 *
 * 覆盖：
 * - recordPlanFileWrite 累加：调 3 次后 getPlanFileUpdateCount() === 3
 * - inactive 状态拒绝：enter() 之前调 recordPlanFileWrite 返回 false，count 仍 0
 * - forceExit 重置：planning 状态下记录 2 次 → forceExit → count 归 0
 * - reject 不重置：awaiting_approval 状态下记录 1 次 → reject → 仍能继续记录
 * - getPlanFileUpdateHistory 返回时间戳序列
 */

import { describe, test, expect } from "bun:test";
import { PlanModeManager } from "../../src/plan/state.ts";

describe("PlanModeManager — plan_recovery update count (W12.D2)", () => {
  test("recordPlanFileWrite 累加：调 3 次后 count = 3", () => {
    const m = new PlanModeManager();
    m.enter("default");
    m.recordPlanFileWrite(1000);
    m.recordPlanFileWrite(2000);
    m.recordPlanFileWrite(3000);
    expect(m.getPlanFileUpdateCount()).toBe(3);
  });

  test("inactive 状态拒绝记录：返回 false，count 仍 0", () => {
    const m = new PlanModeManager();
    expect(m.isActive()).toBe(false);
    const ok = m.recordPlanFileWrite();
    expect(ok).toBe(false);
    expect(m.getPlanFileUpdateCount()).toBe(0);
  });

  test("planning 状态下可记录", () => {
    const m = new PlanModeManager();
    m.enter("default");
    expect(m.isPlanning()).toBe(true);
    expect(m.recordPlanFileWrite()).toBe(true);
    expect(m.getPlanFileUpdateCount()).toBe(1);
  });

  test("awaiting_approval 状态下可记录", () => {
    const m = new PlanModeManager();
    m.enter("default");
    m.submitForApproval();
    expect(m.isAwaitingApproval()).toBe(true);
    expect(m.recordPlanFileWrite()).toBe(true);
    expect(m.getPlanFileUpdateCount()).toBe(1);
  });

  test("forceExit 重置 count 为 0", () => {
    const m = new PlanModeManager();
    m.enter("default");
    m.recordPlanFileWrite();
    m.recordPlanFileWrite();
    expect(m.getPlanFileUpdateCount()).toBe(2);

    m.forceExit();
    expect(m.getPlanFileUpdateCount()).toBe(0);
  });

  test("reject 不重置 count（继续在同一份 plan 上修改）", () => {
    const m = new PlanModeManager();
    m.enter("default");
    m.recordPlanFileWrite();
    m.submitForApproval();
    m.reject();
    expect(m.isPlanning()).toBe(true);
    expect(m.getPlanFileUpdateCount()).toBe(1);

    m.recordPlanFileWrite();
    expect(m.getPlanFileUpdateCount()).toBe(2);
  });

  test("getPlanFileUpdateHistory 返回时间戳序列", () => {
    const m = new PlanModeManager();
    m.enter("default");
    m.recordPlanFileWrite(1000);
    m.recordPlanFileWrite(2500);
    m.recordPlanFileWrite(5000);

    const history = m.getPlanFileUpdateHistory();
    expect(history).toEqual([1000, 2500, 5000]);
  });

  test("approve 后转 inactive → 不能再记录", () => {
    const m = new PlanModeManager();
    m.enter("default");
    m.recordPlanFileWrite();
    m.submitForApproval();
    m.approve();
    expect(m.isActive()).toBe(false);

    expect(m.recordPlanFileWrite()).toBe(false);
    // approve 不重置 count（保留 plan 阶段的写入历史）
    expect(m.getPlanFileUpdateCount()).toBe(1);
  });
});
