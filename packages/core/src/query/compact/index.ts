/**
 * 渐进式压缩管道入口
 *
 * 按成本从低到高依次尝试：
 * ① applyToolResultBudget — 超大工具结果替换为占位符
 * ② snipCompact — 裁剪最早的消息
 * ③ microcompactMessages — 清理旧工具结果内容
 * ④ autoCompact — 调用模型生成摘要（最后手段）
 */

import type { Message } from "../../llm/types.ts";
import type { Manager as ContextManager } from "../../context/manager.ts";
import { applyToolResultBudget } from "./tool-result-budget.ts";
import { snipCompact } from "./snip-compact.ts";
import { microcompactMessages } from "./microcompact.ts";
import { getLogger } from "../../debug/index.ts";
import { estimateConversationTokens } from "../../context/token.ts";

/** 压缩管道结果 */
export interface CompactPipelineResult {
  /** 压缩后的消息 */
  messages: Message[];
  /** 执行了哪些压缩步骤 */
  steps: string[];
  /** 总共节省的字符数 */
  totalSavedChars: number;
  /** 是否需要继续执行 autoCompact（LLM 摘要） */
  needsAutoCompact: boolean;
}

/** 压缩管道配置 */
export interface CompactPipelineOptions {
  /**
   * 目标 token 使用率（低于此值则停止压缩）。
   * P1-7：调用方应从 getCompactionThresholds().compactionTriggerUsed / maxTokens 派生，
   * 不要写死 0.7——hard 档在 1M 窗口约 82% 才进场，管线再压到 70% 会多丢一截历史。
   */
  targetUsageRatio?: number;
  /** 当前 token 使用率 */
  currentUsageRatio: number;
  /** 上下文窗口最大 token 数 */
  maxTokens: number;
  /** 工具数量（用于 token 估算） */
  toolCount: number;
  /**
   * P1-6：与 getCompactionLevel 同源的估算器。传入后管线逐步替换消息时走校准尺子，
   * 不再用 chars/4。未传则退化为 estimateConversationTokens（仍含 thinking / CJK）。
   */
  estimateTokens?: (messages: Message[]) => number;
}

/**
 * 执行渐进式压缩管道
 * 按成本从低到高依次尝试，直到 token 使用率降到目标以下
 */
export function runCompactPipeline(
  messages: Message[],
  options: CompactPipelineOptions,
): CompactPipelineResult {
  const log = getLogger();
  const targetRatio = options.targetUsageRatio ?? 0.7;
  const steps: string[] = [];
  let totalSavedChars = 0;
  let currentMessages = messages;
  let currentRatio = options.currentUsageRatio;
  const estimate = (msgs: Message[]): number =>
    options.estimateTokens
      ? options.estimateTokens(msgs)
      : estimateConversationTokens(msgs, { toolCount: options.toolCount });
  const ratioOf = (msgs: Message[]): number =>
    options.maxTokens > 0 ? estimate(msgs) / options.maxTokens : currentRatio;

  log.info(
    "COMPACT_PIPELINE",
    `开始渐进式压缩，当前使用率 ${(currentRatio * 100).toFixed(0)}%，目标 ${(targetRatio * 100).toFixed(0)}%`,
  );

  // 如果已经低于目标，不需要压缩
  if (currentRatio <= targetRatio) {
    return { messages: currentMessages, steps, totalSavedChars, needsAutoCompact: false };
  }

  // ① applyToolResultBudget — 超大工具结果替换为占位符
  const budgetResult = applyToolResultBudget(currentMessages);
  if (budgetResult.truncatedCount > 0) {
    currentMessages = budgetResult.messages;
    totalSavedChars += budgetResult.savedChars;
    steps.push(
      `toolResultBudget: 截断 ${budgetResult.truncatedCount} 个，节省 ${budgetResult.savedChars} 字符`,
    );
    currentRatio = ratioOf(currentMessages);
    if (currentRatio <= targetRatio) {
      log.info(
        "COMPACT_PIPELINE",
        `toolResultBudget 后使用率 ${(currentRatio * 100).toFixed(0)}%，已达目标`,
      );
      return { messages: currentMessages, steps, totalSavedChars, needsAutoCompact: false };
    }
  }

  // ② snipCompact — 裁剪最早的消息
  const snipResult = snipCompact(currentMessages);
  if (snipResult.success) {
    currentMessages = snipResult.messages;
    steps.push(`snipCompact: 裁剪 ${snipResult.snippedCount} 条消息`);
    currentRatio = ratioOf(currentMessages);
    if (currentRatio <= targetRatio) {
      log.info(
        "COMPACT_PIPELINE",
        `snipCompact 后使用率 ${(currentRatio * 100).toFixed(0)}%，已达目标`,
      );
      return { messages: currentMessages, steps, totalSavedChars, needsAutoCompact: false };
    }
  }

  // ③ microcompactMessages — 清理旧工具结果内容
  const microResult = microcompactMessages(currentMessages);
  if (microResult.compactedCount > 0) {
    currentMessages = microResult.messages;
    totalSavedChars += microResult.savedChars;
    steps.push(
      `microcompact: 压缩 ${microResult.compactedCount} 个，节省 ${microResult.savedChars} 字符`,
    );
    currentRatio = ratioOf(currentMessages);
    if (currentRatio <= targetRatio) {
      log.info(
        "COMPACT_PIPELINE",
        `microcompact 后使用率 ${(currentRatio * 100).toFixed(0)}%，已达目标`,
      );
      return { messages: currentMessages, steps, totalSavedChars, needsAutoCompact: false };
    }
  }

  // ④ 仍然超标 → 需要 autoCompact（LLM 摘要）
  log.info(
    "COMPACT_PIPELINE",
    `轻量压缩后使用率仍为 ${(currentRatio * 100).toFixed(0)}%，需要 autoCompact`,
  );
  return { messages: currentMessages, steps, totalSavedChars, needsAutoCompact: true };
}

/**
 * P1-7：从 Manager 的单一事实源派生管线达标比例。
 * hard 档触发点是 compactionTriggerUsed，不是历史默认 0.7。
 */
export function pipelineTargetRatioFrom(ctxMgr: ContextManager): number {
  const maxTokens = ctxMgr.getMaxTokens();
  if (maxTokens <= 0) return 0.7;
  const trigger = ctxMgr.getCompactionThresholds().compactionTriggerUsed;
  return Math.min(0.95, Math.max(0.3, trigger / maxTokens));
}

// 导出子模块
export { microcompactMessages } from "./microcompact.ts";
export { snipCompact } from "./snip-compact.ts";
export { applyToolResultBudget, applyToolResultBudgetToContent } from "./tool-result-budget.ts";
// G22：部分压缩（compact-up-to）——新增能力，可显式调用
export {
  partialCompact,
  resolvePartialSplitIndex,
  PARTIAL_COMPACT_PREFIX,
  type PartialCompactOptions,
  type PartialCompactResult,
} from "./partial-compact.ts";
