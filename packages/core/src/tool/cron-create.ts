/**
 * CronCreateTool（Spec 18 §5.3.3）
 * 创建定时任务。
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import { getScheduler } from "../cron/scheduler.ts";
import { isValidCron } from "../cron/parser.ts";
import { type CronTask, isCronDisabled } from "../cron/types.ts";
import { durableFilePath } from "../cron/durable-store.ts";
import type { Scheduler } from "../cron/scheduler.ts";
import { randomBytes } from "crypto";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

function shortId(): string {
  return randomBytes(4).toString("hex");
}

/**
 * 告诉模型（和用户）这个 durable 任务到点由谁来跑。
 * 「已持久化」不等于「会执行」：会话关了又没有 daemon，任务就只是躺在盘上。
 */
function describeDriver(scheduler: Scheduler): string {
  const hint = "需运行 `sid-code daemon start`（或 `sid-code daemon install`）才会继续执行";
  switch (scheduler.durableDriver()) {
    case "daemon":
      return "触发方: 本机守护进程（会话关闭后照常执行）";
    case "self":
      return `触发方: 当前会话。会话关闭后${hint}`;
    case "other-session":
      return `触发方: 同项目的另一个会话。它关闭后${hint}`;
    case "none":
      return `触发方: 暂无（守护进程未运行，也没有交互会话在驱动本项目）。到点不会执行，${hint}`;
  }
}

const cronCreateSchema = lazySchema(() =>
  z.object({
    cron: z.string().describe("5 字段 cron 表达式"),
    prompt: z.string().describe("触发时执行的 prompt"),
    recurring: z.boolean().optional().describe("是否循环（默认 true）"),
    durable: z.boolean().optional().describe("是否持久化（默认 false）"),
    allowed_tools: z
      .array(z.string())
      .optional()
      .describe(
        "无头执行时预授权的工具白名单（仅 durable 任务有意义）。守护进程无人值守，" +
          "默认以只读（plan）模式运行；声明此白名单可放行写文件/跑命令等工具。缺省=只读。",
      ),
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

recurring: true（默认）= 循环触发；会话级 7 天后自动过期，durable 不过期（需手动删除）
recurring: false = 触发一次后自动删除
durable: true = 持久化到 <项目>/.sid-code/scheduled_tasks.json，跨会话存活（默认 false）。
  会话开着时由会话触发；会话关了由 sid-code daemon 触发（daemon 不在则到点不会执行）
allowed_tools: 无头执行时预授权的工具白名单（仅 durable 任务有意义，缺省默认只读）`;
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
      allowed_tools?: string[];
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

    // 任务级预授权白名单（§5.3）：仅 durable 任务无头执行时有意义，去重去空。
    // 协议层字段名是 allowed_tools；CronTask.allowedTools 是持久化到 scheduled_tasks.json
    // 的磁盘格式，不跟着改——改了会让已存在的 durable 任务读不出白名单。
    const allowedTools =
      Array.isArray(params.allowed_tools) && params.allowed_tools.length > 0
        ? [...new Set(params.allowed_tools.map((s) => String(s).trim()).filter(Boolean))]
        : undefined;

    const task: CronTask = {
      id: shortId(),
      cron: params.cron,
      prompt: params.prompt,
      createdAt: Date.now(),
      recurring: params.recurring ?? true,
      durable: params.durable ?? false,
      // 缺口 C1 §4.4：记录执行目录，守护进程 fork headless 时用作 cwd。
      workspaceDir: process.cwd(),
      // 缺口 C1 §5.3：任务级预授权白名单（缺省=守护进程默认只读）。
      ...(allowedTools ? { allowedTools } : {}),
    };

    // 整体禁用优先于上限检查：禁用时连「已达上限」都不该说，口径要一致。
    if (isCronDisabled()) {
      return {
        output: "cron 已被 SID_CODE_DISABLE_CRON 禁用，无法创建定时任务。",
        isError: true,
      };
    }

    const scheduler = getScheduler();
    if (task.durable) {
      // 写盘与 durable-projects 登记都在 addDurableTask 里，失败抛错。
      // B43：此前写盘失败（或根本没写）也回「已持久化」，登记失败被吞。
      let added: boolean;
      try {
        added = scheduler.addDurableTask(task);
      } catch (err: any) {
        return {
          output: `错误: 持久任务写盘失败，任务未创建: ${err?.message ?? err}`,
          isError: true,
        };
      }
      if (!added) {
        return {
          output: `已达定时任务上限 (${scheduler.durableCap()})，请先用 cron_delete 删除不需要的任务`,
          isError: true,
        };
      }
    } else {
      if (!scheduler.addSessionTask(task)) {
        return {
          output: `已达定时任务上限 (${scheduler.sessionCap()})，请先用 cron_delete 删除不需要的任务`,
          isError: true,
        };
      }
    }

    const typeLabel = task.recurring
      ? task.durable
        ? "循环任务（不自动过期）"
        : "循环任务（7 天后过期）"
      : "一次性任务";
    const durableLabel = task.durable ? `，已写入 ${durableFilePath(task.workspaceDir!)}` : "";
    const driverLabel = task.durable ? `\n${describeDriver(scheduler)}` : "";
    const toolsLabel = allowedTools
      ? `\n预授权工具: ${allowedTools.join(", ")}`
      : task.durable
        ? "\n预授权工具: 无（守护进程将以只读模式执行）"
        : "";
    return {
      output: `已创建${typeLabel}${durableLabel}，ID: ${task.id}\ncron: ${task.cron}${toolsLabel}${driverLabel}`,
    };
  }
}
