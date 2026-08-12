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
    active_form: z
      .string()
      .optional()
      .describe(
        "in_progress 时 spinner 展示的进行时描述（如「Running tests」），省略则展示 subject",
      ),
    metadata: z.record(z.string(), z.unknown()).optional().describe("附加到任务的任意元数据"),
  }),
);

export class TaskCreateTool implements Tool {
  readonly zodSchema = taskCreateSchema();
  readonly shouldDefer = true;
  readonly searchHint = "structured task list create 结构化 任务 清单 新建 create todo 依赖";
  /** 任务清单维护类工具，连续 create 是正当行为，豁免循环检测 */
  readonly exemptFromLoopDetection = true;
  /**
   * 保留卡片、丢弃 `⎿` 正文（header 摘要用用户语言说"建了什么任务"）。
   *
   * `output` 是裸 `JSON.stringify({id, subject, status, message})`——它会命中
   * `ToolResultDisplay.tsx` 的 JSON 分支被 pretty-print 成多行 JSON 块糊在消息流里。
   * 给模型的是机器可读 JSON，给用户的应该是一句话。
   *
   * ⚠️ **刻意不用 hidden，尽管 cc 对 `TaskCreateTool` 用的是 hidden**
   * （`TaskCreateTool.ts:77` `renderToolUseMessage() { return null }` + 不实现
   * `renderToolResultMessage`）。cc 能隐藏是因为它有 `TaskListV2` 面板读 `appState.tasks`
   * 常驻展示结构化任务；而本仓库的 `structured-task-store` 在 `src/ui/` 与 `app.ts` 里
   * **零消费者**（实测），TodoPanel 的「后台任务」区读的是 shell/agent/workflow 任务
   * （`ui/state-bridge.ts`），与结构化清单无关。
   *
   * 所以这里 hidden 会让"新建了一个任务"这件事在界面上**彻底无痕**——把啰嗦换成静默丢失。
   * 若将来把结构化清单接进某个常驻面板，再改回 hidden 才成立。
   */
  readonly resultDisplayMode = "summary" as const;

  name(): string {
    return "task_create";
  }

  description(): string {
    return "在结构化任务清单中新建一个任务（带 subject/description/status/依赖/owner）。用于跟踪复杂多步工作、给多 agent 派活。注意：这是结构化清单，不是后台任务（后者用 bg_task_list）。";
  }

  usageGuide(): string {
    return `- 复杂多步任务（≥3 步）建议先建清单再逐项推进
- subject 用祈使句概括结果；description 写清做什么和验收标准
- 建完后用 task_update 设置依赖（add_blocks/add_blocked_by）和 owner 归属
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
      active_form?: string;
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
      activeForm: params.active_form?.trim() || undefined,
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
