/**
 * 任务规划 P2-1 / P2-2 / P2-3 / P3-1 / P3-2 回归
 *
 * 来源：docs-research bugfixes「任务规划-顺着sc-05-plan核出的缺陷」§五–§九。
 * 每组断言都对应文档里一条实证；去掉修复时它们应当变红（变异自证见 Agent Note）。
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanModeManager } from "@sid-code/core/plan/state.ts";
import { buildPlanModeReminder } from "@sid-code/core/plan/prompt.ts";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import * as modeModule from "@sid-code/core/permission/mode.ts";
import { PermissionSync } from "@sid-code/core/swarm/permission-sync.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import { EnterPlanModeTool } from "@sid-code/core/tool/enter-plan-mode.ts";
import { ExitPlanModeTool } from "@sid-code/core/tool/exit-plan-mode.ts";

function headlessPlanChecker(pm: PlanModeManager, mode = "plan") {
  const config = { ...defaultConfig(), permissionMode: mode, print: true };
  const workspace = mkdtempSync(join(tmpdir(), "sid-plan-p2-"));
  mkdirSync(join(workspace, "src"), { recursive: true });
  const checker = new PermissionChecker(config as any, undefined, workspace);
  checker.setPlanManager(pm);
  return { checker, workspace };
}

// ─────────────────────────────────────────────────────────────
// P2-1：--permission-mode plan 进入状态机
// ─────────────────────────────────────────────────────────────
describe("P2-1 以 plan 权限模式进入会话也走规划状态机", () => {
  test("syncWithPermissionMode('plan') 进入规划态、有计划文件、没有「之前」的模式", () => {
    const pm = new PlanModeManager();
    expect(pm.syncWithPermissionMode("plan")).toBe(true);
    expect(pm.isPlanning()).toBe(true);
    expect(pm.getPlanFilePath()).not.toBeNull();
    // 启动即 plan：不能「恢复成 plan」，记为 null → 退出时由 App 恢复成 default
    expect(pm.getPrePlanMode()).toBeNull();
  });

  test("已在规划 / 待审批、或权限模式不是 plan 时是 no-op", () => {
    const pm = new PlanModeManager();
    expect(pm.syncWithPermissionMode("default")).toBe(false);
    expect(pm.syncWithPermissionMode(undefined)).toBe(false);
    expect(pm.isActive()).toBe(false);

    pm.syncWithPermissionMode("plan");
    const path = pm.getPlanFilePath();
    expect(pm.syncWithPermissionMode("plan")).toBe(false);
    pm.submitForApproval();
    expect(pm.syncWithPermissionMode("plan")).toBe(false);
    expect(pm.getPlanFilePath()).toBe(path); // 没有被重新 enter 换掉路径
  });

  test("进入后：无头模式下能写计划文件，exit_plan_mode 真的提交审批", async () => {
    const pm = new PlanModeManager();
    pm.syncWithPermissionMode("plan");
    const { checker } = headlessPlanChecker(pm);
    const planPath = pm.getPlanFilePath()!;

    const w = await checker.check({
      toolName: "write",
      input: { file_path: planPath, content: "1. 读 a\n" },
    } as any);
    expect(w.allowed).toBe(true);

    // 写到磁盘后提交：从前 isPlanning() 恒 false，走「已进入执行阶段」的幂等分支
    const { writeFileSync } = await import("node:fs");
    writeFileSync(planPath, "1. 读 a\n");
    const r = await new ExitPlanModeTool(pm).execute({});
    expect(r.isError).not.toBe(true);
    expect(pm.isAwaitingApproval()).toBe(true);
    expect(r.output).toContain("等待用户审批");
  });

  test("提醒带上计划文件路径（这条入口从没收到过 enter_plan_mode 的 tool_result）", () => {
    const path = "/tmp/plans/x.md";
    expect(buildPlanModeReminder(true, path)).toContain(path);
    expect(buildPlanModeReminder(false, path)).toContain(path);
    expect(buildPlanModeReminder(true)).not.toContain("计划文件（唯一允许编辑的文件）");
  });

  test("enter_plan_mode 工具记下进入前的真实模式（prePlanMode 不再恒空）", async () => {
    const pm = new PlanModeManager();
    const tool = new EnterPlanModeTool(pm, () => "acceptEdits");
    await tool.execute({ topic: "重构" });
    expect(pm.getPrePlanMode()).toBe("acceptEdits");
  });

  test("enter('plan') 不把 plan 记成「之前」的模式", () => {
    const pm = new PlanModeManager();
    pm.enter("plan");
    expect(pm.getPrePlanMode()).toBeNull();
  });

  test("App 只剩 planManager 一份 prePlanMode（不再另存 _originalPermissionMode）", () => {
    const src = readFileSync(join(import.meta.dir, "../../../cli/src/app.ts"), "utf-8");
    expect(src).not.toMatch(/private _originalPermissionMode/);
    expect(src).toMatch(/this\.syncPlanModeFromPermissionMode\(\)/);
    expect(src).toMatch(/getPrePlanMode\(\) \|\| "default"/);
  });
});

// ─────────────────────────────────────────────────────────────
// P2-2：没有消费方的「一并批准」承诺已撤掉
// ─────────────────────────────────────────────────────────────
describe("P2-2 删掉三处零消费的声明", () => {
  test("exit_plan_mode 的 schema 不再向模型承诺 allowed_prompts", () => {
    const schema = new ExitPlanModeTool(new PlanModeManager()).inputSchema() as any;
    expect(Object.keys(schema.properties ?? {})).not.toContain("allowed_prompts");
    expect(JSON.stringify(schema)).not.toContain("一并审批");
  });

  test("旧模型仍传 allowed_prompts 时不报错，也不再回显「执行阶段需要的权限」", async () => {
    const pm = new PlanModeManager();
    pm.enter("default");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(pm.getPlanFilePath()!, "1. 跑 bun test\n");
    const tool = new ExitPlanModeTool(pm);
    const parsed = tool.zodSchema.safeParse({ allowed_prompts: [{ prompt: "运行测试" }] });
    expect(parsed.success).toBe(true);
    const r = await tool.execute({ allowed_prompts: [{ prompt: "运行测试" }] });
    expect(r.isError).not.toBe(true);
    expect(r.output).not.toContain("执行阶段需要的权限");
  });

  test("相关死 API 已移除（防止下一个人以为它们在起作用）", () => {
    const pm = new PlanModeManager() as any;
    expect(pm.getAllowedPrompts).toBeUndefined();
    expect(pm.setAllowedPrompts).toBeUndefined();
    expect((new PermissionSync() as any).preApprove).toBeUndefined();
    expect((modeModule as any).shouldPlanInheritBypass).toBeUndefined();
    const checker = headlessPlanChecker(new PlanModeManager()).checker as any;
    expect(checker.setPrePlanMode).toBeUndefined();
  });

  test("从 always-allow 进入计划模式，写普通文件仍被拦（没有顺手接活 plan 继承 bypass）", async () => {
    const pm = new PlanModeManager();
    pm.enter("always-allow");
    const { checker, workspace } = headlessPlanChecker(pm);
    const d = await checker.check({
      toolName: "write",
      input: { file_path: join(workspace, "src/a.ts"), content: "x" },
    } as any);
    expect(d.allowed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// P2-3：保真度匹配要求参数锚定、取最佳匹配
// ─────────────────────────────────────────────────────────────
describe("P2-3 保真度匹配", () => {
  const PLAN = "1. 读 package.json\n2. 改 src/cli.ts\n3. 写 tests/cli.test.ts\n4. 跑 bun test";

  test("文档实证：read /etc/hosts 不再被算成「读 package.json」", () => {
    const m = new PlanModeManager();
    m.parsePlanFromMarkdown(PLAN);
    expect(m.recordActualToolCall("grep", { pattern: "x" }).matchedPlanStepIndex).toBeNull();
    expect(
      m.recordActualToolCall("read", { file_path: "/etc/hosts" }).matchedPlanStepIndex,
    ).toBeNull();
    const r = m.getFidelityReport();
    expect(r.matchedRatio).toBe(0);
    expect(r.offPlanCount).toBe(2);
  });

  test("多个读步骤：各自命中自己那一步，而不是全记到第一步", () => {
    const m = new PlanModeManager();
    const steps = m.parsePlanFromMarkdown(
      "1. 读 package.json\n2. 读 tsconfig.json\n3. 读 README.md",
    );
    expect(
      m.recordActualToolCall("read", { file_path: "/r/tsconfig.json" }).matchedPlanStepIndex,
    ).toBe(2);
    expect(m.recordActualToolCall("read", { file_path: "/r/README.md" }).matchedPlanStepIndex).toBe(
      3,
    );
    expect(steps[0].matchedActualIndices).toEqual([]);
  });

  test("最佳匹配：锚定 token 更多的步骤胜出", () => {
    const m = new PlanModeManager();
    m.parsePlanFromMarkdown("1. 跑 bun run lint\n2. 跑 bun test packages/core");
    const c = m.recordActualToolCall("bash", { command: "bun test packages/core" });
    expect(c.matchedPlanStepIndex).toBe(2);
  });

  test("参数键名不参与锚定（描述里的 file_path 不会匹配任何 read）", () => {
    const m = new PlanModeManager();
    m.parsePlanFromMarkdown("1. 读 file_path 相关代码");
    expect(
      m.recordActualToolCall("read", { file_path: "/x/y.ts" }).matchedPlanStepIndex,
    ).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// P3-1：planFilePath 的生命周期与注释一致
// ─────────────────────────────────────────────────────────────
describe("P3-1 路径在 ⇔ 有活跃计划", () => {
  test("用户取消（forceExit）清路径，事件里仍带退出的是哪份计划", () => {
    const m = new PlanModeManager();
    m.enter("default");
    const path = m.getPlanFilePath();
    const events: Array<string | null> = [];
    m.onStateChange((e) => events.push(e.planFilePath));
    m.forceExit();
    expect(m.getPlanFilePath()).toBeNull();
    expect(events).toEqual([path]);
  });

  test("拒绝超限走 forceExit：路径清空、执行标志为假", () => {
    const m = new PlanModeManager();
    m.enter("default");
    let ok = true;
    for (let i = 0; i < 5; i++) {
      m.submitForApproval();
      ok = m.reject();
    }
    expect(ok).toBe(false);
    expect(m.getState()).toBe("inactive");
    expect(m.getPlanFilePath()).toBeNull();
    expect(m.isExecuting()).toBe(false);
  });

  test("执行阶段保留路径；执行结束（endExecution）后清空", () => {
    const m = new PlanModeManager();
    m.enter("default");
    m.submitForApproval();
    m.approve();
    expect(m.getPlanFilePath()).not.toBeNull();
    m.endExecution();
    expect(m.getPlanFilePath()).toBeNull();
  });

  test("规划中途的 endExecution（每个用户回合开头都会调）不丢路径", () => {
    const m = new PlanModeManager();
    m.enter("default");
    const path = m.getPlanFilePath();
    m.endExecution();
    expect(m.getPlanFilePath()).toBe(path);
    expect(m.isPlanning()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// P3-2：子代理刻意不接计划重注，且写明了理由
// ─────────────────────────────────────────────────────────────
describe("P3-2 子代理 ContextManager 不接 setPlanContentProvider（刻意）", () => {
  test("两处构造都不调 setPlanContentProvider，且各留一条说明", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/agent/sub-agent.ts"), "utf-8");
    expect(src).not.toMatch(/\.setPlanContentProvider\(/);
    expect(src.match(/P3-2：/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
