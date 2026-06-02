/**
 * Spec 18 §2.3：Plan Mode 优化单测
 * - 词汇 Slug 命名
 * - 提醒节流（每 5 轮完整）
 * - allowedPrompts 记录
 */

import { describe, it, expect } from "bun:test";
import { PlanModeManager } from "../../src/plan/state.ts";
import { generateWordSlug, isWordSlug } from "../../src/plan/slug.ts";
import { buildPlanModeReminder } from "../../src/plan/prompt.ts";

describe("plan slug", () => {
  it("生成 adj-noun-NN 形态", () => {
    for (let i = 0; i < 50; i++) {
      const slug = generateWordSlug();
      expect(isWordSlug(slug)).toBe(true);
    }
  });

  it("isWordSlug 拒绝时间戳命名", () => {
    expect(isWordSlug("plan-2026-06-01T10-30-45")).toBe(false);
    expect(isWordSlug("agent-a1b2c3d4")).toBe(false);
    expect(isWordSlug("brave-eagle-42")).toBe(true);
  });
});

describe("plan 文件命名使用 slug", () => {
  it("getPlanFilePath 返回 slug.md 而非时间戳", () => {
    const mgr = new PlanModeManager();
    mgr.enter();
    const path = mgr.getPlanFilePath();
    expect(path).not.toBeNull();
    const fileName = path!.split("/").pop()!.replace(/\.md$/, "");
    expect(isWordSlug(fileName)).toBe(true);
  });

  it("同一会话内 slug 稳定（不重新生成）", () => {
    const mgr = new PlanModeManager();
    mgr.enter();
    const p1 = mgr.getPlanFilePath();
    const p2 = mgr.getPlanFilePath();
    expect(p1).toBe(p2);
  });
});

describe("提醒节流", () => {
  it("第 1 轮完整，2-4 简短，第 5 轮完整", () => {
    const mgr = new PlanModeManager();
    mgr.enter();
    expect(mgr.nextReminderIsFull()).toBe(true);   // turn 1
    expect(mgr.nextReminderIsFull()).toBe(false);  // turn 2
    expect(mgr.nextReminderIsFull()).toBe(false);  // turn 3
    expect(mgr.nextReminderIsFull()).toBe(false);  // turn 4
    expect(mgr.nextReminderIsFull()).toBe(true);   // turn 5
    expect(mgr.nextReminderIsFull()).toBe(false);  // turn 6
  });

  it("buildPlanModeReminder full=false 更短", () => {
    const full = buildPlanModeReminder(true);
    const sparse = buildPlanModeReminder(false);
    expect(sparse.length).toBeLessThan(full.length);
    expect(sparse).toContain("exit_plan_mode");
  });

  it("重新 enter 后轮次重置", () => {
    const mgr = new PlanModeManager();
    mgr.enter();
    mgr.nextReminderIsFull();
    mgr.nextReminderIsFull();
    mgr.forceExit();
    mgr.enter();
    expect(mgr.nextReminderIsFull()).toBe(true); // 重置后第 1 轮完整
  });
});

describe("allowedPrompts", () => {
  it("set/get 往返", () => {
    const mgr = new PlanModeManager();
    mgr.enter();
    mgr.setAllowedPrompts([
      { tool: "bash", prompt: "运行测试" },
      { prompt: "安装依赖" },
    ]);
    const got = mgr.getAllowedPrompts();
    expect(got.length).toBe(2);
    expect(got[0].prompt).toBe("运行测试");
  });

  it("enter 时清空", () => {
    const mgr = new PlanModeManager();
    mgr.enter();
    mgr.setAllowedPrompts([{ prompt: "x" }]);
    mgr.forceExit();
    mgr.enter();
    expect(mgr.getAllowedPrompts().length).toBe(0);
  });
});
