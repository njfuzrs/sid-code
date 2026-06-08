/**
 * 上下文层自动压缩协调器
 *
 * 与 src/query/auto-compact.ts 的关系：
 * - 现有 query/auto-compact.ts：负责 LLM 摘要压缩的具体实现
 * - 本模块：负责阈值判断 + 策略编排 + Token 减量追踪 + 递归防护
 *
 * 四层阈值体系（对标 claude-code autoCompact.ts:62-65）：
 * - autoCompact(13K)：剩余 ≤ 13K tokens → 触发自动压缩
 * - warning(20K)：剩余 ≤ 20K tokens → 警告
 * - error(20K)：剩余 ≤ 20K tokens → 错误
 * - blocking(3K)：剩余 ≤ 3K tokens → 阻塞（强制截断，不调用 LLM）
 */

import type { Message } from "../llm/types.ts";
import type { Manager as ContextManager } from "./manager.ts";
import { microCompactDiscardable } from "./micro-compact.ts";
import { getLogger } from "../debug/index.ts";

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

// ─── 递归防护 ───

/** 递归防护标志（全局，跨调用共享） */
let isCompactingFlag = false;

/**
 * 检查是否正在执行压缩操作（防递归）
 */
export function isCompacting(): boolean {
  return isCompactingFlag;
}

/**
 * 检查消息是否为压缩来源（session_memory / compact），
 * 压缩来源的消息不应再次触发压缩。
 */
export function isCompactSourceMessage(msg: Message): boolean {
  if (!msg._meta) return false;

  const source = msg._meta.compact_source as string | undefined;
  return source === "session_memory" || source === "compact";
}

// ─── 自动压缩协调器 ───

/** 自动压缩依赖 */
export interface AutoCompactContextDeps {
  /** 上下文管理器 */
  ctxMgr: ContextManager;
  /** 工具数量（用于 token 估算） */
  toolCount: number;
  /** Session Memory 提供方（如果可用） */
  sessionMemory?: {
    getMemory(): Promise<string | null>;
  };
  /** LLM 摘要回调（委托给现有 autoCompact 实现） */
  llmCompact: () => Promise<void>;
  /** Token 减量追踪器 */
  tokenTracker?: TokenFreedTracker;
}

/** 自动压缩结果 */
export interface AutoCompactContextResult {
  /** 是否执行了压缩 */
  compacted: boolean;
  /** 压缩级别 */
  level: AutoCompactLevel | null;
  /** 使用的策略列表 */
  strategies: string[];
  /** 压缩前消息数 */
  messageCountBefore: number;
  /** 压缩后消息数 */
  messageCountAfter: number;
  /** 估算释放的 token 数 */
  tokenEstimateFreed: number;
}

/**
 * 自动压缩协调器
 *
 * 策略优先级链：
 * 1. trySessionMemoryCompact → 优先用结构化会话笔记
 * 2. microCompactDiscardable → 压缩可丢弃工具输出
 * 3. LLM 摘要兜底 → 调用现有 autoCompact
 *
 * @param deps 依赖注入
 * @returns 压缩结果
 */
