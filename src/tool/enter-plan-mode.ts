/**
 * EnterPlanMode 工具
 * AI 可主动调用进入 Plan Mode，也可由用户通过 /plan 命令触发
 */

import type { Tool, ToolResult } from "./types.ts";
import type { PlanModeManager } from "../plan/state.ts";

export class EnterPlanModeTool implements Tool {
  constructor(private planManager: PlanModeManager) {}

  name(): string { return "enter_plan_mode"; }

  description(): string {
    return `在开始非简单的实现任务前主动使用此工具。在写代码之前先获得用户对方案的认可，避免浪费精力。

## 何时使用
- 新功能实现（涉及多文件修改）
- 存在多种合理实现路径
- 代码修改影响现有行为
- 架构决策
- 需求不明确
- 多文件变更（超过 2-3 个文件）

## 何时不使用
- 单行修复（typo、明显 bug）
- 用户已给出非常具体的指令
- 纯研究/探索任务（不涉及代码修改）

## 进入后的行为
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

  async execute(_input: unknown, _signal?: AbortSignal): Promise<ToolResult> {
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
