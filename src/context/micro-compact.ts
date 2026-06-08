/**
 * 增强版微压缩（工具类型感知）
 *
 * 与 src/query/compact/microcompact.ts 的差异：
 * - 现有版本：简单占位符替换，不区分工具类型
 * - 本版本：按工具类型区分可丢弃/不可丢弃，优化压缩策略
 *
 * 可丢弃工具（输出可重新生成）：FileRead、Bash、Grep、Glob、LS、WebSearch、WebFetch
 * 不可丢弃工具（输出不可复现）：Edit、Write、Memory、AskUser
 *
 * 策略：
 * - 可丢弃工具 → 完全清空内容，仅保留轻量占位符
 * - 不可丢弃工具 → 保留前 200 字符摘要 + 占位符
 */

import type { Message, ContentBlock } from "../llm/types.ts";
import { getLogger } from "../debug/index.ts";

// ─── 工具分类 ───

/** 可丢弃工具列表（输出可重新生成，压缩时可完全清空）。
 * 注意：条目使用已去掉下划线和连字符的规范化名称，与 isDiscardableTool 的 normalize 一致。 */
const DISCARDABLE_TOOLS = new Set([
  "fileread",
  "read",
  "bash",
  "grep",
  "glob",
  "ls",
  "websearch",
  "webfetch",
]);

/** 不可丢弃工具列表（输出不可复现，压缩时保留摘要）。
 * 注意：条目使用已去掉下划线和连字符的规范化名称。 */
const NON_DISCARDABLE_TOOLS = new Set([
  "edit",
  "write",
  "memory",
  "askuser",
]);

/** micro-compact 配置 */
export interface DiscardableCompactOptions {
  /** 保留最近 N 条消息不压缩（默认 6，即 3 轮对话） */
  preserveRecentCount?: number;
  /** 工具输出超过此长度才压缩（字符数，默认 500） */
  minContentLength?: number;
}

const DEFAULT_OPTIONS: Required<DiscardableCompactOptions> = {
  preserveRecentCount: 6,
  minContentLength: 500,
};

/** 可丢弃工具占位符 */
const DISCARDABLE_PLACEHOLDER = "[可丢弃工具输出已清空，如需查看请重新执行工具]";

/** 压缩结果 */
export interface MicroCompactResult {
  /** 压缩后的消息列表（不修改原数组） */
  messages: Message[];
  /** 被压缩的工具输出数量 */
  compactedCount: number;
  /** 节省的字符数 */
  savedChars: number;
  /** 估算释放的 token 数（~4 字符 = 1 token） */
  tokenEstimateFreed: number;
}

// ─── 公开函数 ───

/**
 * 判断工具是否为可丢弃类型（输出可重新生成）
 */
export function isDiscardableTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase().replace(/[-_]/g, "");
  return DISCARDABLE_TOOLS.has(normalized);
}

/**
 * 判断工具是否为不可丢弃类型（输出不可复现）
 */
export function isNonDiscardableTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase().replace(/[-_]/g, "");
  return NON_DISCARDABLE_TOOLS.has(normalized);
}

/**
 * 从消息历史中查找 tool_use_id 对应的工具名
 */
function findToolName(messages: Message[], toolUseId: string): string {
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.id === toolUseId) {
        return block.name;
      }
    }
  }
  return "unknown";
}

/**
 * 对消息列表执行工具类型感知的微压缩
 *
 * 从早期消息开始扫描，保护窗口（最近 N 条）内的消息不会被压缩。
 * 可丢弃工具的旧输出完全清空，不可丢弃工具的旧输出保留摘要。
 *
 * @param messages 原始消息列表
 * @param options 压缩配置
 * @returns 压缩结果（不修改原数组）
 */
export function microCompactDiscardable(
  messages: Message[],
  options?: DiscardableCompactOptions,
): MicroCompactResult {
  const log = getLogger();
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (messages.length <= opts.preserveRecentCount) {
    return { messages, compactedCount: 0, savedChars: 0, tokenEstimateFreed: 0 };
  }

  let compactedCount = 0;
  let savedChars = 0;

  // 只压缩 preserveRecentCount 之前的消息
  const cutoff = messages.length - opts.preserveRecentCount;
  const result = messages.map((msg, idx) => {
    if (idx >= cutoff) return msg; // 保护窗口内，跳过
    if (msg.role !== "user") return msg; // 只处理 user 消息（包含 tool_result）

    const hasToolResult = msg.content.some(
      (b) => b.type === "tool_result" && typeof b.content === "string",
    );
    if (!hasToolResult) return msg;

    const newContent: ContentBlock[] = msg.content.map((block) => {
      if (block.type !== "tool_result" || typeof block.content !== "string") return block;
      if (block.content.length <= opts.minContentLength) return block;

      const toolName = findToolName(messages, block.tool_use_id);

      if (isDiscardableTool(toolName)) {
        // 可丢弃工具：完全清空
        savedChars += block.content.length - DISCARDABLE_PLACEHOLDER.length;
        compactedCount++;
        return { ...block, content: DISCARDABLE_PLACEHOLDER };
      }

      if (isNonDiscardableTool(toolName)) {
        // 不可丢弃工具：保留前 200 字符摘要
        const summary = block.content.slice(0, 200);
        const placeholder = `[工具输出已压缩，保留前 200 字符]\n${summary}\n... [剩余 ${block.content.length - 200} 字符已省略]`;
        savedChars += block.content.length - placeholder.length;
        compactedCount++;
        return { ...block, content: placeholder };
      }

      // 未分类工具：使用通用占位符（保持与旧版兼容）
      const genericPlaceholder = `[工具输出已压缩，原始长度 ${block.content.length} 字符]`;
      savedChars += block.content.length - genericPlaceholder.length;
      compactedCount++;
      return { ...block, content: genericPlaceholder };
    });

    return { ...msg, content: newContent };
  });

  // 粗略估算 token 释放：4 字符 ≈ 1 token
  const tokenEstimateFreed = Math.ceil(savedChars / 4);

  if (compactedCount > 0) {
    log.info("MICRO_COMPACT", `压缩了 ${compactedCount} 个工具输出（可丢弃=${countDiscardable(result, messages, cutoff)}），节省 ${savedChars} 字符 (~${tokenEstimateFreed} tokens)`);
  }

  return { messages: result, compactedCount, savedChars, tokenEstimateFreed };
}

/** 统计被压缩的可丢弃工具数量（调试用） */
function countDiscardable(
  _result: Message[],
  messages: Message[],
  cutoff: number,
): number {
  let count = 0;
  for (let i = 0; i < cutoff; i++) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    for (const block of msg.content) {
      if (block.type !== "tool_result") continue;
      if (isDiscardableTool(findToolName(messages, block.tool_use_id))) {
        count++;
      }
    }
  }
  return count;
}
