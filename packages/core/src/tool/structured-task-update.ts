/**
 * TaskUpdateTool（工具名 task_update）— 更新结构化任务清单条目
 * 对标 claude-code TaskUpdate：改 status/owner/依赖，或删除任务。
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import { updateStructuredTask } from "../task/structured-task-store.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

const taskUpdateSchema = lazySchema(() =>
  z.object({
    task_id: z.string().describe("要更新的任务 ID"),
    status: z
      .enum(["pending", "in_progress", "completed", "deleted"])
      .optional()
      .describe("新状态。deleted 表示删除该任务（并摘除其依赖边）"),
    subject: z.string().optional().describe("新标题（祈使句）"),
    description: z.string().optional().describe("新描述"),
    active_form: z.string().optional().describe("in_progress 时 spinner 展示的进行时描述"),
    owner: z.string().optional().describe("认领者 agent 名（teams 派活用）"),
    metadata: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("合并进 metadata 的键；值设为 null 表示删除该键"),
    add_blocks: z
      .array(z.string())
      .optional()
      .describe("本任务完成后才能开始的下游任务 ID（本任务 blocks 它们）"),
    add_blocked_by: z
      .array(z.string())
      .optional()
      .describe("必须先完成、否则本任务不能开始的上游任务 ID"),
  }),
);

export class TaskUpdateTool implements Tool {
  readonly zodSchema = taskUpdateSchema();
  readonly shouldDefer = true;
  readonly searchHint =
    "structured task list update status owner blocks 结构化 任务 清单 更新 状态 依赖 删除";
  readonly exemptFromLoopDetection = true;
  /**
   * 同 task_create：output 是裸 JSON（会被 pretty-print 成多行糊在消息流里），
   * 但结构化清单在本仓库没有任何常驻面板呈现，故用 summary 而非 hidden
   * ——理由与对标差异见 `structured-task-create.ts` 同名字段的注释。
   */
  readonly resultDisplayMode = "summary" as const;

  name(): string {
    return "task_update";
  }

  description(): string {
    return "更新结构化任务清单中的一个任务：改 status（含 deleted 删除）/subject/description/owner，或用 add_blocks/add_blocked_by 建立依赖关系。开始工作时置 in_progress，完成后置 completed。";
  }

  usageGuide(): string {
    return `- 开始某任务前把 status 置为 in_progress，完成后置 completed
- 只有在完全完成时才置 completed（测试通过、无遗留错误）；受阻则保持 in_progress
- add_blocked_by 引用的上游任务全部 completed 后，本任务才算解锁
- status=deleted 删除任务（会自动摘除相关依赖边）`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(taskUpdateSchema()) as Record<string, unknown>;
  }

  readOnly(): boolean {
    return false;
  }

  async execute(input: unknown): Promise<ToolResult> {
    const params = input as {
      task_id?: string;
      status?: "pending" | "in_progress" | "completed" | "deleted";
      subject?: string;
      description?: string;
      active_form?: string;
      owner?: string;
      metadata?: Record<string, unknown>;
      add_blocks?: string[];
      add_blocked_by?: string[];
    };

    if (!params.task_id) {
      return { output: "错误: 缺少 task_id 参数", isError: true };
    }

    const result = updateStructuredTask(params.task_id, {
      status: params.status,
      subject: params.subject,
      description: params.description,
      activeForm: params.active_form,
      owner: params.owner,
      metadata: params.metadata,
      addBlocks: params.add_blocks,
      addBlockedBy: params.add_blocked_by,
    });

    if (!result.ok) {
      return { output: `错误: ${result.error}`, isError: true };
    }

    if (result.deleted) {
      return {
        output: JSON.stringify({
          taskId: params.task_id,
          deleted: true,
          message: `任务 #${params.task_id} 已删除`,
        }),
      };
    }

    const t = result.task!;
    return {
      output: JSON.stringify({
        id: t.id,
        subject: t.subject,
        status: t.status,
        owner: t.owner,
        blocks: t.blocks,
        blockedBy: t.blockedBy,
        message: `任务 #${t.id} 已更新`,
      }),
    };
  }
}
