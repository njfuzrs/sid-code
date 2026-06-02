/**
 * Session Memory 压缩集成（Task 5）
 *
 * autoCompact 触发时优先尝试用 Session Memory 压缩：
 * - 等待进行中的提取完成（最多 15s）
 * - 读取 .session_memory.md
 * - 内容为空 → 返回 null，回退传统 LLM 摘要压缩
 * - 有内容 → 按 section 截断后作为摘要返回
 *
 * 返回的 summary 字符串交给 ContextManager.compactWithSummary 完成实际压缩，
 * 复用已有的安全分割点 + Skill 上下文保留逻辑，避免重复实现。
 */

import { getLogger } from "../debug/logger.ts";
import { isSessionMemoryEmpty, truncateSessionMemory } from "./utils.ts";

/** Session Memory 压缩配置 */
export interface SessionMemoryCompactConfig {
  /** Session Memory 截断后的最大 tokens */
  maxSummaryTokens: number;
  /** 每个 section 最大 tokens */
  perSectionTokens: number;
  /** 等待提取完成的超时（毫秒） */
  waitTimeoutMs: number;
}

export const DEFAULT_SM_COMPACT_CONFIG: SessionMemoryCompactConfig = {
  maxSummaryTokens: 12_000,
  perSectionTokens: 2_000,
  waitTimeoutMs: 15_000,
};

/** Session Memory 压缩结果 */
export interface SessionMemoryCompactionResult {
  /** 用于 compactWithSummary 的摘要文本 */
  summary: string;
  /** 摘要来源（用于日志） */
  source: "session-memory";
}

/** Session Memory 提供方（解耦，便于测试） */
export interface SessionMemoryProvider {
  getContent: () => Promise<string | null>;
  waitForExtraction: (timeoutMs?: number) => Promise<void>;
}

/**
 * 尝试使用 Session Memory 进行压缩。
 * Session Memory 为空或不可用时返回 null，调用方回退到传统压缩。
 */
export async function trySessionMemoryCompaction(
  sessionMemory: SessionMemoryProvider,
  config: SessionMemoryCompactConfig = DEFAULT_SM_COMPACT_CONFIG,
): Promise<SessionMemoryCompactionResult | null> {
  const log = getLogger();

  // 1. 等待进行中的提取完成（超时不阻塞）
  try {
    await sessionMemory.waitForExtraction(config.waitTimeoutMs);
  } catch {
    // 超时或出错，继续使用当前内容
  }

  // 2. 读取内容
  let content: string | null;
  try {
    content = await sessionMemory.getContent();
  } catch (err: any) {
    log.debug("SESSION_MEM", `读取 Session Memory 失败，回退传统压缩: ${err.message}`);
    return null;
  }

  // 3. 空内容 → 回退
  if (isSessionMemoryEmpty(content)) {
    log.debug("SESSION_MEM", "Session Memory 为空，回退传统压缩");
    return null;
  }

  // 4. 按 section 截断
  const truncated = truncateSessionMemory(content!, config.maxSummaryTokens, config.perSectionTokens);
  if (!truncated.trim()) {
    return null;
  }

  log.info("SESSION_MEM", "使用 Session Memory 进行压缩");
  return {
    summary: `以下是本次会话的结构化笔记（Session Memory），包含任务目标、进展、关键文件与学到的经验：\n\n${truncated}`,
    source: "session-memory",
  };
}
