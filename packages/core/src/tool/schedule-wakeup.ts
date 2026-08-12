/**
 * ScheduleWakeupTool（缺口 A：动态自定步）
 *
 * 对标 claude-code 的 ScheduleWakeup：让模型在动态轮询场景（如「跑到 CI 过为止」）
 * 自行决定下次唤醒的延迟，而不必手写 cron 表达式。
 *
 * 内部转为 recurring=false 的一次性任务，用绝对触发时刻 fireAt（now + delay_seconds）
 * 直接调度，绕过 cron 解析。触发后任务自删（见 scheduler.check 的一次性分支）。
 *
 * delay_seconds 钳制到 [60, 3600]：
 * - 下限 60s：避免高频空转。
 * - 上限 3600s：单次唤醒最长 1 小时，更久的周期任务应走 cron_create。
 * 取舍提示（与 cc 一致）：prompt 缓存 TTL 约 5 分钟，睡过 300s 会付一次缓存 miss，
 * 所以要么 <270s（缓存还热）、要么 ≥1200s（一次 miss 换更久等待），避开 300s 附近。
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import { getScheduler } from "../cron/scheduler.ts";
import type { CronTask } from "../cron/types.ts";
import { randomBytes } from "crypto";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

function shortId(): string {
  return randomBytes(4).toString("hex");
}

/** 延迟下限/上限（秒） */
const MIN_DELAY_S = 60;
const MAX_DELAY_S = 3600;

const scheduleWakeupSchema = lazySchema(() =>
  z.object({
    delay_seconds: z.number().describe("距现在多少秒后唤醒一次。会被钳制到 [60, 3600]。"),
    prompt: z.string().describe("唤醒时执行的 prompt"),
    reason: z.string().optional().describe("一句话说明为何选这个延迟（如「等 CI 跑完约 4 分钟」）"),
  }),
);

export class ScheduleWakeupTool implements Tool {
  readonly zodSchema = scheduleWakeupSchema();
  /** 长尾工具：动态轮询低频使用，延迟加载，由 tool_search 按需调出 */
  readonly shouldDefer = true;
  readonly searchHint =
    "schedule wakeup poll delay dynamic interval 唤醒 轮询 延迟 自定步 等待 稍后";

  name(): string {
    return "schedule_wakeup";
  }

  description(): string {
    return `安排在 N 秒后唤醒一次并执行 prompt（动态自定步，一次性）。
用于不定期轮询场景：模型自己决定下次检查的延迟，而不必手写 cron。
典型用法：「跑到 CI 过为止」——每次唤醒检查状态，没过就再调一次本工具。

- delay_seconds 会被钳制到 [60, 3600]（1 分钟 ~ 1 小时）。
- 触发一次后自动删除；要继续轮询请在唤醒后再次调用。
- 固定节奏的循环任务请改用 cron_create。

取舍提示：prompt 缓存 TTL 约 5 分钟。睡过 300s 会付一次缓存 miss，
建议要么 <270s（缓存还热）、要么 ≥1200s（一次 miss 换更久等待），避开 300s 附近。`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(scheduleWakeupSchema()) as Record<string, unknown>;
  }

  async execute(input: unknown): Promise<ToolResult> {
    const params = input as {
      delay_seconds?: number;
      prompt?: string;
      reason?: string;
    };

    if (typeof params.delay_seconds !== "number" || !params.prompt) {
      return {
        output: "错误: 缺少必需参数 (delay_seconds, prompt)",
        isError: true,
      };
    }

    if (Number.isNaN(params.delay_seconds) || !Number.isFinite(params.delay_seconds)) {
      return { output: "错误: delay_seconds 必须是有限数字", isError: true };
    }

    // 钳制延迟到 [60, 3600]
    const clamped = Math.min(MAX_DELAY_S, Math.max(MIN_DELAY_S, Math.round(params.delay_seconds)));

    const now = Date.now();
    const task: CronTask = {
      id: shortId(),
      cron: "", // 相对延迟唤醒不使用 cron 表达式
      prompt: params.prompt,
      createdAt: now,
      recurring: false, // 一次性
      durable: false, // 会话级（动态轮询绑定当前会话）
      fireAt: now + clamped * 1000,
    };

    getScheduler().addSessionTask(task);

    const clampNote =
      clamped !== Math.round(params.delay_seconds)
        ? `（已从 ${Math.round(params.delay_seconds)}s 钳制到 ${clamped}s）`
        : "";
    const reasonNote = params.reason ? `\n理由: ${params.reason}` : "";
    return {
      output: `已安排 ${clamped}s 后唤醒一次${clampNote}，ID: ${task.id}${reasonNote}`,
    };
  }
}
