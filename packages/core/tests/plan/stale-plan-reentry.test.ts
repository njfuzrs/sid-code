/**
 * 重入规划态的过期计划提示（缺口 1）回归
 *
 * 来源：docs-research bugfixes todo「20261103-05H2-规划态生命周期收口-落地方案」§一。
 * 判据是**进入之前**同项目下最近一份**非空** `.md`——不是「文件存在」，因为 `enter()`
 * 会 O_EXCL 占一个空占位，进入后「存在」恒真。去掉修复时下面几条应当变红
 * （变异自证见同 PR 的 Agent Note）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanModeManager } from "@sid-code/core/plan/state.ts";
import { buildPlanModePrompt } from "@sid-code/core/plan/prompt.ts";
import { sidPaths } from "@sid-code/core/config/paths.ts";
import { resolvePlanProject } from "@sid-code/core/plan/slug.ts";
import { getCwd, setCwd } from "@sid-code/core/bootstrap/state.ts";
import { EnterPlanModeTool } from "@sid-code/core/tool/enter-plan-mode.ts";

const originalConfigDir = process.env.SID_CONFIG_DIR;
const originalCwd = getCwd();

let home: string;
let project: string;
let planDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sid-stale-plan-home-"));
  process.env.SID_CONFIG_DIR = home;
  project = mkdtempSync(join(tmpdir(), "sid-stale-plan-proj-"));
  setCwd(project);
  planDir = sidPaths.plansForProject(resolvePlanProject(project));
  mkdirSync(planDir, { recursive: true });
});

afterEach(() => {
  // 必须存/恢复原值、不无条件 delete：同批测试共享进程，删掉会把 preload 兜底一起抹掉
  if (originalConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = originalConfigDir;
  setCwd(originalCwd);
});

describe("缺口 1：重入规划态判断旧计划还作不作数", () => {
  test("第一次进入没有旧计划：不提示、事件落 false", () => {
    const pm = new PlanModeManager();
    const events: any[] = [];
    pm.onStateChange((e) => events.push(e));

    expect(pm.enter()).toBe(true);
    expect(pm.getStalePlanPath()).toBeNull();
    // 分母是全部 enter，所以 false 也必须落盘——只落 true 就永远算不出比例
    expect(events.at(-1)?.meta?.stalePlanFound).toBe(false);

    const prompt = buildPlanModePrompt(pm.getPlanFilePath()!, false, pm.getStalePlanPath());
    expect(prompt).not.toContain("上一份计划还留在磁盘上");
  });

  test("同项目有非空旧计划：找到它、事件落 true、引导含三步处置", () => {
    const oldPlan = join(planDir, "20260101-0000-旧任务.md");
    writeFileSync(oldPlan, "## 实施步骤\n1. 旧任务\n");

    const pm = new PlanModeManager();
    const events: any[] = [];
    pm.onStateChange((e) => events.push(e));

    pm.enter(undefined, "新任务");
    expect(pm.getStalePlanPath()).toBe(oldPlan);
    expect(events.at(-1)?.meta?.stalePlanFound).toBe(true);

    const newPath = pm.getPlanFilePath()!;
    expect(newPath).not.toBe(oldPlan);
    const prompt = buildPlanModePrompt(newPath, false, pm.getStalePlanPath());
    expect(prompt).toContain(oldPlan);
    expect(prompt).toContain("用 read 读它");
    expect(prompt).toContain("覆盖重写");
    // 引导里必须同时给出「本次计划写到哪」——只给旧路径会让模型继续改旧文件
    expect(prompt).toContain(newPath);
  });

  test("0 字节占位不算旧计划（同分钟重入不会自我命中）", () => {
    const pm = new PlanModeManager();
    pm.enter();
    const placeholder = pm.getPlanFilePath()!;
    expect(placeholder).not.toBeNull();
    // 模拟崩溃遗留的空占位：enter() 占位后进程退出、forceExit 从没跑过
    pm.forceExit();
    writeFileSync(join(planDir, "20260101-0000-崩溃遗留.md"), "");

    const pm2 = new PlanModeManager();
    pm2.enter();
    expect(pm2.getStalePlanPath()).toBeNull();
  });

  test("只有空白字符的计划也算「没写」", () => {
    writeFileSync(join(planDir, "20260101-0000-空白.md"), "  \n\t\n");

    const pm = new PlanModeManager();
    pm.enter();
    expect(pm.getStalePlanPath()).toBeNull();
  });

  test("多份旧计划取 mtime 最新的那份", () => {
    const older = join(planDir, "20260101-0000-更早.md");
    const newer = join(planDir, "20260102-0000-更新.md");
    writeFileSync(older, "## 实施步骤\n1. 早\n");
    writeFileSync(newer, "## 实施步骤\n1. 新\n");
    const past = new Date(Date.now() - 86_400_000);
    utimesSync(older, past, past);

    const pm = new PlanModeManager();
    pm.enter();
    expect(pm.getStalePlanPath()).toBe(newer);
  });

  test("只认 .md：同目录其它文件不算旧计划", () => {
    writeFileSync(join(planDir, "notes.txt"), "不是计划");

    const pm = new PlanModeManager();
    pm.enter();
    expect(pm.getStalePlanPath()).toBeNull();
  });

  test("退出规划态后不再报告旧计划路径", () => {
    writeFileSync(join(planDir, "20260101-0000-旧任务.md"), "## 实施步骤\n1. 旧任务\n");
    const pm = new PlanModeManager();
    pm.enter();
    expect(pm.getStalePlanPath()).not.toBeNull();
    pm.forceExit();
    expect(pm.getStalePlanPath()).toBeNull();
  });

  test("enter_plan_mode 的 tool_result 带上旧计划路径与处置引导", async () => {
    const oldPlan = join(planDir, "20260101-0000-旧任务.md");
    writeFileSync(oldPlan, "## 实施步骤\n1. 旧任务\n");

    const pm = new PlanModeManager();
    const tool = new EnterPlanModeTool(pm, () => "default");
    const result: any = await tool.execute({ topic: "新任务" });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain(oldPlan);
    expect(result.output).toContain("上一份计划还留在磁盘上");
  });
});
