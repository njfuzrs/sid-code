/**
 * TaskGetTool（工具名 task_get）— 查询结构化任务清单单条详情
 * 对标 claude-code TaskGet：返回 subject/description/status/blocks/blockedBy/owner。
 * 与后台任务查询（task_output）是两个不同语义族。
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
  // 工具名必须是现行名：bg_task_get 已于 D5/T8 并入 task_output（registry 别名表只是历史兼容），
  // guidance 里教旧名会让模型「见过名字、没见过 schema」，生成阶段坍缩成前缀相近的真实工具。
  // 由 tests/tool/deferred-guidance.test.ts 的工具名对账门禁守住。
  readonly guidance =
    "查结构化清单里某条任务的详情 / 上下游依赖时用（后台任务用 task_output，不是这个）。";
  readonly searchHint = "structured task list get detail blockedBy 结构化 任务 清单 查询 详情 依赖";
  readonly exemptFromLoopDetection = true;

  name(): string {
    return "task_get";
  }

  description(): string {
    return "查询结构化任务清单中某个任务的完整详情：subject/description/status/owner，以及它 blocks（下游）和 blockedBy（上游未完成依赖）。注意：这是结构化清单，不是后台任务（后者用 task_output）。";
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(taskGetSchema()) as Record<string, unknown>;
  }

  readOnly(): boolean {
    return true;
  }

  /**
   * B14：只读结构化任务账本，不需要用户批准。
   *
   * 权限链在 Step 13.6（见 permission/checker.ts 的 declaredNoPermission）直接放行；
   * 旧实现只有一张无头模式的名单盯着这件事，交互模式下这些工具照样会弹确认。
   */
  requiresPermission(): boolean {
    return false;
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
      output: JSON.stringify(
        {
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
        },
        null,
        2,
      ),
    };
  }
}
