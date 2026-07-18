/**
 * TaskCreateTool（工具名 task_create）— 新建结构化任务清单条目
 * 对标 claude-code TaskCreate：带依赖关系与归属的持久化 TODO 系统，服务多 agent 派活。
 * 与后台任务（bg_task_get/bg_task_list）是两个不同语义族。
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import { createStructuredTask } from "../task/structured-task-store.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

const taskCreateSchema = lazySchema(() =>
  z.object({
    subject: z.string().describe("任务标题（简短、祈使句，如「修复登录流程的鉴权 bug」）"),
    description: z.string().describe("任务的详细说明：需要做什么、上下文与验收标准"),
    activeForm: z
      .string()
      .optional()
      .describe("in_progress 时 spinner 展示的进行时描述（如「Running tests」），省略则展示 subject"),
    metadata: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("附加到任务的任意元数据"),
  }),
);

export class TaskCreateTool implements Tool {
  readonly zodSchema = taskCreateSchema();
  readonly shouldDefer = true;
  readonly searchHint = "structured task list create 结构化 任务 清单 新建 create todo 依赖";
  /** 任务清单维护类工具，连续 create 是正当行为，豁免循环检测 */
  readonly exemptFromLoopDetection = true;

  name(): string {
    return "task_create";
  }

  description(): string {
    return "在结构化任务清单中新建一个任务（带 subject/description/status/依赖/owner）。用于跟踪复杂多步工作、给多 agent 派活。注意：这是结构化清单，不是后台任务（后者用 bg_task_list）。";
  }

  usageGuide(): string {
    return `- 复杂多步任务（≥3 步）建议先建清单再逐项推进
- subject 用祈使句概括结果；description 写清做什么和验收标准
- 建完后用 task_update 设置依赖（addBlocks/addBlockedBy）和 owner 归属
- 单条查询用 task_get，列全部用 task_list`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(taskCreateSchema()) as Record<string, unknown>;
  }

  readOnly(): boolean {
    return false;
  }

  async execute(input: unknown): Promise<ToolResult> {
    const params = input as {
      subject?: string;
      description?: string;
      activeForm?: string;
      metadata?: Record<string, unknown>;
    };

    if (!params.subject || !params.subject.trim()) {
      return { output: "错误: 缺少 subject 参数", isError: true };
    }
    if (!params.description || !params.description.trim()) {
      return { output: "错误: 缺少 description 参数", isError: true };
    }

    const task = createStructuredTask({
      subject: params.subject.trim(),
      description: params.description.trim(),
      activeForm: params.activeForm?.trim() || undefined,
      metadata: params.metadata,
    });

    return {
      output: JSON.stringify({
        id: task.id,
        subject: task.subject,
        status: task.status,
        message: `任务 #${task.id} 已创建`,
      }),
    };
  }
}
