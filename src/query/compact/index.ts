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
import { applyToolResultBudget } from "./tool-result-budget.ts";
import { snipCompact } from "./snip-compact.ts";
import { microcompactMessages } from "./microcompact.ts";
import { getLogger } from "../../debug/index.ts";

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
  /** 目标 token 使用率（低于此值则停止压缩，默认 0.7） */
  targetUsageRatio?: number;
  /** 当前 token 使用率 */
  currentUsageRatio: number;
  /** 上下文窗口最大 token 数 */
  maxTokens: number;
  /** 工具数量（用于 token 估算） */
  toolCount: number;
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

  log.info("COMPACT_PIPELINE", `开始渐进式压缩，当前使用率 ${(currentRatio * 100).toFixed(0)}%，目标 ${(targetRatio * 100).toFixed(0)}%`);

  // 如果已经低于目标，不需要压缩
  if (currentRatio <= targetRatio) {
    return { messages: currentMessages, steps, totalSavedChars, needsAutoCompact: false };
  }

  // ① applyToolResultBudget — 超大工具结果替换为占位符
  const budgetResult = applyToolResultBudget(currentMessages);
  if (budgetResult.truncatedCount > 0) {
    currentMessages = budgetResult.messages;
    totalSavedChars += budgetResult.savedChars;
    steps.push(`toolResultBudget: 截断 ${budgetResult.truncatedCount} 个，节省 ${budgetResult.savedChars} 字符`);
    currentRatio = estimateRatio(currentMessages, options.maxTokens);
    if (currentRatio <= targetRatio) {
      log.info("COMPACT_PIPELINE", `toolResultBudget 后使用率 ${(currentRatio * 100).toFixed(0)}%，已达目标`);
      return { messages: currentMessages, steps, totalSavedChars, needsAutoCompact: false };
    }
  }

  // ② snipCompact — 裁剪最早的消息
  const snipResult = snipCompact(currentMessages);
  if (snipResult.success) {
    currentMessages = snipResult.messages;
    steps.push(`snipCompact: 裁剪 ${snipResult.snippedCount} 条消息`);
    currentRatio = estimateRatio(currentMessages, options.maxTokens);
    if (currentRatio <= targetRatio) {
      log.info("COMPACT_PIPELINE", `snipCompact 后使用率 ${(currentRatio * 100).toFixed(0)}%，已达目标`);
      return { messages: currentMessages, steps, totalSavedChars, needsAutoCompact: false };
    }
  }

  // ③ microcompactMessages — 清理旧工具结果内容
  const microResult = microcompactMessages(currentMessages);
  if (microResult.compactedCount > 0) {
    currentMessages = microResult.messages;
    totalSavedChars += microResult.savedChars;
    steps.push(`microcompact: 压缩 ${microResult.compactedCount} 个，节省 ${microResult.savedChars} 字符`);
    currentRatio = estimateRatio(currentMessages, options.maxTokens);
    if (currentRatio <= targetRatio) {
      log.info("COMPACT_PIPELINE", `microcompact 后使用率 ${(currentRatio * 100).toFixed(0)}%，已达目标`);
      return { messages: currentMessages, steps, totalSavedChars, needsAutoCompact: false };
    }
  }

  // ④ 仍然超标 → 需要 autoCompact（LLM 摘要）
  log.info("COMPACT_PIPELINE", `轻量压缩后使用率仍为 ${(currentRatio * 100).toFixed(0)}%，需要 autoCompact`);
  return { messages: currentMessages, steps, totalSavedChars, needsAutoCompact: true };
}

/** 粗略估算消息列表的 token 使用率 */
function estimateRatio(messages: Message[], maxTokens: number): number {
  let totalChars = 0;
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "text") {
        totalChars += block.text.length;
      } else if (block.type === "tool_result" && typeof block.content === "string") {
        totalChars += block.content.length;
      } else if (block.type === "tool_use") {
        totalChars += JSON.stringify(block.input).length;
      }
    }
  }
  // 粗略估算：4 字符 ≈ 1 token
  const estimatedTokens = Math.ceil(totalChars / 4);
  return estimatedTokens / maxTokens;
}

// 导出子模块
export { microcompactMessages } from "./microcompact.ts";
export { snipCompact } from "./snip-compact.ts";
export { applyToolResultBudget } from "./tool-result-budget.ts";
