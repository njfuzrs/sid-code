/**
 * Token 精确估算
 * 区分 ASCII 和非 ASCII 字符，提供更准确的 token 估算
 */

/** ASCII 字符: ~4 字符/token */
const ASCII_TOKENS_PER_CHAR = 0.25;
/** 非 ASCII 字符（中文/日文/韩文等）: ~1.3 token/字符 */
const NON_ASCII_TOKENS_PER_CHAR = 1.3;
/** 超过此长度使用快速近似（性能优化） */
const MAX_CHARS_FOR_FULL_HEURISTIC = 100_000;
/** 快速近似的混合语言平均比率 */
const FAST_APPROX_RATIO = 0.35;

/**
 * 估算文本的 token 数
 * 短文本逐字符分类计算，超长文本用快速近似
 */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;

  // 超长文本用快速近似
  if (text.length > MAX_CHARS_FOR_FULL_HEURISTIC) {
    return Math.ceil(text.length * FAST_APPROX_RATIO);
  }

  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    tokens += text.charCodeAt(i) <= 127
      ? ASCII_TOKENS_PER_CHAR
      : NON_ASCII_TOKENS_PER_CHAR;
  }

  return Math.ceil(tokens);
}
