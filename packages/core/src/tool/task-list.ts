/**
 * BgTaskListTool（工具名 bg_task_list）— 列出所有后台任务
 * 后台任务运行态列表，对应 CC 的 TaskOutput 族；结构化清单列表见 structured-task-list.ts
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import { getAllTasks, isPanelTask, isAgentTask, isShellTask } from "../task/index.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

const taskListSchema = lazySchema(() =>
  z.object({
    status: z
      .enum(["running", "completed", "failed", "killed", "all"])
      .optional()
      .describe("按状态过滤（默认 all）"),
  }),
);

export class TaskListTool implements Tool {
  readonly zodSchema = taskListSchema();
  /** 长尾工具：仅在有后台任务时使用，延迟加载，由 tool_search 按需调出 */
  readonly shouldDefer = true;
  readonly searchHint = "background task list status 后台 任务 列出 状态 bg_task_list";
  /**
   * P2-3：任务管理类工具，状态查询连续调用是正当行为而非循环，豁免循环检测。
   *
   * P1-3 收窄：这个豁免现在是**有条件**的——见 `loop-detection.ts` 的
   * `CONDITIONALLY_EXEMPT_TOOLS`。入参**不同**时才豁免（那才是"查询不同任务"的真实形态）；
   * 入参相同且连续达阈值会被正常拦下。改造前是无条件豁免，实测放过了 49 次
   * 入参全为 `{}` 且进度纹丝不动的轮询（占该会话全部工具调用的 18.8%）。
   */
  readonly exemptFromLoopDetection = true;

  name(): string {
    return "bg_task_list";
  }

  description(): string {
    return "列出所有后台任务（Shell 命令和 Agent），包含状态、类型、进度信息。用于了解当前有哪些任务正在运行或已完成。注意：这是运行态后台任务列表，不是结构化任务清单（后者用 task_list）。";
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

    // 经 isPanelTask 单一闸门（见 task/types.ts）：只报**后台**任务。
    // 前台子代理虽也在 registry（taskId / task_output 依赖它），但它是当前这一轮的同步工具调用，
    // 结果就在模型自己的 tool_result 里——报进来会让模型误以为"另有一个后台任务在跑"。
    const allTasks = getAllTasks().filter(isPanelTask);
    const filtered =
      statusFilter === "all" ? allTasks : allTasks.filter((t) => t.status === statusFilter);

    if (filtered.length === 0) {
      return {
        output:
          statusFilter === "all" ? "当前没有后台任务" : `没有状态为 "${statusFilter}" 的后台任务`,
      };
    }

    const lines = ["<task-list>"];
    for (const task of filtered) {
      const duration = task.endTime
        ? `${((task.endTime - task.startTime) / 1000).toFixed(1)}s`
        : `${((Date.now() - task.startTime) / 1000).toFixed(1)}s (运行中)`;

      lines.push(`  <task id="${task.id}" type="${task.type}" status="${task.status}">`);
      lines.push(`    <description>${task.description}</description>`);
      lines.push(`    <duration>${duration}</duration>`);

      if (isAgentTask(task)) {
        lines.push(`    <agent_type>${task.agentType}</agent_type>`);
        if (task.progress) {
          const p = task.progress;
          lines.push(`    <progress tools="${p.toolUseCount}" tokens="${p.tokenCount}">`);
          if (p.lastActivity) {
            lines.push(
              `      <last_activity>${p.lastActivity.toolName}: ${p.lastActivity.activityDescription || ""}</last_activity>`,
            );
          }
          lines.push(`    </progress>`);
        }
        if (task.result) {
          lines.push(`    <result_summary>${task.result.output.slice(0, 500)}</result_summary>`);
          lines.push(
            `    <usage total_tokens="${task.result.totalTokens}" tool_uses="${task.result.totalToolUseCount}"/>`,
          );
        }
        if (task.error) {
          lines.push(`    <error>${task.error.slice(0, 500)}</error>`);
        }
      }

      if (isShellTask(task)) {
        lines.push(`    <command>${task.command.slice(0, 200)}</command>`);
        if (task.exitCode !== undefined) {
          lines.push(`    <exit_code>${task.exitCode}</exit_code>`);
        }
      }

      lines.push(`  </task>`);
    }
    lines.push("</task-list>");

    return { output: lines.join("\n") };
  }
}
