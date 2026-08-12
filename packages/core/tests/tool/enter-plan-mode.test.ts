/**
 * EnterPlanModeTool 单测
 *
 * 重点回归 P1-2 防套娃硬拦截（docs/bugfixes/done/PlanMode-套娃根因与TodoWrite方案.md）：
 * 子代理上下文（input._agentId 注入）调用 enter_plan_mode 必须被拒绝，
 * 从源头切断"子代理再次进入 plan mode → 第 2/3 层套娃"的递归路径。
 * 子代理工具执行器（agent/tool-executor.ts、sub-agent.ts、forked-agent.ts）
 * 统一注入 _agentId，本工具据此识别并拦截。
 */

import { describe, test, expect } from "bun:test";
import { EnterPlanModeTool } from "@sid-code/core/tool/enter-plan-mode.ts";
import { PlanModeManager } from "@sid-code/core/plan/state.ts";

describe("EnterPlanModeTool — 防套娃(_agentId)硬拦截", () => {
  test("子代理上下文(_agentId=sub-agent)调用被拒绝，且不改变 plan 状态", async () => {
    const mgr = new PlanModeManager();
    const tool = new EnterPlanModeTool(mgr);
    const result = await tool.execute({ _agentId: "sub-agent" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("子代理不能进入 plan mode");
    // 关键：被拒后状态机不应被推进（仍 inactive）
    expect(mgr.isActive()).toBe(false);
    expect(mgr.getState()).toBe("inactive");
  });

  test("forked-agent 上下文同样被拒绝", async () => {
    const mgr = new PlanModeManager();
    const tool = new EnterPlanModeTool(mgr);
    const result = await tool.execute({ _agentId: "forked-agent" });
    expect(result.isError).toBe(true);
    expect(mgr.isActive()).toBe(false);
  });

  test("任意非空 _agentId 都触发拦截（防御未来新增的子代理类型）", async () => {
    const mgr = new PlanModeManager();
    const tool = new EnterPlanModeTool(mgr);
    const result = await tool.execute({ _agentId: "some-future-agent-kind" });
    expect(result.isError).toBe(true);
    expect(mgr.isActive()).toBe(false);
  });
});

describe("EnterPlanModeTool — 主代理正常进入", () => {
  test("主代理(无 _agentId)正常进入 planning 状态", async () => {
    const mgr = new PlanModeManager();
    const tool = new EnterPlanModeTool(mgr);
    const result = await tool.execute({});
    expect(result.isError).toBeFalsy();
    expect(mgr.isPlanning()).toBe(true);
  });

  test("进入后返回完整工作流引导(阶段 1-5 + 决策记录 + 不清空上下文说明)", async () => {
    const mgr = new PlanModeManager();
    const tool = new EnterPlanModeTool(mgr);
    const result = await tool.execute({});
    // 复活的 buildPlanModePrompt 引导应通过 tool_result 返回
    expect(result.output).toContain("计划模式已激活");
    expect(result.output).toContain("决策记录");
    expect(result.output).toContain("不会清空对话历史");
    // 计划文件路径应出现在引导中
    const planPath = mgr.getPlanFilePath();
    expect(planPath).toBeTruthy();
    if (planPath) expect(result.output).toContain(planPath);
  });

  test("undefined input(无参数)也能正常进入", async () => {
    const mgr = new PlanModeManager();
    const tool = new EnterPlanModeTool(mgr);
    const result = await tool.execute(undefined);
    expect(result.isError).toBeFalsy();
    expect(mgr.isPlanning()).toBe(true);
  });
});

describe("EnterPlanModeTool — 重入防护", () => {
  test("已在 plan mode 中再次进入被拒绝", async () => {
    const mgr = new PlanModeManager();
    const tool = new EnterPlanModeTool(mgr);
    await tool.execute({}); // 首次进入
    expect(mgr.isPlanning()).toBe(true);
    const result = await tool.execute({}); // 再次进入
    expect(result.isError).toBe(true);
    expect(result.output).toContain("已经在计划模式中");
  });

  test("awaiting_approval 状态下再次进入也被拒绝", async () => {
    const mgr = new PlanModeManager();
    const tool = new EnterPlanModeTool(mgr);
    await tool.execute({});
    mgr.submitForApproval();
    expect(mgr.isAwaitingApproval()).toBe(true);
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.output).toContain("已经在计划模式中");
  });
});

describe("EnterPlanModeTool — 元信息", () => {
  test("name / readOnly 正确", () => {
    const mgr = new PlanModeManager();
    const tool = new EnterPlanModeTool(mgr);
    expect(tool.name()).toBe("enter_plan_mode");
    expect(tool.readOnly()).toBe(true);
  });

  test("description 含克制边界引导（真实架构歧义 / 直接开始工作）", () => {
    const mgr = new PlanModeManager();
    const tool = new EnterPlanModeTool(mgr);
    const desc = tool.description();
    // ant 版克制写法：「真实架构歧义」是入口条件，「直接开始工作」是默认倾向
    expect(desc).toContain("真实架构歧义");
    expect(desc).toContain("直接开始工作");
  });
});
