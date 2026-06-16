/**
 * TaskListTool — 列出所有后台任务
 * 对标 claude-code TaskListTool
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import {
  getAllTasks,
  isAgentTask,
  isShellTask,
} from "../task/index.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

const taskListSchema = lazySchema(() =>
  z.object({
    status: z
      .enum(["running", "completed", "failed", "killed", "all"])
      .optional()
      .describe("按状态过滤（默认 all）"),
  }),
);

export class TaskListTool implements Tool {
  readonly zodSchema = taskListSchema();

  name(): string {
    return "task_list";
  }

  description(): string {
    return "列出所有后台任务（Shell 命令和 Agent），包含状态、类型、进度信息。用于了解当前有哪些任务正在运行或已完成。";
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(taskListSchema()) as Record<string, unknown>;
  }

  readOnly(): boolean {
    return true;
  }

  async execute(input: unknown): Promise<ToolResult> {
    const params = input as { status?: string };
    const statusFilter = params.status || "all";

    const allTasks = getAllTasks();
    const filtered = statusFilter === "all"
      ? allTasks
      : allTasks.filter(t => t.status === statusFilter);

    if (filtered.length === 0) {
      return {
        output: statusFilter === "all"
          ? "当前没有后台任务"
          : `没有状态为 "${statusFilter}" 的后台任务`,
      };
    }

    const lines = ["<task-list>"];
    for (const task of filtered) {
      const duration = task.endTime
        ? `${((task.endTime - task.startTime) / 1000).toFixed(1)}s`
        : `${((Date.now() - task.startTime) / 1000).toFixed(1)}s (运行中)`;

      lines.push(`  <task id="${task.id}" type="${task.type}" status="${task.status}">`);
      lines.push(`    <description>${task.description}</description>`);
      lines.push(`    <duration>${duration}</duration>`);

      if (isAgentTask(task)) {
        lines.push(`    <agent_type>${task.agentType}</agent_type>`);
        if (task.progress) {
          const p = task.progress;
          lines.push(`    <progress tools="${p.toolUseCount}" tokens="${p.tokenCount}">`);
          if (p.lastActivity) {
            lines.push(`      <last_activity>${p.lastActivity.toolName}: ${p.lastActivity.activityDescription || ""}</last_activity>`);
          }
          lines.push(`    </progress>`);
        }
        if (task.result) {
          lines.push(`    <result_summary>${task.result.output.slice(0, 500)}</result_summary>`);
          lines.push(`    <usage total_tokens="${task.result.totalTokens}" tool_uses="${task.result.totalToolUseCount}"/>`);
        }
        if (task.error) {
          lines.push(`    <error>${task.error.slice(0, 500)}</error>`);
        }
      }

      if (isShellTask(task)) {
        lines.push(`    <command>${task.command.slice(0, 200)}</command>`);
        if (task.exitCode !== undefined) {
          lines.push(`    <exit_code>${task.exitCode}</exit_code>`);
        }
      }

      lines.push(`  </task>`);
    }
    lines.push("</task-list>");

    return { output: lines.join("\n") };
  }
}
