/**
 * CronDeleteTool（Spec 18 §5.3.3）
 * 删除定时任务。
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import { getScheduler } from "../cron/scheduler.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

const cronDeleteSchema = lazySchema(() =>
  z.object({
    id: z.string().describe("要删除的任务 ID"),
  }),
);

export class CronDeleteTool implements Tool {
  readonly zodSchema = cronDeleteSchema();

  name(): string {
    return "cron_delete";
  }

  description(): string {
    return "删除指定 ID 的定时任务。";
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(cronDeleteSchema()) as Record<string, unknown>;
  }

  async execute(input: unknown): Promise<ToolResult> {
    const params = input as { id?: string };
    if (!params.id) {
      return { output: "错误: 缺少 id 参数", isError: true };
    }

    const ok = getScheduler().removeTask(params.id);
    return ok
      ? { output: `已删除定时任务 ${params.id}` }
      : { output: `任务 ${params.id} 不存在`, isError: true };
  }
}
