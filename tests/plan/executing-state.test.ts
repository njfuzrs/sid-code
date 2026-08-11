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

  test("forceExit() 清执行阶段标志", () => {
    const m = new PlanModeManager();
    m.enter();
    m.submitForApproval();
    m.approve();
    expect(m.isExecuting()).toBe(true);
    // 注：approve 后 state 已 inactive，forceExit 对 inactive 是 no-op，
    // 故这里验证的是"执行阶段中用户又开 plan 再取消"的链路。
    m.enter(); // 重新进入 planning（清了 executing）
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
