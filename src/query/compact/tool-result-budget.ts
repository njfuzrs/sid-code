/**
 * toolResultBudget — 工具结果预算控制
 *
 * 超大工具结果替换为占位符，防止单个工具输出占满上下文。
 * 被替换的内容可持久化到磁盘（可恢复）。
 */

import type { Message, ContentBlock } from "../../llm/types.ts";
import { getLogger } from "../../debug/index.ts";

/** 工具结果预算配置 */
export interface ToolResultBudgetOptions {
  /** 单个工具结果的最大 token 预算（默认 10000） */
  maxTokensPerResult?: number;
  /** 所有工具结果的总 token 预算（默认 50000） */
  totalBudget?: number;
  /** 保留最近 N 条消息的工具结果不受预算限制 */
  preserveRecentCount?: number;
  /** 每个字符约等于多少 token（粗略估算） */
  charsPerToken?: number;
}

const DEFAULT_OPTIONS: Required<ToolResultBudgetOptions> = {
  maxTokensPerResult: 10000,
  totalBudget: 50000,
  preserveRecentCount: 4,
  charsPerToken: 4,
};

/** 预算占位符 */
const BUDGET_PLACEHOLDER = (originalChars: number) =>
  `[工具输出已截断，原始长度 ${originalChars} 字符。如需完整内容请重新执行工具]`;

/** 预算控制结果 */
export interface ToolResultBudgetResult {
  messages: Message[];
  truncatedCount: number;
  savedChars: number;
}

/**
 * 对消息列表应用工具结果预算
 * 从最早的消息开始，超出预算的工具结果替换为占位符
 */
export function applyToolResultBudget(
  messages: Message[],
  options?: ToolResultBudgetOptions,
): ToolResultBudgetResult {
  const log = getLogger();
  const opts = { ...DEFAULT_OPTIONS, ...options };

  let totalTokensUsed = 0;
  let truncatedCount = 0;
  let savedChars = 0;

  const cutoff = Math.max(0, messages.length - opts.preserveRecentCount);

  const result = messages.map((msg, idx) => {
    if (idx >= cutoff) return msg; // 保留最近的消息
    if (msg.role !== "user") return msg;

    const hasToolResult = msg.content.some(b => b.type === "tool_result");
    if (!hasToolResult) return msg;

    const newContent: ContentBlock[] = msg.content.map(b => {
      if (b.type !== "tool_result" || typeof b.content !== "string") return b;

      const contentChars = b.content.length;
      const estimatedTokens = Math.ceil(contentChars / opts.charsPerToken);

      // 检查单个结果预算
      if (estimatedTokens > opts.maxTokensPerResult) {
        savedChars += contentChars - BUDGET_PLACEHOLDER(contentChars).length;
        truncatedCount++;
        return { ...b, content: BUDGET_PLACEHOLDER(contentChars) };
      }

      // 检查总预算
      totalTokensUsed += estimatedTokens;
      if (totalTokensUsed > opts.totalBudget) {
        savedChars += contentChars - BUDGET_PLACEHOLDER(contentChars).length;
        truncatedCount++;
        return { ...b, content: BUDGET_PLACEHOLDER(contentChars) };
      }

      return b;
    });

    return { ...msg, content: newContent };
  });

  if (truncatedCount > 0) {
    log.info("TOOL_BUDGET", `截断了 ${truncatedCount} 个工具结果，节省 ${savedChars} 字符`);
  }

  return { messages: result, truncatedCount, savedChars };
}
