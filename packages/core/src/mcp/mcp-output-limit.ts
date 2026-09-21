/**
 * MCP 工具输出 token 上限（G3）
 *
 * 对齐 claude-code `utils/mcpValidation.ts`：MCP 工具返回的内容进上下文前，
 * 按 token 维度设上限（默认 25000），超限截断 + 引导语，避免单个 MCP 调用把
 * 上下文撑爆或 token 维度失控。此前 sid-code 只有字符级落盘保护（MAX_RESULT_SIZE），
 * 无 token 概念、无 env 覆盖、无超限引导。
 *
 * 关键设计：
 * - 上限从 env 读取，默认 25000 token。
 * - 快路径按**最坏系数**（非 ASCII 0.65 tok/char）：`len × 0.65 ≤ maxTokens` 才跳过估算。
 *   旧实现按「4 字符 = 1 token」的一半阈值放行，5 万汉字 ≈ 32501 token 却标成没超。
 * - 超限按 token 预算切前缀，不按 `maxTokens × 4` 切字符——否则中文截完仍是上限的 2.6 倍。
 * - 截断给模型看的部分，同时把完整结果落盘（两者不冲突：落盘=完整存档，截断=喂模型）。
 * - 图片按固定 token/张计入预算，超预算给占位说明而非静默丢弃。
 */

import { TokenEstimator, NON_ASCII_TOKENS_PER_CHAR } from "../llm/token-estimator.ts";

/** 默认 MCP 输出 token 上限（对齐 CC MAX_MCP_OUTPUT_TOKENS 默认值） */
export const DEFAULT_MAX_MCP_OUTPUT_TOKENS = 25000;

/** 每张图片的估算 token（对齐 CC IMAGE_TOKEN_ESTIMATE） */
export const IMAGE_TOKEN_ESTIMATE = 1600;

/** 单例 estimator（无状态，复用即可） */
const estimator = new TokenEstimator();

/**
 * 读取 MCP 输出 token 上限。
 *
 * 优先级：SID_CODE_MAX_MCP_OUTPUT_TOKENS > MAX_MCP_OUTPUT_TOKENS(无前缀兜底，对齐 CC) > 默认 25000。
 * 非法值（非正整数）回退默认。
 */
export function getMaxMcpOutputTokens(): number {
  const raw = process.env.SID_CODE_MAX_MCP_OUTPUT_TOKENS ?? process.env.MAX_MCP_OUTPUT_TOKENS;
  if (raw != null && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_MAX_MCP_OUTPUT_TOKENS;
}

/**
 * 按最坏系数（非 ASCII）把 token 上限换成字符数：
 * 超过这个长度，纯中文一定超 token 上限，必须走估算 / 截断。
 */
export function getMaxMcpOutputChars(maxTokens = getMaxMcpOutputTokens()): number {
  return Math.floor(maxTokens / NON_ASCII_TOKENS_PER_CHAR);
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
 * 按比例切一刀，超了再收缩。混合文本前缀密度可能高于全文，
 * 所以不能只切一次；抽样估点也可能略偏，循环里用本次前缀的估算重新比例。
 */
function sliceToTokenBudget(text: string, maxTokens: number): string {
  let estimated = estimator.estimateText(text);
  if (estimated <= maxTokens) return text;
  let keep = Math.max(1, Math.floor((text.length * maxTokens) / estimated));
  for (let i = 0; i < 8; i++) {
    const prefix = text.slice(0, keep);
    const tokens = estimator.estimateText(prefix);
    if (tokens <= maxTokens) return prefix;
    keep = Math.max(1, Math.floor((keep * maxTokens) / tokens));
  }
  return text.slice(0, keep);
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
  // 快路径：即便每个字符都按非 ASCII 系数算也不超，跳过逐字符估算。
  // 5 万汉字 32500 > 25000，会走进精确路径——这正是旧「字符数 × 0.5」放行漏掉的。
  if (text.length * NON_ASCII_TOKENS_PER_CHAR <= maxTokens) {
    return { text, truncated: false };
  }

  const estimatedTokens = estimator.estimateText(text);
  if (estimatedTokens <= maxTokens) {
    return { text, truncated: false, estimatedTokens };
  }

  const truncated = sliceToTokenBudget(text, maxTokens);
  const notice =
    `\n\n[输出截断——超过 ${maxTokens} token 上限（约 ${estimatedTokens} token）。` +
    `请改用分页/过滤参数缩小结果范围，或用 ReadMcpResource 分块读取。]`;
  return { text: truncated + notice, truncated: true, estimatedTokens };
}
