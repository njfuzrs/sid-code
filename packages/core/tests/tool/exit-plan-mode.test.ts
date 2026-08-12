/**
 * ExitPlanModeTool 单元测试（P0-1：消除 exit_plan_mode 空转）
 *
 * 根因 3：非 planning 状态下调用 exit_plan_mode 旧实现返回 isError:true，
 * 触发"报错 → 重试 → 再报错"空转（实测 46.9% 失败率、127 次"不在计划模式"）。
 * 修复后：非 planning 状态返回**幂等成功提示**（isError 不为 true），引导模型进入执行阶段。
 *
 * 参考: docs/bugfixes/todo/长任务遗漏-Harness根因与完成率提升方案.md §P0-1
 */

import { describe, it, expect } from "bun:test";
import { ExitPlanModeTool } from "@sid-code/core/tool/exit-plan-mode.ts";
import { PlanModeManager } from "@sid-code/core/plan/state.ts";

describe("ExitPlanModeTool — P0-1 幂等成功", () => {
  it("inactive 状态调用返回成功提示（非 isError），引导进入执行阶段", async () => {
    const mgr = new PlanModeManager(); // 默认 inactive
    const tool = new ExitPlanModeTool(mgr);

    const result = await tool.execute({});

    expect(result.isError).not.toBe(true);
    expect(result.output).toContain("执行阶段");
    // 不应再出现旧的报错文案
    expect(result.output).not.toContain("无法提交计划");
  });

  it("awaiting_approval 状态重复调用返回'已提交'提示（非 isError）", async () => {
    const mgr = new PlanModeManager();
    mgr.enter("default"); // → planning
    mgr.submitForApproval(); // → awaiting_approval
    const tool = new ExitPlanModeTool(mgr);

    const result = await tool.execute({});

    expect(result.isError).not.toBe(true);
    expect(result.output).toContain("等待用户审批");
  });

  it("planning 但计划文件不存在仍返回 isError（这是合法的引导而非空转）", async () => {
    const mgr = new PlanModeManager();
    mgr.enter("default"); // → planning，planFilePath 指向尚未创建的文件
    const tool = new ExitPlanModeTool(mgr);

    const result = await tool.execute({});

    // planning 状态下计划文件不存在 → 提示先写计划，这是 isError（与空转无关）
    expect(result.isError).toBe(true);
    expect(result.output).toContain("计划文件");
  });
});
