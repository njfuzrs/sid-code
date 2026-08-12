/**
 * Spec 18 §2.3：Plan Mode 优化单测
 * - 词汇 Slug 命名（worktree 仍在用）
 * - Plan 文件语义命名（中文主题 + 项目分目录 + 时间）
 * - 提醒节流（每 5 轮完整）
 * - allowedPrompts 记录
 */

import { describe, it, expect } from "bun:test";
import { PlanModeManager } from "@sid-code/core/plan/state.ts";
import {
  generateWordSlug,
  isWordSlug,
  formatPlanTime,
  sanitizeProjectName,
  sanitizePlanTopic,
} from "@sid-code/core/plan/slug.ts";
import { buildPlanModeReminder } from "@sid-code/core/plan/prompt.ts";

describe("plan slug（worktree 用）", () => {
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

describe("formatPlanTime", () => {
  it("格式为 YYYYMMDD-HHmm", () => {
    const d = new Date(2026, 6, 15, 14, 30); // 2026-07-15 14:30
    expect(formatPlanTime(d)).toBe("20260715-1430");
  });

  it("月/日/时/分补零", () => {
    const d = new Date(2026, 0, 5, 3, 7); // 2026-01-05 03:07
    expect(formatPlanTime(d)).toBe("20260105-0307");
  });
});

describe("sanitizeProjectName", () => {
  it("正常项目名保留", () => {
    expect(sanitizeProjectName("sid-code")).toBe("sid-code");
    expect(sanitizeProjectName("my-web-app")).toBe("my-web-app");
  });

  it("中文项目名保留", () => {
    expect(sanitizeProjectName("我的项目")).toBe("我的项目");
  });

  it("去除路径分隔符和控制字符", () => {
    expect(sanitizeProjectName("foo/bar\\baz")).toBe("foobarbaz");
    expect(sanitizeProjectName("test\x00name")).toBe("testname");
  });

  it("去除 Windows 敌对字符", () => {
    expect(sanitizeProjectName('a:b*c?"d<e>f|g')).toBe("abcdefg");
  });

  it("空白转连字符", () => {
    expect(sanitizeProjectName("my project")).toBe("my-project");
    expect(sanitizeProjectName("a  b")).toBe("a-b");
  });

  it("去首尾点和横线", () => {
    expect(sanitizeProjectName(".hidden")).toBe("hidden");
    expect(sanitizeProjectName("--test--")).toBe("test");
    expect(sanitizeProjectName("...")).toBe("default");
  });

  it("限长 50", () => {
    const long = "a".repeat(100);
    expect(sanitizeProjectName(long).length).toBeLessThanOrEqual(50);
  });

  it("空字符串兜底 default", () => {
    expect(sanitizeProjectName("")).toBe("default");
    expect(sanitizeProjectName("///")).toBe("default");
  });
});

describe("sanitizePlanTopic", () => {
  it("正常中文主题保留", () => {
    expect(sanitizePlanTopic("优化plan文件命名")).toBe("优化plan文件命名");
  });

  it("空白转连字符", () => {
    expect(sanitizePlanTopic("修复 幽灵行 残留")).toBe("修复-幽灵行-残留");
  });

  it("空/undefined 返回 null", () => {
    expect(sanitizePlanTopic(undefined)).toBeNull();
    expect(sanitizePlanTopic("")).toBeNull();
    expect(sanitizePlanTopic("...")).toBeNull();
  });

  it("去除危险字符", () => {
    expect(sanitizePlanTopic("../etc/passwd")).toBe("etcpasswd");
    expect(sanitizePlanTopic("test:file")).toBe("testfile");
  });

  it("限长 40", () => {
    const long = "测".repeat(50);
    expect(sanitizePlanTopic(long)!.length).toBeLessThanOrEqual(40);
  });
});

describe("plan 文件命名语义化", () => {
  it("getPlanFilePath 路径含项目子目录和时间格式", () => {
    const mgr = new PlanModeManager();
    mgr.enter();
    const path = mgr.getPlanFilePath();
    expect(path).not.toBeNull();
    // 路径含 plans/{项目名}/ 子目录
    expect(path).toContain("/plans/");
    const parts = path!.split("/");
    const plansIdx = parts.indexOf("plans");
    expect(plansIdx).toBeGreaterThan(-1);
    // plans 后面有项目目录
    expect(parts[plansIdx + 1]).toBeTruthy();
    // 文件名匹配时间格式
    const fileName = parts[parts.length - 1].replace(/\.md$/, "");
    expect(fileName).toMatch(/^\d{8}-\d{4}/);
  });

  it("带 topic 进入时文件名含主题", () => {
    const mgr = new PlanModeManager();
    mgr.enter(undefined, "修复登录页面");
    const path = mgr.getPlanFilePath()!;
    const fileName = path.split("/").pop()!.replace(/\.md$/, "");
    expect(fileName).toMatch(/^\d{8}-\d{4}-修复登录页面$/);
  });

  it("不带 topic 进入时文件名为纯时间戳", () => {
    const mgr = new PlanModeManager();
    mgr.enter();
    const path = mgr.getPlanFilePath()!;
    const fileName = path.split("/").pop()!.replace(/\.md$/, "");
    // 纯时间戳或时间戳-N（去重后缀）
    expect(fileName).toMatch(/^\d{8}-\d{4}(-\d+)?$/);
  });
});

describe("提醒节流", () => {
  it("第 1 轮完整，2-4 简短，第 5 轮完整", () => {
    const mgr = new PlanModeManager();
    mgr.enter();
    expect(mgr.nextReminderIsFull()).toBe(true); // turn 1
    expect(mgr.nextReminderIsFull()).toBe(false); // turn 2
    expect(mgr.nextReminderIsFull()).toBe(false); // turn 3
    expect(mgr.nextReminderIsFull()).toBe(false); // turn 4
    expect(mgr.nextReminderIsFull()).toBe(true); // turn 5
    expect(mgr.nextReminderIsFull()).toBe(false); // turn 6
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
    mgr.setAllowedPrompts([{ tool: "bash", prompt: "运行测试" }, { prompt: "安装依赖" }]);
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
