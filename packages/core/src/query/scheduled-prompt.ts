/**
 * 定时任务注入 prompt 的来源标记（单一事实源）
 *
 * ## 为什么需要
 *
 * 定时唤醒（`schedule_wakeup` / `/loop` / `cron_create`）到点后，宿主把任务里存的 prompt
 * 当作一次用户输入喂给主循环。改动前这条消息在三个地方都与「人手敲的」无法区分：
 *
 * 1. **喂给模型的文本**——裸 prompt，模型只能在 thinking 里猜「这大概是唤醒 prompt」。
 *    2026-11-07 会话 `20261107-095213-ff96d1f2` 里模型猜了 4 次，每次还都重跑了一遍
 *    完整检查命令（`gh pr view` + `gh api`），明明目标早已达成。
 * 2. **TUI**——渲染成 `> …` 普通用户消息，用户看到「没人说话，agent 自己开始干活」。
 * 3. **轨迹**——只有一条 `UserPromptSubmit`，与人手敲的不可区分。
 *
 * 修法：结构化标记（`_meta.origin = "scheduled-prompt"`）走各层分流，文本来源头只服务
 * 第一条（模型可见）。**不靠文本前缀做任何判定**——那正是 `internal-message.ts` 文件头
 * 记过的教训：文案微调一次就失配。
 *
 * ## 语言
 *
 * 跟随提示词语言偏好（`LanguagePref`）：`en` 出英文，其余（含 `auto` / 缺省）出中文，
 * 与 `system-prompt.ts` 里 `language === "en" ? … : …` 的既有判定一致。
 */

import type { LanguagePref } from "../config/prompt-lang.ts";

/** 注入消息的消息来源标记（写进 `_meta.origin`） */
export const SCHEDULED_PROMPT_ORIGIN = "scheduled-prompt";

/** 定时任务的来源闭集（与 `CronTask["origin"]` 对齐，缺省记 unknown） */
export type ScheduledPromptTaskOrigin = "loop" | "cron_create" | "schedule_wakeup" | "unknown";

/** 一条定时注入的身份信息（宿主 → 引擎传参、TUI 渲染、埋点三处共用） */
export interface ScheduledPromptSource {
  /** 触发它的定时任务 id */
  taskId: string;
  /** 任务来源（决定渲染标签与文案措辞） */
  origin: ScheduledPromptTaskOrigin;
}

/** 把 `CronTask["origin"]`（可能是 undefined 的老任务）归一成闭集 */
export function normalizeScheduledOrigin(origin: string | undefined): ScheduledPromptTaskOrigin {
  if (origin === "loop" || origin === "cron_create" || origin === "schedule_wakeup") return origin;
  return "unknown";
}

/** 来源的中文/英文标签（TUI 与来源头共用，避免两处各写一套措辞） */
export function describeScheduledOrigin(
  origin: ScheduledPromptTaskOrigin,
  language: LanguagePref | undefined,
): string {
  const isEn = language === "en";
  switch (origin) {
    case "schedule_wakeup":
      return isEn ? "Scheduled wakeup" : "定时唤醒";
    case "loop":
      return isEn ? "/loop task" : "/loop 定时任务";
    case "cron_create":
      return isEn ? "cron_create task" : "cron_create 定时任务";
    default:
      return isEn ? "Scheduled task" : "定时任务";
  }
}

/**
 * 拼一行来源头，作为喂给模型的文本的**第一行**（与 prompt 同属一个 text block）。
 *
 * 不另起 block 的原因：独立 block 要靠 `<system-reminder>` 前缀才能被 history-adapter
 * 隐藏，而那套前缀规则与 hook 注入的 reminder 共用，混进来会让「哪些块该隐藏」变得不可推导。
 *
 * 这一行是给模型看的：它必须能确定「这条是此前我自己安排的唤醒，不是用户新说话」，
 * 才能在目标已达成时直接短答收尾，而不是重跑一遍检查。**它不是安全边界**，模型照旧
 * 可以忽略；真正的行为约束在工具与调度器的机制层（单链替换、注入前判过期）。
 */
export function formatScheduledPromptHeader(
  source: ScheduledPromptSource,
  language: LanguagePref | undefined,
): string {
  const label = describeScheduledOrigin(source.origin, language);
  const isEn = language === "en";
  if (isEn) {
    return `[${label} · ${source.origin} · ID ${source.taskId} · scheduled by you earlier, not a new user message]`;
  }
  return `[${label} · ${source.origin} · ID ${source.taskId} · 由你此前安排，不是用户新输入的消息]`;
}

/**
 * 把来源头拼到 prompt 前面（幂等判据：只拼一次，由调用方保证每轮只调一次）。
 *
 * 用 `\n` 而不是空行：来源头与 prompt 是一个语义单元，空行会让模型把它读成两段独立指令。
 */
export function withScheduledPromptHeader(
  prompt: string,
  source: ScheduledPromptSource,
  language: LanguagePref | undefined,
): string {
  return `${formatScheduledPromptHeader(source, language)}\n${prompt}`;
}

/**
 * 从落盘的 prompt 正文里剥掉来源头，取回原始 prompt。
 *
 * 为什么需要：`_meta` 会随消息落盘，TUI 重建历史（含 `resume`）时拿到的是**已拼过头**
 * 的正文。要展示「原始 prompt 首行」，得把头去掉——而头是按当前语言生成的，所以中英两种
 * 都试一遍。**这是确定性字符串匹配（头是同一函数产出的），不是按前缀猜来源**：
 * 猜来源那种脆弱判据是本模块存在的理由（见文件头）。不匹配就原样返回，不报错。
 */
export function stripScheduledPromptHeader(text: string, source: ScheduledPromptSource): string {
  for (const language of ["zh", "en"] as const) {
    const header = formatScheduledPromptHeader(source, language);
    if (text === header) return "";
    if (text.startsWith(`${header}\n`)) return text.slice(header.length + 1);
  }
  return text;
}

/**
 * 生成 user 消息的 `_meta`（engine 与测试共用，避免字面量散落两处漂移）。
 *
 * 只带结构化字段：`origin` 让各层分流，`scheduledTaskId` / `scheduledOrigin` 供 TUI
 * 渲染任务 id 与来源标签。**不带 prompt 原文**——正文已经在 content 里。
 */
export function buildScheduledMessageMeta(source: ScheduledPromptSource): {
  origin: typeof SCHEDULED_PROMPT_ORIGIN;
  scheduledTaskId: string;
  scheduledOrigin: ScheduledPromptTaskOrigin;
} {
  return {
    origin: SCHEDULED_PROMPT_ORIGIN,
    scheduledTaskId: source.taskId,
    scheduledOrigin: source.origin,
  };
}

/**
 * 生成 `UserPromptSubmit` hook 载荷的来源字段（`event-handler.ts` 与测试共用）。
 *
 * 定时任务注入也是「一条喂给模型的 prompt」，所以**照常触发 hook**（用户的 hook 可能
 * 靠它做审计/注入），只是载荷多了来源字段。字段名用 snake_case 与既有 hook 载荷一致
 * （`tool_name` / `duration_ms` 都是这个风格）。
 */
export function toHookSourceFields(source: ScheduledPromptSource): {
  source: "scheduled";
  scheduled_task_id: string;
  scheduled_origin: ScheduledPromptTaskOrigin;
} {
  return {
    source: "scheduled",
    scheduled_task_id: source.taskId,
    scheduled_origin: source.origin,
  };
}
