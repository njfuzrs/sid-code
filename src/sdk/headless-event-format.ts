/**
 * 无头模式（text/json 输出）事件格式化 —— 纯函数，便于单测。
 *
 * 背景（审计报告 静默-2/-3/-7）：交互式 TUI 早已把 system 的 error/info、以及
 * tombstone/hook_blocked/max_turns/loop_detected 等事件渲染出来，但 app.ts 的
 * runHeadless 此前只认 system/warning，其余全被静默丢弃——用户在非交互模式下
 * 看到的是"输出戛然而止""什么都没发生"，正是事故里"感知到中断却无准确错误信息"
 * 的 headless 形态。
 *
 * 同时 fallback 重试进度经 stream-processor 的 `onText("[重试中] …")` 回调下发，
 * headless 若裸拼进 streamBuffer 会污染最终答案（静默-3）。
 *
 * 这里把"事件 → 输出目标"的映射与"流式文本是否为重试进度"的判定收敛为纯函数，
 * app.ts 只负责把结果写到 process.stderr / streamBuffer。
 */

import type { QueryEngineEvent } from "../query/types.ts";

/** stream-processor 下发的重试进度文案前缀（与 TUI 回调、stream-processor 保持一致） */
export const RETRY_TEXT_PREFIX = "[重试中] ";

/**
 * 判定并剥离流式文本中的重试进度文案。
 *
 * @returns 若为重试进度，返回 `{ isRetryProgress: true, stderr }`（应写 stderr，不入正文）；
 *          否则返回 `{ isRetryProgress: false }`（调用方将原文本拼入 streamBuffer）。
 */
export function classifyHeadlessStreamText(
  text: string,
): { isRetryProgress: true; stderr: string } | { isRetryProgress: false } {
  if (text.startsWith(RETRY_TEXT_PREFIX)) {
    return {
      isRetryProgress: true,
      stderr: `⟳ ${text.slice(RETRY_TEXT_PREFIX.length)}`,
    };
  }
  return { isRetryProgress: false };
}

/** 事件格式化结果：写 stderr 的进度/状态行，及（可选）拼入正文兜底的文本。 */
export interface HeadlessEventOutput {
  /** 进度/状态提示，写 stderr（不污染 stdout 的最终答案） */
  stderr?: string;
  /** 需拼入 streamBuffer 的正文兜底文本（仅 error 级用，保证纯文本/JSON 消费者可见） */
  appendToBuffer?: string;
}

/**
 * 把一个 QueryEngineEvent 映射为 headless 输出。
 *
 * 注意：done / fatal_error 由 runHeadless 主循环单独处理（break + runError），
 * 不走此函数。此函数只负责"进度/状态类"事件的可见化。
 *
 * @returns null 表示该事件在 headless 下无需产出（如 assistant_message 由 streamBuffer 承载）。
 */
export function formatHeadlessEvent(
  event: QueryEngineEvent,
): HeadlessEventOutput | null {
  switch (event.kind) {
    case "system":
      if (event.level === "warning") {
        return { stderr: `⚠️  ${event.text}` };
      }
      if (event.level === "error") {
        // 超时重试耗尽等用户可见错误：stderr 醒目提示，且拼入正文兜底
        // （避免 JSON/纯文本消费者完全看不到"为什么停了"）。
        return { stderr: `❌ ${event.text}`, appendToBuffer: `\n[error] ${event.text}\n` };
      }
      // info：预算耗尽 / 压缩进度 / 续写上限 / 上下文窗口 / 门禁 / 产出停滞
      return { stderr: `ℹ️  ${event.text}` };

    case "tombstone":
      return { stderr: `↩️  模型降级，正在使用备用模型重试...` };

    case "hook_blocked":
      // 非交互下用户输入被 hook 拦截，否则表现为"什么都没发生"直接结束。
      return { stderr: `⛔ Hook 阻止执行: ${event.reason}` };

    case "max_turns":
      return { stderr: `⚠️  达到最大轮次限制: ${event.maxTurns}` };

    case "loop_detected":
      return { stderr: `⚠️  检测到循环模式: ${event.detail}` };

    case "loop_recovery":
      return { stderr: `🔄 循环恢复尝试 ${event.attempt}/${event.maxAttempts}` };

    case "context_warning":
      return { stderr: `⚠️  上下文剩余 ${event.remaining.toFixed(0)}%，即将自动压缩` };

    default:
      return null;
  }
}
