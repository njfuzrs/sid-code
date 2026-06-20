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
  /** 长尾工具：定时调度低频使用，延迟加载，由 tool_search 按需调出 */
  readonly shouldDefer = true;
  readonly searchHint = "cron schedule timer recurring reminder 定时 调度 计划任务 提醒";

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
      // 缺口 C1 §4.4：记录执行目录，守护进程 fork headless 时用作 cwd。
      workspaceDir: process.cwd(),
    };

    const scheduler = getScheduler();
    if (task.durable) {
      scheduler.addDurableTask(task);
      // 缺口 C1 §4.5：登记本项目到 durable-projects 注册表，
      // 守护进程据此发现「所有项目的」durable 任务（自愈剔除失效项）。
      try {
        const { registerDurableProject } = await import("../daemon/durable-projects.ts");
        registerDurableProject(process.cwd());
      } catch {
        /* 注册失败不阻塞任务创建 */
      }
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
