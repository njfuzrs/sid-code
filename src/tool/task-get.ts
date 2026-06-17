/**
 * TaskGetTool — 获取单个任务详情
 * 对标 claude-code TaskGetTool
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import {
  getTask,
  isAgentTask,
  isShellTask,
} from "../task/index.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

const taskGetSchema = lazySchema(() =>
  z.object({
    task_id: z.string().describe("要查询的任务 ID"),
  }),
);

export class TaskGetTool implements Tool {
  readonly zodSchema = taskGetSchema();
  /** 长尾工具：仅在有后台任务时使用，延迟加载，由 tool_search 按需调出 */
  readonly shouldDefer = true;
  readonly searchHint = "background task get detail 后台 任务 详情 查询";

  name(): string {
    return "task_get";
  }

  description(): string {
    return "获取单个后台任务的详细信息，包含状态、进度、输出等。";
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(taskGetSchema()) as Record<string, unknown>;
  }

  readOnly(): boolean {
    return true;
  }

  async execute(input: unknown): Promise<ToolResult> {
    const params = input as { task_id: string };

    if (!params.task_id) {
      return { output: "错误: 缺少 task_id 参数", isError: true };
    }

    const task = getTask(params.task_id);
    if (!task) {
      return { output: `任务 "${params.task_id}" 不存在`, isError: true };
    }

    const duration = task.endTime
      ? `${((task.endTime - task.startTime) / 1000).toFixed(1)}s`
      : `${((Date.now() - task.startTime) / 1000).toFixed(1)}s (运行中)`;

    const lines = [
      `<task id="${task.id}" type="${task.type}" status="${task.status}">`,
      `  <description>${task.description}</description>`,
      `  <duration>${duration}</duration>`,
    ];

    if (isAgentTask(task)) {
      lines.push(`  <agent_type>${task.agentType}</agent_type>`);
      if (task.progress) {
        const p = task.progress;
        lines.push(`  <progress tools="${p.toolUseCount}" tokens="${p.tokenCount}">`);
        if (p.lastActivity) {
          lines.push(`    <last_activity>${p.lastActivity.toolName}: ${p.lastActivity.activityDescription || ""}</last_activity>`);
        }
        lines.push(`  </progress>`);
      }
      if (task.result) {
        lines.push(`  <result>${task.result.output.slice(0, 4000)}</result>`);
        lines.push(`  <usage total_tokens="${task.result.totalTokens}" tool_uses="${task.result.totalToolUseCount}"/>`);
      }
      if (task.error) {
        lines.push(`  <error>${task.error.slice(0, 2000)}</error>`);
      }
      if (task.progressSummary) {
        lines.push(`  <progress_summary>${task.progressSummary}</progress_summary>`);
      }
    }

    if (isShellTask(task)) {
      lines.push(`  <command>${task.command.slice(0, 500)}</command>`);
      if (task.exitCode !== undefined) {
        lines.push(`  <exit_code>${task.exitCode}</exit_code>`);
      }
      if (task.interrupted) {
        lines.push(`  <interrupted>true</interrupted>`);
      }
    }

    lines.push("</task>");
    return { output: lines.join("\n") };
  }
}
