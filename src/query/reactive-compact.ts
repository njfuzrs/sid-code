/**
 * 响应式压缩（Reactive Compact）
 * 当 prompt-too-long 错误发生时，紧急压缩消息历史后重试
 * 与 autoCompact 不同：这是错误恢复路径，不是预防性压缩
 */

import { Manager as ContextManager } from "../context/manager.ts";
import { getLogger } from "../debug/index.ts";

/** 响应式压缩结果 */
export interface ReactiveCompactResult {
  /** 是否成功压缩 */
  success: boolean;
  /** 压缩前消息数 */
  messageCountBefore: number;
  /** 压缩后消息数 */
  messageCountAfter: number;
}

/**
 * 响应式压缩：prompt-too-long 错误触发
 * 策略：
 * 1. 先尝试 snipCompact（裁剪最早的消息）
 * 2. 如果不够，尝试 emergencyTruncate
 * 3. 保留最近 4 条消息（2 轮对话）
 */
export function reactiveCompact(ctxMgr: ContextManager): ReactiveCompactResult {
  const log = getLogger();
  const messageCountBefore = ctxMgr.messageCount();

  if (messageCountBefore <= 4) {
    log.warn("REACTIVE_COMPACT", "消息太少，无法压缩");
    return { success: false, messageCountBefore, messageCountAfter: messageCountBefore };
  }

  // 策略 1：snipCompact — 裁剪最早的消息对（保留最近 60%）
  const keepCount = Math.max(4, Math.ceil(messageCountBefore * 0.6));
  const snipCount = messageCountBefore - keepCount;

  if (snipCount > 0) {
    const summary = `[响应式压缩] 因 prompt-too-long 错误，裁剪了最早的 ${snipCount} 条消息。`;
    ctxMgr.compactWithSummary(summary);
    const messageCountAfter = ctxMgr.messageCount();
    log.info("REACTIVE_COMPACT", `snipCompact: ${messageCountBefore} → ${messageCountAfter} 条消息`);
    return { success: true, messageCountBefore, messageCountAfter };
  }

  // 策略 2：emergencyTruncate
  ctxMgr.emergencyTruncate();
  const messageCountAfter = ctxMgr.messageCount();
  log.info("REACTIVE_COMPACT", `emergencyTruncate: ${messageCountBefore} → ${messageCountAfter} 条消息`);
  return { success: messageCountAfter < messageCountBefore, messageCountBefore, messageCountAfter };
}

/**
 * 检测错误是否为 prompt-too-long
 */
export function isPromptTooLongError(err: any): boolean {
  const msg = (err?.message || String(err)).toLowerCase();
  return (
    msg.includes("prompt is too long") ||
    msg.includes("prompt_too_long") ||
    msg.includes("context length exceeded") ||
    msg.includes("maximum context length") ||
    (msg.includes("token") && msg.includes("exceed"))
  );
}

/**
 * max_tokens 续写的递减收益检测器
 * 连续续写时，如果增量越来越小，说明模型在重复/填充，应该停止
 */
export class DiminishingReturnsDetector {
  /** 每次续写的输出 token 数 */
  private outputTokenHistory: number[] = [];
  /** 最大续写次数 */
  static readonly MAX_RECOVERY_COUNT = 3;
  /** 递减收益阈值（token 数） */
  static readonly DIMINISHING_THRESHOLD = 500;

  /** 记录一次续写的输出 token 数 */
  record(outputTokens: number): void {
    this.outputTokenHistory.push(outputTokens);
  }

  /**
   * 是否应该停止续写
   * 条件：
   * 1. 已达最大续写次数
   * 2. 连续两次增量 < 阈值（递减收益）
   */
  shouldStop(): boolean {
    const history = this.outputTokenHistory;

    // 条件 1：达到最大次数
    if (history.length >= DiminishingReturnsDetector.MAX_RECOVERY_COUNT) {
      return true;
    }

    // 条件 2：连续两次增量 < 阈值
    if (history.length >= 2) {
      const last = history[history.length - 1];
      const prev = history[history.length - 2];
      if (last < DiminishingReturnsDetector.DIMINISHING_THRESHOLD &&
          prev < DiminishingReturnsDetector.DIMINISHING_THRESHOLD) {
        return true;
      }
    }

    return false;
  }

  /** 重置 */
  reset(): void {
    this.outputTokenHistory = [];
  }

  /** 获取续写次数 */
  get count(): number {
    return this.outputTokenHistory.length;
  }
}