export async function detectAndCompact(
  deps: AutoCompactContextDeps,
): Promise<AutoCompactContextResult> {
  const log = getLogger();
  const { ctxMgr, toolCount } = deps;

  const strategies: string[] = [];
  const messageCountBefore = ctxMgr.messageCount();
  let tokenEstimateFreed = 0;

  // 检查压缩级别
  const used = ctxMgr.estimateTokens(toolCount);
  const remaining = ctxMgr.getMaxTokens() - used;
  const level = getAutoCompactLevel(remaining);

  if (!level) {
    return { compacted: false, level: null, strategies, messageCountBefore, messageCountAfter: messageCountBefore, tokenEstimateFreed: 0 };
  }

  log.info("AUTO_COMPACT", `触发自动压缩: 级别=${level}, 剩余=${remaining}tokens, 使用=${used}tokens`);

  // ═══ blocking 级别：强制截断 ═══
  if (level === "blocking") {
    strategies.push("emergencyTruncate");
    ctxMgr.emergencyTruncate();
    tokenEstimateFreed = Math.ceil(remaining * 0.5); // 粗略估算

    if (deps.tokenTracker) {
      deps.tokenTracker.recordCompact(tokenEstimateFreed, "emergencyTruncate");
    }

    return {
      compacted: true,
      level,
      strategies,
      messageCountBefore,
      messageCountAfter: ctxMgr.messageCount(),
      tokenEstimateFreed,
    };
  }

  // ═══ 递归防护检查 ═══
  if (isCompactingFlag) {
    log.warn("AUTO_COMPACT", "检测到递归压缩，跳过");
    return { compacted: false, level, strategies, messageCountBefore, messageCountAfter: messageCountBefore, tokenEstimateFreed: 0 };
  }

  try {
    isCompactingFlag = true;

    // ═══ 策略 1：Session Memory 压缩 ═══
    if (deps.sessionMemory) {
      try {
        const memory = await deps.sessionMemory.getMemory();
        if (memory && memory.trim()) {
          strategies.push("sessionMemory");
          const summaryMsg = `[会话记忆压缩]\n以下是之前对话的结构化总结：\n\n${memory}`;
          ctxMgr.compactWithSummary(summaryMsg);
          const after = ctxMgr.messageCount();

          if (deps.tokenTracker) {
            deps.tokenTracker.recordCompact(messageCountBefore - after, "sessionMemory");
          }

          log.info("AUTO_COMPACT", `Session Memory 压缩完成: ${messageCountBefore} → ${after} 条消息`);
          return {
            compacted: true,
            level,
            strategies,
            messageCountBefore,
            messageCountAfter: after,
            tokenEstimateFreed: messageCountBefore - after,
          };
        }
      } catch (err: any) {
        log.debug("AUTO_COMPACT", `Session Memory 压缩异常: ${err.message}，回退到后续策略`);
      }
    }

    // ═══ 策略 2：microCompact（工具类型感知）═══
    const messages = ctxMgr.getMessages();
    const microResult = microCompactDiscardable(messages, { preserveRecentCount: 6 });
    if (microResult.compactedCount > 0) {
      strategies.push("microCompact");
      ctxMgr.setMessages(microResult.messages);
      tokenEstimateFreed = microResult.tokenEstimateFreed;

      if (deps.tokenTracker) {
        deps.tokenTracker.recordCompact(tokenEstimateFreed, "microCompact");
      }

      // 检查 microCompact 后是否仍然超标
      const afterUsed = ctxMgr.estimateTokens(toolCount);
      const afterRemaining = ctxMgr.getMaxTokens() - afterUsed;
      if (afterRemaining > TOKEN_THRESHOLDS.autoCompact) {
        // microCompact 已达到目标
        log.info("AUTO_COMPACT", `microCompact 完成: 释放 ${tokenEstimateFreed} tokens，已达安全范围`);
        return {
          compacted: true,
          level,
          strategies,
          messageCountBefore,
          messageCountAfter: ctxMgr.messageCount(),
          tokenEstimateFreed,
        };
      }
    }

    // ═══ 策略 3：LLM 摘要兜底 ═══
    strategies.push("llmSummary");
    await deps.llmCompact();

    if (deps.tokenTracker) {
      const finalMsgCount = ctxMgr.messageCount();
      // 粗略估算：每个被压缩的 user message 平均 2000 tokens
      const estimatedFreed = (messageCountBefore - finalMsgCount) * 2000;
      deps.tokenTracker.recordCompact(Math.max(0, estimatedFreed), "llmSummary");
    }

    log.info("AUTO_COMPACT", `LLM 摘要压缩完成: ${messageCountBefore} → ${ctxMgr.messageCount()} 条消息`);
    return {
      compacted: true,
      level,
      strategies,
      messageCountBefore,
      messageCountAfter: ctxMgr.messageCount(),
      tokenEstimateFreed: messageCountBefore - ctxMgr.messageCount(),
    };
  } catch (err: any) {
    log.warn("AUTO_COMPACT", `压缩异常: ${err.message}`);
    return {
      compacted: false,
      level,
      strategies,
      messageCountBefore,
      messageCountAfter: ctxMgr.messageCount(),
      tokenEstimateFreed: 0,
    };
  } finally {
    isCompactingFlag = false;
  }
}
