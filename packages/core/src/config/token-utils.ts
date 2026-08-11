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
 * （字符级逐个分类：ASCII 0.20、非 ASCII 0.65 tok/char，偏保守以防长中文对话低估）。
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
 *
 * DYNAMIC_BOUNDARY 保真（缺口1 修复）：正常拼接路径会在静态区(coreParts + stable 附件)
 * 与动态区之间插入 DYNAMIC_BOUNDARY 标记，供下游 buildSystemBlocks 按边界分区打 cache_control。
 * 但截断是降级路径——能保留的附件本就极少，且此时 prompt 已超大、缓存本就难命中。
 * 故这里采取"保守但正确"的策略：把 boundary 插在纯静态的 coreParts 之后、任何附件之前，
 * 让所有被保留的附件都落入动态区。这样：
 *   ① 下游一定能找到 boundary（不再丢标记 → 不会把整段误当静态区固化日期/git 等易变值）；
 *   ② 静态核心区（身份/环境/工具/约束）得到缓存保护，附件全部视作动态最保守，不会误缓存易变内容。
 * 传 undefined 则退化为无边界拼接（向后兼容既有调用与测试）。
 */
export function truncateToLimit(
  coreParts: string[],
  attachments: Attachment[],
  maxTokens: number,
  dynamicBoundary?: string,
): TruncateResult {
  // 保留 10% 余量给消息历史
  const targetTokens = Math.floor(maxTokens * 0.9);

  // 核心部分必须保留。coreParts 为纯静态区；boundary 紧跟其后，其余附件落动态区。
  const staticContent = coreParts.join("\n\n");
  let content = staticContent;
  let currentTokens = estimateTokens(content);

  // 边界只在"确有附件要拼接"时才插入——纯 coreParts（无附件保留）无需边界，
  // 与正常路径 dynamicParts.length === 0 时不插边界的语义一致。
  let boundaryInserted = false;
  const ensureBoundary = () => {
    if (dynamicBoundary && !boundaryInserted) {
      content += dynamicBoundary;
      currentTokens += estimateTokens(dynamicBoundary);
      boundaryInserted = true;
    }
  };

  const included: Attachment[] = [];
  const discarded: Attachment[] = [];
  let truncated: Attachment | undefined;

  // 拼接一段动态内容：首个附件前先插 boundary（自带前后 \n\n），故 boundary 刚插入时
  // 不再补分隔符，避免多余空行；否则用 "\n\n" 分隔。
  const appendDynamic = (text: string) => {
    ensureBoundary();
    // boundary 尾部已是 \n\n；content 尚无 boundary 时用 \n\n 与静态区/前一附件分隔。
    const needSep = !(dynamicBoundary && content.endsWith(dynamicBoundary));
    content += (needSep ? "\n\n" : "") + text;
  };

  // 按优先级逐个添加附件（附件已排序，数字越小越重要）
  let hitLimit = false;
  for (const attachment of attachments) {
    if (hitLimit) {
      discarded.push(attachment);
      continue;
    }

    const attachmentTokens = estimateTokens(attachment.content);
    if (currentTokens + attachmentTokens < targetTokens) {
      appendDynamic(attachment.content);
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
        appendDynamic(truncatedContent);
        truncated = attachment;
      } else {
        discarded.push(attachment);
      }
      hitLimit = true;
    }
  }

  return { content, included, truncated, discarded };
}
