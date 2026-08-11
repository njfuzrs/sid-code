/**
 * MCP 工具输出 token 上限（G3）
 *
 * 对齐 claude-code `utils/mcpValidation.ts`：MCP 工具返回的内容进上下文前，
 * 按 token 维度设上限（默认 25000），超限截断 + 引导语，避免单个 MCP 调用把
 * 上下文撑爆或 token 维度失控。此前 sid-code 只有字符级落盘保护（MAX_RESULT_SIZE），
 * 无 token 概念、无 env 覆盖、无超限引导。
 *
 * 关键设计：
 * - 上限从 env 读取，默认 25000 token；字符估算上限 = token × 4。
 * - 启发式对齐 CC：字符数 ≤ maxChars × 0.5 直接放行（省 token 估算开销）。
 * - 截断给模型看的部分，同时把完整结果落盘（两者不冲突：落盘=完整存档，截断=喂模型）。
 * - 图片按固定 token/张计入预算，超预算给占位说明而非静默丢弃。
 */

import { TokenEstimator } from "../llm/token-estimator.ts";

/** 默认 MCP 输出 token 上限（对齐 CC MAX_MCP_OUTPUT_TOKENS 默认值） */
export const DEFAULT_MAX_MCP_OUTPUT_TOKENS = 25000;

/** 每张图片的估算 token（对齐 CC IMAGE_TOKEN_ESTIMATE） */
export const IMAGE_TOKEN_ESTIMATE = 1600;

/** token → 字符的粗略换算系数（对齐 CC：char 上限 = token × 4） */
const CHARS_PER_TOKEN = 4;

/** 单例 estimator（无状态，复用即可） */
const estimator = new TokenEstimator();

/**
 * 读取 MCP 输出 token 上限。
 *
 * 优先级：SID_CODE_MAX_MCP_OUTPUT_TOKENS > MAX_MCP_OUTPUT_TOKENS(无前缀兜底，对齐 CC) > 默认 25000。
 * 非法值（非正整数）回退默认。
 */
export function getMaxMcpOutputTokens(): number {
  const raw =
    process.env.SID_CODE_MAX_MCP_OUTPUT_TOKENS ??
    process.env.MAX_MCP_OUTPUT_TOKENS;
  if (raw != null && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_MAX_MCP_OUTPUT_TOKENS;
}

/** token 上限对应的字符估算上限 */
export function getMaxMcpOutputChars(maxTokens = getMaxMcpOutputTokens()): number {
  return maxTokens * CHARS_PER_TOKEN;
}

export interface EnforceLimitResult {
  /** 截断后的文本（喂给模型的部分） */
  text: string;
  /** 是否发生了截断 */
  truncated: boolean;
  /** 截断前估算的 token 数（仅当触发估算时有值） */
  estimatedTokens?: number;
}

/**
 * 对 MCP 文本结果强制执行 token 上限。
 *
 * @param text        原始文本结果
 * @param maxTokens   token 上限（默认从 env 读取）
 * @returns 截断结果 + 是否截断标记
 */
export function enforceMcpOutputTokenLimit(
  text: string,
  maxTokens = getMaxMcpOutputTokens(),
): EnforceLimitResult {
  const maxChars = maxTokens * CHARS_PER_TOKEN;

  // 启发式：字符数 ≤ maxChars × 0.5 时内容远低于上限，跳过精确 token 估算（省开销）。
  if (text.length <= maxChars * 0.5) {
    return { text, truncated: false };
  }

  const estimatedTokens = estimator.estimateText(text);
  if (estimatedTokens <= maxTokens) {
    return { text, truncated: false, estimatedTokens };
  }

  // 超限：按字符估算上限截断，追加引导语。
  const truncated = text.slice(0, maxChars);
  const notice =
    `\n\n[输出截断——超过 ${maxTokens} token 上限（约 ${estimatedTokens} token）。` +
    `请改用分页/过滤参数缩小结果范围，或用 ReadMcpResource 分块读取。]`;
  return { text: truncated + notice, truncated: true, estimatedTokens };
}
