/**
 * worktree 工具必须首轮可见 —— 前缀碰撞面归零的防回退门禁。
 *
 * 背景：全仓内置工具两两算公共前缀，「always-live × deferred 且前缀 ≥4」的组合只有两对，
 * 而这正是生成期坍缩的必要条件（延迟工具不在本轮 schema 里，模型"想调"它时会坍缩成
 * 当轮唯一共享前缀的真实工具）：
 *
 *   enter_plan_mode / enter_worktree  prefix=6 'enter_'
 *   exit_plan_mode  / exit_worktree   prefix=5 'exit_'
 *
 * 实测后果：enter_worktree → enter_plan_mode 误触 5 次、4 份无用 plan 文件、
 * 任务卡死到用户手动打断（轨迹 20260817-141456-065fe328）。
 *
 * 这条测试的作用是拦「有人觉得 worktree 是长尾工具、把 shouldDefer 加回去」。
 * 成本对照写在 enter-worktree.ts 的注释里（两个 description 合计 ~450 字符 ≈ 首轮 1.5%）。
 */

import { describe, test, expect } from "bun:test";
import { EnterWorktreeTool } from "@sid-code/core/tool/enter-worktree.ts";
import { ExitWorktreeTool } from "@sid-code/core/tool/exit-worktree.ts";
import { EnterPlanModeTool } from "@sid-code/core/tool/enter-plan-mode.ts";
import { ExitPlanModeTool } from "@sid-code/core/tool/exit-plan-mode.ts";
import { Registry } from "@sid-code/core/tool/registry.ts";
import type { LegacyTool } from "@sid-code/core/tool/types.ts";
import type { PlanModeManager } from "@sid-code/core/plan/state.ts";

/** 最小 PlanModeManager 替身：本文件只关心工具的注册/延迟属性，不执行 */
const fakePlanManager = {
  isActive: () => false,
  enter: () => true,
  exit: () => true,
  getPlanFilePath: () => "/tmp/plan.md",
} as unknown as PlanModeManager;

describe("worktree 工具不得声明 shouldDefer", () => {
  test("enter_worktree / exit_worktree 都不是延迟工具", () => {
    // 走 LegacyTool 接口读（`shouldDefer` 是 ToolCapabilityFields 的可选字段）：
    // 字段不存在时是 undefined，加回 true 时这两条就红。
    const enter = new EnterWorktreeTool() as LegacyTool;
    const exit = new ExitWorktreeTool() as LegacyTool;
    expect(enter.shouldDefer).toBeFalsy();
    expect(exit.shouldDefer).toBeFalsy();
  });

  test("两对前缀碰撞组合都在首轮上下文里（activeDefinitions 都含）", () => {
    const registry = new Registry();
    registry.register(new EnterWorktreeTool() as any);
    registry.register(new ExitWorktreeTool() as any);
    registry.register(new EnterPlanModeTool(fakePlanManager) as any);
    registry.register(new ExitPlanModeTool(fakePlanManager) as any);

    const activeNames = new Set(registry.activeDefinitions().map((d) => d.name));
    for (const name of ["enter_worktree", "exit_worktree", "enter_plan_mode", "exit_plan_mode"]) {
      expect(activeNames.has(name)).toBe(true);
    }
    // 延迟名单里一个都不该有 —— 有的话前缀碰撞面就重新打开了
    expect(registry.deferredToolNames()).toEqual([]);
  });
});

describe("前缀碰撞面 — 当前应为零", () => {
  /** 两个名字的公共前缀长度 */
  function commonPrefixLen(a: string, b: string): number {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  }

  test("live × deferred 且公共前缀 ≥4 的组合数为 0", () => {
    const registry = new Registry();
    registry.register(new EnterWorktreeTool() as any);
    registry.register(new ExitWorktreeTool() as any);
    registry.register(new EnterPlanModeTool(fakePlanManager) as any);
    registry.register(new ExitPlanModeTool(fakePlanManager) as any);

    const deferred = new Set(registry.deferredToolNames());
    const all = registry.all().map((t) => t.name());
    const live = all.filter((n) => !deferred.has(n));

    const collisions: string[] = [];
    for (const l of live) {
      for (const d of deferred) {
        if (commonPrefixLen(l, d) >= 4) collisions.push(`${l} vs ${d}`);
      }
    }
    expect(collisions).toEqual([]);
  });
});
