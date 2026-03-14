/**
 * Token 估算和截断工具
 * 区分中文/英文/代码的 token 密度，支持按优先级智能截断
 */

import type { Attachment } from "./attachments.ts";

/**
 * 估算文本的 token 数
 * 根据内容类型使用不同的字符/token 比率：
 * - 中文文本：约 2.0 字符/token（CJK 字符更密集）
 * - 代码：约 3.0 字符/token
 * - 英文文本：约 3.5 字符/token
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  // 统计 CJK 字符数量
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const cjkRatio = cjkCount / text.length;

  // 统计代码特征（关键字、符号密度）
  const codePatterns = /(?:function |class |const |let |var |import |export |return |if |for |while |=>|[{}();=])/g;
  const codeMatches = (text.match(codePatterns) || []).length;
  const codeRatio = codeMatches / Math.max(1, text.length / 50); // 每 50 字符的代码特征数

  let charsPerToken: number;

  if (cjkRatio > 0.3) {
    // 中文为主的内容
    charsPerToken = 2.0;
  } else if (codeRatio > 0.5) {
    // 代码为主的内容
    charsPerToken = 3.0;
  } else {
    // 英文为主的内容
    charsPerToken = 3.5;
  }

  return Math.ceil(text.length / charsPerToken);
}

/**
 * 按优先级截断附件，确保总 token 不超过限制
 * 核心部分（身份、环境、工具指南、约束）必须保留，附件按优先级逐个添加
 */
export function truncateToLimit(
  coreParts: string[],
  attachments: Attachment[],
  maxTokens: number,
): string {
  // 保留 10% 余量给消息历史
  const targetTokens = Math.floor(maxTokens * 0.9);

  // 核心部分必须保留
  let content = coreParts.join("\n\n");
  let currentTokens = estimateTokens(content);

  // 按优先级逐个添加附件（附件已排序，数字越小越重要）
  for (const attachment of attachments) {
    const attachmentTokens = estimateTokens(attachment.content);
    if (currentTokens + attachmentTokens < targetTokens) {
      content += "\n\n" + attachment.content;
      currentTokens += attachmentTokens;
    } else {
      // 超限，尝试截断当前附件内容（保留前半部分）
      const remainingTokens = targetTokens - currentTokens;
      if (remainingTokens > 200) {
        // 至少还能放 200 token 才值得截断
        const truncatedChars = Math.floor(remainingTokens * 2.5); // 保守估算
        const truncated = attachment.content.slice(0, truncatedChars) + "\n\n[... 内容已截断 ...]";
        content += "\n\n" + truncated;
      }
      break;
    }
  }

  return content;
}
