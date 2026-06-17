/**
 * TaskStopTool — 终止后台任务
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import {
  getTask,
  isTerminalStatus,
  isShellTask,
  isAgentTask,
  killShellTask,
  killAgentTask,
} from "../task/index.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

const taskStopSchema = lazySchema(() =>
  z.object({
    task_id: z.string().describe("要终止的任务 ID"),
  }),
);

export class TaskStopTool implements Tool {
  readonly zodSchema = taskStopSchema();
  /** 长尾工具：仅在有后台任务时使用，延迟加载，由 tool_search 按需调出 */
  readonly shouldDefer = true;
  readonly searchHint = "background task stop kill cancel 后台 任务 停止 终止";

  name(): string {
    return "task_stop";
  }

  description(): string {
    return "终止一个正在运行的后台任务（Shell 命令或 Agent）。";
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(taskStopSchema()) as Record<string, unknown>;
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

    if (isTerminalStatus(task.status)) {
      return {
        output: JSON.stringify({
          task_id: task.id,
          status: task.status,
          message: "任务已处于终态，无需终止",
        }),
      };
    }

    if (isShellTask(task)) {
      killShellTask(task.id);
    } else if (isAgentTask(task)) {
      killAgentTask(task.id);
    }

    return {
      output: JSON.stringify({
        task_id: task.id,
        status: "killed",
        message: `任务 "${task.description}" 已终止`,
      }),
    };
  }
}
