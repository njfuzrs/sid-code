/**
 * CronListTool（Spec 18 §5.3.3）
 * 列出所有定时任务。
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import { getScheduler } from "../cron/scheduler.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

const cronListSchema = lazySchema(() => z.object({}));

export class CronListTool implements Tool {
  readonly zodSchema = cronListSchema();
  /** 长尾工具：定时调度低频使用，延迟加载，由 tool_search 按需调出 */
  readonly shouldDefer = true;
  readonly searchHint = "cron schedule list jobs 定时 调度 列出 任务";

  name(): string {
    return "cron_list";
  }

  description(): string {
    return "列出当前所有定时任务（含会话级和持久任务）。";
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(cronListSchema()) as Record<string, unknown>;
  }

  readOnly(): boolean {
    return true;
  }

  async execute(): Promise<ToolResult> {
    const tasks = getScheduler().listTasks();
    if (tasks.length === 0) {
      return { output: "当前没有定时任务" };
    }

    const lines = tasks.map((t) => {
      const kind = t.recurring ? "循环" : "一次性";
      const durable = t.durable ? " [持久]" : "";
      return `${t.id}  ${t.cron}  ${kind}${durable}  ${t.prompt.slice(0, 60)}`;
    });

    return { output: `定时任务（${tasks.length}）:\n${lines.join("\n")}` };
  }
}
