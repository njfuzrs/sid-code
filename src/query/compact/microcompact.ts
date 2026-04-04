/**
 * microcompact — 轻量级消息压缩
 *
 * 清理旧的工具结果内容，释放上下文空间。
 * 两种模式：
 * - 缓存模式：保留结构但清空内容（保护 prompt cache 位置）
 * - 时间模式：直接清空旧工具结果（cache 已冷时）
 */

import type { Message, ContentBlock } from "../../llm/types.ts";
import { getLogger } from "../../debug/index.ts";

/** microcompact 配置 */
export interface MicrocompactOptions {
  /** 保留最近 N 条消息的工具结果不压缩 */
  preserveRecentCount?: number;
  /** 工具结果内容超过此长度才压缩（字符数） */
  minContentLength?: number;
  /** 压缩模式 */
  mode?: "cache" | "time";
}

const DEFAULT_OPTIONS: Required<MicrocompactOptions> = {
  preserveRecentCount: 6,   // 保留最近 3 轮（6 条消息）
  minContentLength: 500,    // 超过 500 字符才压缩
  mode: "time",
};

/** microcompact 占位符 */
const MICROCOMPACT_PLACEHOLDER = "[工具输出已压缩，如需查看请重新执行工具]";

/**
 * 对消息列表执行 microcompact
 * 返回压缩后的消息列表（不修改原数组）
 */
export function microcompactMessages(
  messages: Message[],
  options?: MicrocompactOptions,
): { messages: Message[]; compactedCount: number; savedChars: number } {
  const log = getLogger();
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (messages.length <= opts.preserveRecentCount) {
    return { messages, compactedCount: 0, savedChars: 0 };
  }

  let compactedCount = 0;
  let savedChars = 0;

  // 只压缩 preserveRecentCount 之前的消息
  const cutoff = messages.length - opts.preserveRecentCount;
  const result = messages.map((msg, idx) => {
    if (idx >= cutoff) return msg; // 保留最近的消息

    // 只压缩 user 消息中的 tool_result 块
    if (msg.role !== "user") return msg;

    const hasLargeToolResult = msg.content.some(
      b => b.type === "tool_result" &&
           typeof b.content === "string" &&
           b.content.length > opts.minContentLength
    );

    if (!hasLargeToolResult) return msg;

    const newContent: ContentBlock[] = msg.content.map(b => {
      if (b.type === "tool_result" &&
          typeof b.content === "string" &&
          b.content.length > opts.minContentLength) {
        const originalLen = b.content.length;
        savedChars += originalLen - MICROCOMPACT_PLACEHOLDER.length;
        compactedCount++;

        if (opts.mode === "cache") {
          // 缓存模式：保留前 100 字符 + 占位符（保护 cache 位置）
          return {
            ...b,
            content: b.content.slice(0, 100) + "\n" + MICROCOMPACT_PLACEHOLDER,
          };
        } else {
          // 时间模式：直接替换为占位符
          return {
            ...b,
            content: MICROCOMPACT_PLACEHOLDER,
          };
        }
      }
      return b;
    });

    return { ...msg, content: newContent };
  });

  if (compactedCount > 0) {
    log.info("MICROCOMPACT", `压缩了 ${compactedCount} 个工具结果，节省 ${savedChars} 字符`);
  }

  return { messages: result, compactedCount, savedChars };
}
