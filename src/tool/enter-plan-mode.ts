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
    return {
      output: `已进入计划模式。你现在只能使用只读工具（read、grep、glob）来探索代码库。
计划文件路径: ${planPath}
请分析代码库并制定实现方案，完成后调用 exit_plan_mode 提交计划。`,
    };
  }
}
