/**
 * EnterPlanMode 工具
 * AI 可主动调用进入 Plan Mode，也可由用户通过 /plan 命令触发
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import type { PlanModeManager } from "../plan/state.ts";

export class EnterPlanModeTool implements Tool {
  constructor(private planManager: PlanModeManager) {}

  name(): string { return "enter_plan_mode"; }

  description(): string {
    return `在开始非简单的实现任务前主动使用此工具。在写代码之前先获得用户对方案的认可，避免浪费精力。

**IMPORTANT**: 仅当任务需要编写代码实现且存在以下情况之一时才使用:
- 涉及 3 个以上文件修改
- 存在多种合理实现路径
- 需要架构决策
- 需求不明确且需要先探索代码库

**DO NOT USE** 在以下情况:
- 用户已给出非常具体的指令（包含文件路径、修改内容、代码示例等）
- 单行修复 / 明显 bug
- 纯研究/探索任务
- 可以用一句话描述完整 diff 的任务

进入后的行为:
1. 使用 read、grep、glob 工具探索代码库
2. 理解现有模式和架构
3. 设计实现方案
4. 将计划写入计划文件
5. 调用 exit_plan_mode 提交审批`;
  }

  inputSchema(): Record<string, unknown> {
    return { type: "object", properties: {} };
  }

  readOnly(): boolean { return true; }

  async execute(input: unknown, _signal?: AbortSignal): Promise<ToolResult> {
    // 禁止在子代理上下文中进入 plan mode（防套娃）
    // 参考：Claude Code EnterPlanModeTool.ts:78-80
    const inp = input as Record<string, unknown> | undefined;
    if (inp?._agentId) {
      return {
        output: "子代理不能进入 plan mode。如需制定方案，请使用 sub_agent(type='plan') 委托子代理研究。",
        isError: true,
      };
    }

    if (this.planManager.isActive()) {
      return { output: "已经在计划模式中", isError: true };
    }

    const ok = this.planManager.enter();
    if (!ok) {
      return { output: "无法进入计划模式", isError: true };
    }

    const planPath = this.planManager.getPlanFilePath();
    // 复活完整工作流引导（缺陷修复）：原先这段引导通过重建 system prompt 注入，
    // 重建逻辑删除后丢失。现作为 tool_result 返回——走消息通道不破坏 Prompt Caching，
    // 同时保留阶段 1-5 工作流、决策记录防漂移、以及回应用户的"不清空上下文"说明。
    const { existsSync } = await import("fs");
    const planExists = planPath ? existsSync(planPath) : false;
    const { buildPlanModePrompt } = await import("../plan/prompt.ts");
    return {
      output: buildPlanModePrompt(planPath || "", planExists),
    };
  }
}
