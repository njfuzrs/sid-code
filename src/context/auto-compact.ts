/**
 * 上下文层压缩阈值与诊断工具
 *
 * 提供四层阈值体系、压缩级别判断、Token 减量追踪和压缩来源标记。
 * 实际的压缩执行由 query/loop.ts（runCompactPipeline）和 query/auto-compact.ts
 * （LLM 摘要）负责，本模块只提供它们共享的阈值常量与诊断辅助。
 *
 * 四层阈值体系（对标 claude-code autoCompact.ts:62-65）：
 * - autoCompact(13K)：剩余 ≤ 13K tokens → 触发自动压缩
 * - warning(20K)：剩余 ≤ 20K tokens → 警告
 * - error(20K)：剩余 ≤ 20K tokens → 错误
 * - blocking(3K)：剩余 ≤ 3K tokens → 阻塞（强制截断，不调用 LLM）
 */

import type { Message } from "../llm/types.ts";

// ─── 四层阈值 ───

/** 对标 claude-code autoCompact.ts:62-65 的四层阈值（剩余 token 数） */
export const TOKEN_THRESHOLDS = {
  /** 剩余 ≤ 13K → 触发自动压缩 */
  autoCompact: 13_000,
  /** 剩余 ≤ 20K → 警告 */
  warning: 20_000,
  /** 剩余 ≤ 20K → 错误级 */
  error: 20_000,
  /** 剩余 ≤ 3K → 阻塞（强制截断，不调用 LLM） */
  blocking: 3_000,
} as const;

/** 压缩级别（按严重程度递增） */
export type AutoCompactLevel = "autoCompact" | "warning" | "error" | "blocking";

/**
 * 根据剩余 token 数判断当前压缩级别
 *
 * @param remainingTokens 上下文窗口剩余 token 数
 * @returns 压缩级别
 */
export function getAutoCompactLevel(remainingTokens: number): AutoCompactLevel | null {
  if (remainingTokens <= TOKEN_THRESHOLDS.blocking) return "blocking";
  if (remainingTokens <= TOKEN_THRESHOLDS.autoCompact) return "autoCompact";
  if (remainingTokens <= TOKEN_THRESHOLDS.warning) return "warning";
  return null;
}

// ─── Token 减量追踪 ───

/**
 * Token 减量追踪器
 *
 * 记录每次压缩策略释放的 token 数，用于统计和诊断。
 */
export class TokenFreedTracker {
  private totalFreed = 0;
  private records: Array<{ strategy: string; tokensFreed: number; timestamp: number }> = [];

  /**
   * 记录一次压缩释放的 token 数
   *
   * @param tokensFreed 释放的 token 数
   * @param strategy 使用的压缩策略（如 "microCompact", "sessionMemory", "llmSummary"）
   */
  recordCompact(tokensFreed: number, strategy: string): void {
    if (tokensFreed <= 0) return;
    this.totalFreed += tokensFreed;
    this.records.push({
      strategy,
      tokensFreed,
      timestamp: Date.now(),
    });
  }

  /** 获取总计释放的 token 数 */
  getTotalFreed(): number {
    return this.totalFreed;
  }

  /** 获取压缩记录 */
  getRecords(): ReadonlyArray<{ strategy: string; tokensFreed: number; timestamp: number }> {
    return this.records;
  }

  /** 重置追踪器 */
  reset(): void {
    this.totalFreed = 0;
    this.records = [];
  }
}

// ─── 压缩来源标记 ───

/**
 * 检查消息是否为压缩来源（session_memory / compact），
 * 压缩来源的消息不应再次触发压缩。
 */
export function isCompactSourceMessage(msg: Message): boolean {
  if (!msg._meta) return false;

  const source = msg._meta.compact_source as string | undefined;
  return source === "session_memory" || source === "compact";
}
