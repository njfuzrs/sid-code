/**
 * ExitPlanMode 工具
 * AI 完成计划编写后调用，提交计划等待用户审批
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import type { PlanModeManager } from "../plan/state.ts";
import { existsSync, readFileSync } from "fs";

export class ExitPlanModeTool implements Tool {
  constructor(private planManager: PlanModeManager) {}

  name(): string { return "exit_plan_mode"; }

  description(): string {
    return `在计划模式下完成计划编写后使用此工具，请求用户审批。
此工具会读取计划文件内容并展示给用户。
只有在计划模式下且已将计划写入计划文件后才能使用。

重要：
- 不要用此工具问"计划可以吗？"——这个工具本身就是请求审批
- 确保计划完整且无歧义后再调用
- 纯研究任务不要使用此工具`;
  }

  inputSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "计划的简短摘要（1-2 句话）",
        },
      },
    };
  }

  readOnly(): boolean { return true; }

  async execute(input: unknown, _signal?: AbortSignal): Promise<ToolResult> {
    if (!this.planManager.isPlanning()) {
      return { output: "当前不在计划模式中，无法提交计划", isError: true };
    }

    const planPath = this.planManager.getPlanFilePath();
    if (!planPath || !existsSync(planPath)) {
      return {
        output: `计划文件不存在: ${planPath}\n请先使用 write 工具将计划写入计划文件`,
        isError: true,
      };
    }

    // 读取计划文件内容
    const planContent = readFileSync(planPath, "utf-8");
    if (!planContent.trim()) {
      return { output: "计划文件为空，请先写入计划内容", isError: true };
    }

    // 提交审批
    this.planManager.submitForApproval();

    const summary = (input as any)?.summary || "";
    const summaryLine = summary ? `\n摘要: ${summary}` : "";

    return {
      output: `计划已提交，等待用户审批。${summaryLine}\n\n---\n${planContent}\n---`,
    };
    // 实际的用户审批交互由 App 层的 executeTools 拦截处理
  }
}
