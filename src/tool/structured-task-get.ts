/**
 * TaskGetTool（工具名 task_get）— 查询结构化任务清单单条详情
 * 对标 claude-code TaskGet：返回 subject/description/status/blocks/blockedBy/owner。
 * 与后台任务查询（bg_task_get）是两个不同语义族。
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import { getStructuredTask, isTaskUnblocked } from "../task/structured-task-store.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

const taskGetSchema = lazySchema(() =>
  z.object({
    task_id: z.string().describe("要查询的任务 ID"),
  }),
);

export class StructuredTaskGetTool implements Tool {
  readonly zodSchema = taskGetSchema();
  readonly shouldDefer = true;
  readonly searchHint = "structured task list get detail blockedBy 结构化 任务 清单 查询 详情 依赖";
  readonly exemptFromLoopDetection = true;

  name(): string {
    return "task_get";
  }

  description(): string {
    return "查询结构化任务清单中某个任务的完整详情：subject/description/status/owner，以及它 blocks（下游）和 blockedBy（上游未完成依赖）。注意：这是结构化清单，不是后台任务（后者用 bg_task_get）。";
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(taskGetSchema()) as Record<string, unknown>;
  }

  readOnly(): boolean {
    return true;
  }

  async execute(input: unknown): Promise<ToolResult> {
    const params = input as { task_id?: string };

    if (!params.task_id) {
      return { output: "错误: 缺少 task_id 参数", isError: true };
    }

    const task = getStructuredTask(params.task_id);
    if (!task) {
      return { output: `任务 "${params.task_id}" 不存在`, isError: true };
    }

    return {
      output: JSON.stringify({
        id: task.id,
        subject: task.subject,
        description: task.description,
        status: task.status,
        activeForm: task.activeForm,
        owner: task.owner,
        blocks: task.blocks,
        blockedBy: task.blockedBy,
        unblocked: isTaskUnblocked(task),
        metadata: task.metadata,
      }, null, 2),
    };
  }
}
