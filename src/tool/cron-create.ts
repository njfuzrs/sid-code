/**
 * CronCreateTool（Spec 18 §5.3.3）
 * 创建定时任务。
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import { getScheduler } from "../cron/scheduler.ts";
import { isValidCron } from "../cron/parser.ts";
import type { CronTask } from "../cron/types.ts";
import { randomBytes } from "crypto";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

function shortId(): string {
  return randomBytes(4).toString("hex");
}

const cronCreateSchema = lazySchema(() =>
  z.object({
    cron: z.string().describe("5 字段 cron 表达式"),
    prompt: z.string().describe("触发时执行的 prompt"),
    recurring: z.boolean().optional().describe("是否循环（默认 true）"),
    durable: z.boolean().optional().describe("是否持久化（默认 false）"),
  }),
);

export class CronCreateTool implements Tool {
  readonly zodSchema = cronCreateSchema();

  name(): string {
    return "cron_create";
  }

  description(): string {
    return `创建定时任务。使用标准 5 字段 cron 表达式（本地时间：分 时 日 月 周）。
示例：
- "*/5 * * * *" — 每 5 分钟
- "0 9 * * 1-5" — 工作日早上 9 点
- "30 14 4 4 *" — 4月4日下午2:30（配合 recurring=false 为一次性）

recurring: true（默认）= 循环触发，7 天后自动过期
recurring: false = 触发一次后自动删除
durable: true = 持久化到磁盘，跨会话存活（默认 false）`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(cronCreateSchema()) as Record<string, unknown>;
  }

  async execute(input: unknown): Promise<ToolResult> {
    const params = input as {
      cron?: string;
      prompt?: string;
      recurring?: boolean;
      durable?: boolean;
    };

    if (!params.cron || !params.prompt) {
      return { output: "错误: 缺少必需参数 (cron, prompt)", isError: true };
    }

    if (!isValidCron(params.cron)) {
      return {
        output: `错误: 无效的 cron 表达式 "${params.cron}"（需要 5 个字段：分 时 日 月 周）`,
        isError: true,
      };
    }

    const task: CronTask = {
      id: shortId(),
      cron: params.cron,
      prompt: params.prompt,
      createdAt: Date.now(),
      recurring: params.recurring ?? true,
      durable: params.durable ?? false,
    };

    const scheduler = getScheduler();
    if (task.durable) {
      scheduler.addDurableTask(task);
    } else {
      scheduler.addSessionTask(task);
    }

    const typeLabel = task.recurring ? "循环任务（7 天后过期）" : "一次性任务";
    const durableLabel = task.durable ? "，已持久化" : "";
    return {
      output: `已创建${typeLabel}${durableLabel}，ID: ${task.id}\ncron: ${task.cron}`,
    };
  }
}
