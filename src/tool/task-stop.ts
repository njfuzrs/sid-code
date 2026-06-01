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

export class TaskStopTool implements Tool {
  name(): string {
    return "task_stop";
  }

  description(): string {
    return "终止一个正在运行的后台任务（Shell 命令或 Agent）。";
  }

  inputSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "要终止的任务 ID",
        },
      },
      required: ["task_id"],
    };
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
