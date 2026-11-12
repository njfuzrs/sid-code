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
import { type CronTask, MAX_SESSION_CRON_JOBS, isCronDisabled } from "../cron/types.ts";
import { registerWait, releaseWait } from "../task/wait-registry.ts";
import { extractWaitSubjectsFor } from "../task/wait-subjects.ts";
import { decideWaitAdmission, formatDuplicateWaitReceipt } from "../task/wait-admission.ts";
import { randomBytes } from "crypto";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

function shortId(): string {
  return randomBytes(4).toString("hex");
}

/** 唤醒描述：prompt 首行截断（进 TUI 面板与等待源 reminder，全文没意义） */
function firstLine(text: string, maxLen: number): string {
  const line = text.split("\n")[0]!.trim();
  return line.length > maxLen ? `${line.slice(0, maxLen)}…` : line;
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
  readonly guidance =
    "要等一段不确定的时长后回来再看（自适应轮询）时用：每轮检查后自选下次延迟；一次性的固定提醒用 cron_create。";
  readonly searchHint =
    "schedule wakeup poll delay dynamic interval 唤醒 轮询 延迟 自定步 等待 稍后";

  name(): string {
    return "schedule_wakeup";
  }

  description(): string {
    return `安排在 N 秒后唤醒一次并执行 prompt（动态自定步，一次性）。

  等 CI / PR / 构建这类**外部状态**请优先用 monitor：它按行推送事件，状态一变就通知，
  不需要自己猜间隔，也不会漏掉中间过程。本工具用于「到某个时间点再做一件事」，
  或没有可流式观测的对象（例如等一个没有输出的窗口过去）。

  - delay_seconds 会被钳制到 [60, 3600]（1 分钟 ~ 1 小时）。
  - 触发一次后自动删除；要继续轮询请在唤醒后再次调用。
  - **唤醒只在本轮结束、会话空闲后才会触发**：排完不要留在本轮继续查询——那只会推迟它。
    没有别的事就告诉用户你在等什么，然后结束本轮。
  - **本会话同时只保留一个待触发的唤醒，再次调用会替换前一个**（不会叠加）。
  因此不需要手动 cron_delete 上一次的唤醒。
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
      // G3：来源进 ScheduledFire 事件，与 /loop、cron_create 区分开
      origin: "schedule_wakeup",
    };

    if (isCronDisabled()) {
      return {
        output: "cron 已被 SID_CODE_DISABLE_CRON 禁用，无法安排唤醒。",
        isError: true,
      };
    }

    // R2：同一个对象同时只允许一个有效的显式等待，且跨类（唤醒 × shell × monitor）。
    // 判定必须放在 `replaceSessionTasksByOrigin` **之前**——先排上再判「重复」的话，
    // 调度器里那条旧唤醒已经被删了，「保留旧的」就无从谈起（静默丢等待）。
    const extraction = extractWaitSubjectsFor({ prompt: params.prompt });
    const admission = decideWaitAdmission({
      subjects: extraction.subjects,
      command: extraction.normalizedCommand,
      deadlineAt: now + clamped * 1000,
    });
    if (admission.action === "duplicate") {
      return {
        output: formatDuplicateWaitReceipt(admission.existing, extraction.subjects),
        isError: false,
      };
    }

    // 与 cron_create / /loop 共用会话级上限（守卫在 scheduler.addSessionTask）。
    // 单链语义：同一会话同时只保留一个待触发的唤醒，新的替换旧的。并存多个唤醒
    // 没有合法用途，只会在会话空闲后连环触发（2026-11-07 实测一轮 5 次调用 → 4 轮空跑）。
    const { ok, replaced } = getScheduler().replaceSessionTasksByOrigin(task);
    if (!ok) {
      return {
        output: `已达定时任务上限 (${MAX_SESSION_CRON_JOBS})，请先用 cron_delete 删除不需要的任务`,
        isError: true,
      };
    }

    // W3：唤醒登记为等待源（有回报承诺的 deadline 源）。
    // 被替换的旧唤醒同步释放——它已经不会再叫醒任何人，继续留在登记表里会让 todo 闸门
    // 为一个不存在的中断放行（F2 的另一半：调度器删了任务，登记表也必须知道）。
    for (const oldId of replaced) releaseWait(oldId, "superseded");
    registerWait({
      id: task.id,
      kind: "wakeup",
      promise: { kind: "deadline", deadlineAt: task.fireAt! },
      description: firstLine(params.prompt, 60),
      registeredAt: now,
      subjects: extraction.subjects.length > 0 ? extraction.subjects : undefined,
      // R2：登记命令与对象签名，下一个等待来判准入时要能认出「这是同一件事」
      command: extraction.normalizedCommand,
    });

    const clampNote =
      clamped !== Math.round(params.delay_seconds)
        ? `（已从 ${Math.round(params.delay_seconds)}s 钳制到 ${clamped}s）`
        : "";
    // 告诉模型旧唤醒已经没了：否则它可能去 cron_delete 一个不存在的 id，
    // 或者以为还有一个在排队而重复安排。
    const replacedNote =
      replaced.length > 0 ? `（已替换此前未触发的唤醒 ${replaced.join("、")}）` : "";
    const reasonNote = params.reason ? `\n理由: ${params.reason}` : "";
    // 倒数第二行是「目标达成后剩下的那一个唤醒」的缓解（本期不做自动撤销，见方案 §6.3）：
    // F1 只能把多余唤醒压到最多 1 个，剩下的这一个要靠模型自己撤。
    //
    // 最后一行是 N2：唤醒只在本轮结束、会话空闲后触发（`cli/src/app.ts` 的
    // `enqueueScheduledPrompt`）。返回文案原先只有「已安排」与「用 cron_delete 取消」，
    // 没有一句说这件事——20261109-160803-fbb02831 实测模型两次排完唤醒都在 1.5s 后
    // 继续前台查 CI，第二个唤醒因此晚了 383s 才注入（`ScheduledFire.lag_ms = 383270`）。
    return {
      output:
        `已安排 ${clamped}s 后唤醒一次${clampNote}，ID: ${task.id}${replacedNote}${reasonNote}\n` +
        `目标达成后若不再需要，用 cron_delete ${task.id} 取消。\n` +
        `唤醒只在本轮结束、会话空闲后才会触发；本轮继续查询只会推迟它。没有别的事就告诉用户你在等什么，然后结束本轮。`,
    };
  }
}
