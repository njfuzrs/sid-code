/**
 * W12.D2 单元测试 — PlanModeManager.recordPlanFileWrite + getPlanFileUpdateCount
 *
 * 见 docs/specs/active/W12-plan-recovery-mechanism.md §3
 *
 * 覆盖：
 * - recordPlanFileWrite 累加：调 3 次后 getPlanFileUpdateCount() === 3
 * - inactive 状态拒绝：enter() 之前调 recordPlanFileWrite 返回 false，count 仍 0
 * - P1-1 执行阶段：approve() 后仍能记录（state=inactive 但 isExecuting()=true），
 *   endExecution() / forceExit() 之后才拒绝
 * - forceExit 重置：planning 状态下记录 2 次 → forceExit → count 归 0
 * - reject 不重置：awaiting_approval 状态下记录 1 次 → reject → 仍能继续记录
 * - getPlanFileUpdateHistory 返回时间戳序列
 */

import { describe, test, expect } from "bun:test";
import { PlanModeManager } from "@sid-code/core/plan/state.ts";

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

  // ---- P1-1：执行阶段的计划文件更新必须计入 ----
  //
  // 这个用例从前断言的是「approve 后不能再记录」，那正是 P1-1 的缺陷本体：
  // recordPlanFileWrite 用 `state === "inactive"` 当拒绝条件，而 approve() 之后
  // state 恰好是 inactive、isExecuting() 为真（两者刻意正交）。于是执行阶段
  // ——也就是批准消息要求「失败先更新计划文件」的那整个阶段——的更新一次都不计，
  // plan_recovery 评测读到的 count 恒等于规划阶段的写入次数。
  //
  // 现在的口径是「规划态 or 执行阶段」才记录，两头（未 enter、已收尾）仍拒绝。
  test("P1-1：approve 后进入执行阶段 → 仍能记录（count 继续累加）", () => {
    const m = new PlanModeManager();
    m.enter("default");
    m.recordPlanFileWrite();
    m.submitForApproval();
    m.approve();
    // 执行阶段的定义：state 已 inactive，但 isExecuting() 为真
    expect(m.isActive()).toBe(false);
    expect(m.isExecuting()).toBe(true);

    expect(m.recordPlanFileWrite()).toBe(true);
    // approve 不重置 count，执行阶段的这次更新叠加在规划阶段的 1 次之上
    expect(m.getPlanFileUpdateCount()).toBe(2);
  });

  test("P1-1：执行阶段收尾后（endExecution）不再记录", () => {
    const m = new PlanModeManager();
    m.enter("default");
    m.submitForApproval();
    m.approve();
    expect(m.recordPlanFileWrite()).toBe(true);

    // 新用户回合开始时 app.ts 会调 endExecution()，此后既非规划态也非执行阶段
    m.endExecution();
    expect(m.isActive()).toBe(false);
    expect(m.isExecuting()).toBe(false);
    expect(m.recordPlanFileWrite()).toBe(false);
    expect(m.getPlanFileUpdateCount()).toBe(1);
  });

  test("P1-1：用户取消（forceExit）后不再记录，且执行阶段标志已关", () => {
    const m = new PlanModeManager();
    m.enter("default");
    m.submitForApproval();
    m.approve();
    expect(m.isExecuting()).toBe(true);

    // forceExit 从前对 inactive 无条件早退——而执行阶段的 state 正是 inactive，
    // 所以它在唯一需要它收尾执行阶段的时刻是个 no-op。现在必须真的关掉。
    m.forceExit();
    expect(m.isExecuting()).toBe(false);
    expect(m.recordPlanFileWrite()).toBe(false);
    expect(m.getPlanFileUpdateCount()).toBe(0);
  });
});
