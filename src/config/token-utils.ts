/**
 * Token 估算和截断工具
 * 区分中文/英文/代码的 token 密度，支持按优先级智能截断
 */

import type { Attachment } from "./attachments.ts";
import { estimateTextTokens } from "../context/token.ts";

/**
 * 估算文本的 token 数。
 *
 * EST-1：收敛为单一权威实现——直接复用 context/token.ts 的 estimateTextTokens
 * （字符级逐个分类：ASCII 0.20、非 ASCII 0.55 tok/char，经 DeepSeek 官方 tokenizer 实测校准）。
 * 此前本函数自带一套粗比例系数（中文 2.0 / 代码 3.0 / 英文 3.5 字符每 token），
 * 与权威实现口径打架（英文 3.5≈0.286 vs 0.20，同段文本估出不同值）。统一改调消灭分叉。
 */
export function estimateTokens(text: string): number {
  return estimateTextTokens(text);
}

/** 截断结果（结构化，便于日志追踪） */
export interface TruncateResult {
  /** 拼接后的最终内容 */
  content: string;
  /** 完整包含的附件 */
  included: Attachment[];
  /** 被部分截断的附件（最多一个） */
  truncated?: Attachment;
  /** 被完全丢弃的附件 */
  discarded: Attachment[];
}

/**
 * 按优先级截断附件，确保总 token 不超过限制
 * 核心部分（身份、环境、工具指南、约束）必须保留，附件按优先级逐个添加
 * 返回结构化结果，包含被包含/截断/丢弃的附件列表
 */
export function truncateToLimit(
  coreParts: string[],
  attachments: Attachment[],
  maxTokens: number,
): TruncateResult {
  // 保留 10% 余量给消息历史
  const targetTokens = Math.floor(maxTokens * 0.9);

  // 核心部分必须保留
  let content = coreParts.join("\n\n");
  let currentTokens = estimateTokens(content);

  const included: Attachment[] = [];
  const discarded: Attachment[] = [];
  let truncated: Attachment | undefined;

  // 按优先级逐个添加附件（附件已排序，数字越小越重要）
  let hitLimit = false;
  for (const attachment of attachments) {
    if (hitLimit) {
      discarded.push(attachment);
      continue;
    }

    const attachmentTokens = estimateTokens(attachment.content);
    if (currentTokens + attachmentTokens < targetTokens) {
      content += "\n\n" + attachment.content;
      currentTokens += attachmentTokens;
      included.push(attachment);
    } else {
      // 超限，尝试截断当前附件内容（保留前半部分）
      const remainingTokens = targetTokens - currentTokens;
      if (remainingTokens > 200) {
        // 至少还能放 200 token 才值得截断。
        // EST-5：用该附件自身的真实 字符/token 比率换算，而非硬编码 2.5
        // （与 estimateTokens 的口径不一致会让截断点偏移；中文 ~2.0、英文 ~3.5）。
        const attTokens = estimateTokens(attachment.content);
        const charsPerToken = attTokens > 0 ? attachment.content.length / attTokens : 3.5;
        const truncatedChars = Math.floor(remainingTokens * charsPerToken);
        const truncatedContent = attachment.content.slice(0, truncatedChars) + "\n\n[内容已截断]";
        content += "\n\n" + truncatedContent;
        truncated = attachment;
      } else {
        discarded.push(attachment);
      }
      hitLimit = true;
    }
  }

  return { content, included, truncated, discarded };
}
