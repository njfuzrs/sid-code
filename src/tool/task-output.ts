/**
 * TaskOutputTool — 读取后台任务输出
 * 支持阻塞等待和超时
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import {
  getTask,
  isTerminalStatus,
  getTaskOutputDelta,
  isShellTask,
  isAgentTask,
} from "../task/index.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

const taskOutputSchema = lazySchema(() =>
  z.object({
    task_id: z.string().describe("任务 ID"),
    block: z.boolean().optional().describe("是否阻塞等待任务完成（默认 true）"),
    timeout: z.number().optional().describe("最大等待时间（毫秒），默认 30000"),
  }),
);

export class TaskOutputTool implements Tool {
  readonly zodSchema = taskOutputSchema();

  name(): string {
    return "task_output";
  }

  description(): string {
    return `读取后台任务的输出内容。支持阻塞等待任务完成。
- block=true（默认）：等待任务完成后返回输出
- block=false：立即返回当前已有的输出
- timeout：最大等待时间（毫秒），默认 30000`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(taskOutputSchema()) as Record<string, unknown>;
  }

  readOnly(): boolean {
    return true;
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const params = input as {
      task_id: string;
      block?: boolean;
      timeout?: number;
    };

    if (!params.task_id) {
      return { output: "错误: 缺少 task_id 参数", isError: true };
    }

    const task = getTask(params.task_id);
    if (!task) {
      return { output: `任务 "${params.task_id}" 不存在`, isError: true };
    }

    const shouldBlock = params.block !== false;
    const timeout = Math.min(params.timeout ?? 30000, 600000);

    if (shouldBlock && !isTerminalStatus(task.status)) {
      const startTime = Date.now();
      while (Date.now() - startTime < timeout) {
        if (signal?.aborted) break;
        const current = getTask(params.task_id);
        if (!current || isTerminalStatus(current.status)) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    const currentTask = getTask(params.task_id);
    if (!currentTask) {
      return { output: `任务 "${params.task_id}" 已被驱逐`, isError: true };
    }

    const delta = await getTaskOutputDelta(params.task_id, currentTask.outputOffset);
    const output = delta?.content ?? "(无输出)";

    const info: Record<string, unknown> = {
      task_id: currentTask.id,
      status: currentTask.status,
      type: currentTask.type,
    };

    if (isShellTask(currentTask)) {
      info.command = currentTask.command;
      if (currentTask.exitCode !== undefined) info.exit_code = currentTask.exitCode;
    }
    if (isAgentTask(currentTask)) {
      info.agent_type = currentTask.agentType;
      if (currentTask.result) {
        info.result = currentTask.result.output.slice(0, 4000);
        info.total_tool_uses = currentTask.result.totalToolUseCount;
        info.total_tokens = currentTask.result.totalTokens;
        info.usage = currentTask.result.usage;
      }
    }

    return {
      output: JSON.stringify(info) + "\n\n--- 输出 ---\n" + output.slice(0, 30000),
    };
  }
}
