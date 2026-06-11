/**
 * Token 精确估算
 * 区分 ASCII 和非 ASCII 字符，提供更准确的 token 估算
 */

import { memoizeWithLRU } from "../utils/memoize-lru.ts";

/** ASCII 字符：英文散文实测 0.17、代码/JSON 偏高，取 0.20 折中 */
const ASCII_TOKENS_PER_CHAR = 0.20;
/** 非 ASCII 字符（中文/日文/韩文等）：DeepSeek 官方 tokenizer 实测中文 ≈0.52 tok/字符，
 *  留少量余量取 0.55（旧值 1.3 是错的，会把中文高估 ~2.5 倍并触发过早压缩） */
const NON_ASCII_TOKENS_PER_CHAR = 0.55;
/** 超过此长度使用快速近似（性能优化） */
const MAX_CHARS_FOR_FULL_HEURISTIC = 100_000;
/** 快速近似的混合语言平均比率 */
const FAST_APPROX_RATIO = 0.35;
/** LRU 缓存键长度上限——超长文本不缓存（key 本身就贵，且命中率低） */
const CACHE_KEY_MAX_LEN = 2_000;

/** 逐字符分类的核心算法（被缓存包裹） */
function computeTextTokens(text: string): number {
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

/**
 * 有界 LRU 缓存：热路径（重复估算同一段文本）命中缓存，
 * 短会话也不会无限增长（max=200，对齐 spec 2.1.3）。
 * 只缓存中短文本——超长文本作为 key 本身昂贵且很少重复。
 */
const memoizedTextTokens = memoizeWithLRU(
  computeTextTokens,
  (text: string) => text,
  200,
);

/**
 * 估算文本的 token 数
 * 短文本逐字符分类计算，超长文本用快速近似
 */
export function estimateTextTokens(text: string): number {
  // 超长文本绕过缓存（避免巨大 key 占用 LRU 槽位）
  if (text.length > CACHE_KEY_MAX_LEN) {
    return computeTextTokens(text);
  }
  return memoizedTextTokens(text);
}
