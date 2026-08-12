/**
 * 全局 tool_result 兜底
 * 保证每个 tool_use 都有对应的 tool_result — 协议级不变量的最后防线
 */

import type { ContentBlock } from "../llm/types.ts";

/**
 * 扫描 assistant 消息中的 tool_use blocks，
 * 为缺少对应 tool_result 的生成错误结果
 */
export function* yieldMissingToolResults(
  messages: Array<{ role: string; content: ContentBlock[] }>,
  existingResultIds: Set<string>,
  errorMessage: string = "工具执行被中断",
): Generator<ContentBlock> {
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use" && !existingResultIds.has(block.id)) {
        yield {
          type: "tool_result",
          tool_use_id: block.id,
          content: errorMessage,
          is_error: true,
        };
      }
    }
  }
}

/**
 * 从消息列表中收集所有已有的 tool_result ID
 */
export function collectExistingToolResultIds(
  messages: Array<{ role: string; content: ContentBlock[] }>,
): Set<string> {
  const ids = new Set<string>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "tool_result") {
        ids.add(block.tool_use_id);
      }
    }
  }
  return ids;
}

/**
 * 从 ContentBlock 数组中收集 tool_result ID
 */
export function collectToolResultIdsFromBlocks(blocks: ContentBlock[]): Set<string> {
  const ids = new Set<string>();
  for (const block of blocks) {
    if (block.type === "tool_result") {
      ids.add(block.tool_use_id);
    }
  }
  return ids;
}
