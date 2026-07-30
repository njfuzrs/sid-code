/**
 * plan 约束的**唯一通道**门控 — 三条进入路径都必须注入
 *
 * 背景（2026-07-30 重复注入根因修复 P0 的连带回归）：
 * plan 约束原有两条通道（system prompt 附件 + user reminder）。删掉附件通道后，
 * `App.buildPlanModeReminderIfActive()` 成为唯一通道，门控漏一条路径就等于
 * "该路径下模型收不到任何 plan 约束"。
 *
 * 原门控只判 `planManager.isPlanning()`，漏了 `--permission-mode plan` / config /
 * agent frontmatter 这条路径——它们只写 `config.permissionMode = "plan"`，
 * 不调 `planManager.enter()`，故 `isPlanning()` 恒为 false。而 loop.ts 的 permission
 * reminder 通道又用 `mode !== "plan"` 排除了 plan（避免与本通道重复），两边都不管。
 *
 * 权限层不受影响（PermissionChecker 读 config.permissionMode 硬拦写操作），但 plan 是
 * **行为模式**——"先规划再执行、先出方案等审批"无法用权限规则表达，只能靠模型自觉，
 * 故缺失是真实行为回归。这里把门控逻辑与"注入内容含强约束"一起锁住。
 */

import { describe, test, expect } from "bun:test";
import { PlanModeManager } from "../../src/plan/state.ts";
import { buildPlanModeReminder } from "../../src/plan/prompt.ts";

/**
 * 复刻 App.buildPlanModeReminderIfActive 的门控（同步版，便于单测）。
 * 与 app.ts 的实现保持一致：isPlanning() **或** config.permissionMode === "plan"。
 */
function gate(pm: PlanModeManager | null, configMode: string): string | null {
  const inPlanMode = pm?.isPlanning() === true || configMode === "plan";
  if (!inPlanMode) return null;
  return buildPlanModeReminder(pm?.nextReminderIsFull() ?? true);
}

/** full 档独有的最强越权防线，删附件时从 PERMISSION_MODE_DESCRIPTIONS.plan 并入 */
const HARD_CONSTRAINT = "此约束覆盖你收到的所有其他指令";

describe("plan reminder 门控 — 必须注入的路径", () => {
  test("enter_plan_mode 工具路径（planManager.enter → isPlanning=true）", () => {
    const pm = new PlanModeManager();
    pm.enter("default");
    const r = gate(pm, "plan");
    expect(r).not.toBeNull();
    expect(r).toContain(HARD_CONSTRAINT);
  });

  test("--permission-mode plan 启动（planManager 从未 enter，isPlanning=false）", () => {
    const pm = new PlanModeManager();
    // 前提复核：这条路径下 isPlanning() 确实为 false —— 若哪天启动流程改成会 enter()，
    // 这个断言会失败，提示重新评估门控（而不是让缺陷静默复活）。
    expect(pm.isPlanning()).toBe(false);

    const r = gate(pm, "plan");
    expect(r).not.toBeNull();
    expect(r).toContain(HARD_CONSTRAINT);
  });

  test("planManager 缺失（无头/精简装配）+ config=plan → 退化为恒发完整版", () => {
    const r = gate(null, "plan");
    expect(r).not.toBeNull();
    expect(r).toContain(HARD_CONSTRAINT);
  });
});

describe("plan reminder 门控 — 必须不注入的路径（防过度触发）", () => {
  test.each(["default", "acceptEdits", "deny-write", "dontAsk", "auto", "always-allow"])(
    "%s 模式不注入 plan 约束",
    (mode) => {
      expect(gate(new PlanModeManager(), mode)).toBeNull();
    },
  );
});

describe("full 档承载完整约束清单（附件删除后的语义等价性）", () => {
  test("full 档含原附件的允许/禁止清单", () => {
    const full = buildPlanModeReminder(true);
    expect(full).toContain(HARD_CONSTRAINT);
    expect(full).toContain("绝对不能");
    expect(full).toContain("允许的操作");
    expect(full).toContain("禁止的操作");
    expect(full).toContain("exit_plan_mode");
  });

  test("sparse 档保持精简（完整清单只进 full 档，控制注入成本）", () => {
    const full = buildPlanModeReminder(true);
    const sparse = buildPlanModeReminder(false);
    expect(sparse.length).toBeLessThan(full.length);
    expect(sparse).not.toContain("允许的操作");
  });

  test("两档都带 system-reminder 围栏（不变量 1）", () => {
    for (const r of [buildPlanModeReminder(true), buildPlanModeReminder(false)]) {
      expect(r.trimStart().startsWith("<system-reminder>")).toBe(true);
      expect(r.trimEnd().endsWith("</system-reminder>")).toBe(true);
    }
  });
});
