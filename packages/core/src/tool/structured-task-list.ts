/**
 * TaskListTool（工具名 task_list）— 列出结构化任务清单
 * 对标 claude-code TaskList：返回每个任务的 id/subject/status/owner/blockedBy 摘要。
 * 与后台任务列表（bg_task_list）是两个不同语义族。
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import { getAllStructuredTasks, isTaskUnblocked } from "../task/structured-task-store.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

const taskListSchema = lazySchema(() =>
  z.object({
    status: z
      .enum(["pending", "in_progress", "completed", "all"])
      .optional()
      .describe("按状态过滤（默认 all）"),
  }),
);

export class StructuredTaskListTool implements Tool {
  readonly zodSchema = taskListSchema();
  readonly shouldDefer = true;
  readonly searchHint = "structured task list all status owner 结构化 任务 清单 列出 状态 依赖";
  readonly exemptFromLoopDetection = true;

  name(): string {
    return "task_list";
  }

  description(): string {
    return "列出结构化任务清单中的所有任务，含 id/subject/status/owner 及被哪些上游任务阻塞（blockedBy）。用于查看可开工任务（pending、无 owner、未被阻塞）与整体进度。注意：这是结构化清单，不是后台任务（后者用 bg_task_list）。";
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

    const all = getAllStructuredTasks();
    const filtered = statusFilter === "all" ? all : all.filter((t) => t.status === statusFilter);

    if (filtered.length === 0) {
      return {
        output:
          statusFilter === "all" ? "结构化任务清单为空" : `没有状态为 "${statusFilter}" 的任务`,
      };
    }

    const items = filtered.map((t) => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      owner: t.owner || "",
      blockedBy: t.blockedBy,
      unblocked: isTaskUnblocked(t),
    }));

    return { output: JSON.stringify({ tasks: items }, null, 2) };
  }
}
