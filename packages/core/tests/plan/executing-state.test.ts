/**
 * PlanModeManager 执行阶段（executing）状态追踪单测
 *
 * 缺陷修复回归：Recovery Hook 的设计意图是"执行阶段（approve 后）工具失败时触发"，
 * 但旧实现只判 isPlanning()，而 approve() 后状态已回 inactive、isPlanning()=false，
 * 导致 recovery 永不在执行阶段触发。本测试锁定 executing 标志的生命周期：
 *   approve → executing=true；enter/forceExit/endExecution → executing=false。
 */

import { describe, test, expect } from "bun:test";
import { PlanModeManager } from "@sid-code/core/plan/state.ts";

describe("PlanModeManager — 执行阶段(executing)追踪", () => {
  test("初始 inactive 时 isExecuting=false", () => {
    const m = new PlanModeManager();
    expect(m.isExecuting()).toBe(false);
  });

  test("planning / awaiting_approval 阶段 isExecuting 仍为 false", () => {
    const m = new PlanModeManager();
    m.enter();
    expect(m.isPlanning()).toBe(true);
    expect(m.isExecuting()).toBe(false);
    m.submitForApproval();
    expect(m.isAwaitingApproval()).toBe(true);
    expect(m.isExecuting()).toBe(false);
  });

  test("approve() 后进入执行阶段：state=inactive 但 isExecuting=true", () => {
    const m = new PlanModeManager();
    m.enter();
    m.submitForApproval();
    m.approve();
    expect(m.getState()).toBe("inactive"); // 权限模式已恢复
    expect(m.isExecuting()).toBe(true); // 但语义上在按计划执行
    expect(m.isActive()).toBe(false);
  });

  test("执行阶段 plan 文件路径仍保留（recovery 需要它）", () => {
    const m = new PlanModeManager();
    m.enter();
    const planPath = m.getPlanFilePath();
    expect(planPath).toBeTruthy();
    m.submitForApproval();
    m.approve();
    // approve 后路径不清空，recovery hook 才能拿到 currentPlanFilePath
    expect(m.getPlanFilePath()).toBe(planPath);
  });

  test("endExecution() 清执行阶段标志", () => {
    const m = new PlanModeManager();
    m.enter();
    m.submitForApproval();
    m.approve();
    expect(m.isExecuting()).toBe(true);
    m.endExecution();
    expect(m.isExecuting()).toBe(false);
  });

  test("再次 enter() 清掉上一轮的执行阶段标志", () => {
    const m = new PlanModeManager();
    m.enter();
    m.submitForApproval();
    m.approve();
    expect(m.isExecuting()).toBe(true);
    // 开启全新一轮 plan
    m.enter();
    expect(m.isExecuting()).toBe(false);
    expect(m.isPlanning()).toBe(true);
  });

  test("forceExit() 清执行阶段标志（执行阶段中直接取消）", () => {
    const m = new PlanModeManager();
    m.enter();
    m.submitForApproval();
    m.approve();
    expect(m.isExecuting()).toBe(true);
    // P1-1：从前 forceExit 对 inactive 无条件早退，而执行阶段的 state 正是 inactive，
    // 所以它在唯一需要它收尾执行阶段的时刻是 no-op（旧用例只好绕道先 enter() 一次）。
    // isExecuting() 现在还是权限链 Step 3.5 的放行条件，故必须支持直接取消。
    m.forceExit();
    expect(m.isExecuting()).toBe(false);
  });

  test("forceExit() 在执行阶段中途 enter 再取消也清标志（原链路保持）", () => {
    const m = new PlanModeManager();
    m.enter();
    m.submitForApproval();
    m.approve();
    m.enter(); // 重新进入 planning（enter 自己也清 executing）
    m.forceExit(); // 取消
    expect(m.isExecuting()).toBe(false);
  });

  test("reject 回到 planning 不应置 executing", () => {
    const m = new PlanModeManager();
    m.enter();
    m.submitForApproval();
    const canContinue = m.reject();
    expect(canContinue).toBe(true);
    expect(m.isPlanning()).toBe(true);
    expect(m.isExecuting()).toBe(false);
  });
});
