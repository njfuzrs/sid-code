/**
 * Token 精确估算
 * 区分 ASCII 和非 ASCII 字符，提供更准确的 token 估算
 */

import { memoizeWithLRU } from "../utils/memoize-lru.ts";

/** ASCII 字符：英文散文实测 0.17、代码/JSON 偏高,取 0.20 折中 */
const ASCII_TOKENS_PER_CHAR = 0.20;
/** 非 ASCII 字符（中文/日文/韩文等）：取 0.65 tok/字符。
 *
 *  口径权衡（9.4）：DeepSeek 官方 tokenizer 实测中文 ≈0.52，但 Claude/Anthropic tokenizer
 *  对中文约 0.6-0.7、日文约 0.8。本基座多 provider 共用，按"宁可早压缩不要晚溢出"取偏保守的
 *  0.65（旧值 0.55 偏向 DeepSeek，长中文对话对 Claude 会累积 10-15% 低估，使 compact 触发过晚）。
 *
 *  注意：estimateTokens 之上还有 calibrationFactor 校准回路（recordActualTokens 用真实 usage
 *  反推系数并 EMA 平滑），因此此处的启发式系数仅在"首次真实 usage 校准前"生效；校准后误差收敛 < 5%。
 *  纯字符 tokenizer（@anthropic-ai/tokenizer）只对 Anthropic 准确、对其它 provider 反而引入新偏差，
 *  且校准回路已达成精度目标，故不引入该重依赖。 */
const NON_ASCII_TOKENS_PER_CHAR = 0.65;
/** 超过此长度使用快速近似（性能优化） */
const MAX_CHARS_FOR_FULL_HEURISTIC = 100_000;
/** LRU 缓存键长度上限——超长文本不缓存（key 本身就贵，且命中率低） */
const CACHE_KEY_MAX_LEN = 2_000;

/**
 * 对超长文本抽样估算"每字符 token 数"（EST-6）。
 * 等距抽样后按 ASCII / 非 ASCII 占比加权，比旧固定 0.35 对大段中文准确得多
 * （中文应为 0.55，旧值低估约 36%），同时保持 O(样本数) 性能。
 */
function sampledTokensPerChar(text: string): number {
  const SAMPLE_SIZE = 2_000;
  const step = Math.max(1, Math.floor(text.length / SAMPLE_SIZE));
  let nonAscii = 0;
  let sampled = 0;
  for (let i = 0; i < text.length; i += step) {
    if (text.charCodeAt(i) > 127) nonAscii++;
    sampled++;
  }
  if (sampled === 0) return ASCII_TOKENS_PER_CHAR;
  const nonAsciiRatio = nonAscii / sampled;
  return ASCII_TOKENS_PER_CHAR * (1 - nonAsciiRatio) + NON_ASCII_TOKENS_PER_CHAR * nonAsciiRatio;
}

/** 逐字符分类的核心算法（被缓存包裹） */
function computeTextTokens(text: string): number {
  if (text.length === 0) return 0;

  // 超长文本用快速近似（按抽样语言占比加权，而非固定混合系数）
  if (text.length > MAX_CHARS_FOR_FULL_HEURISTIC) {
    return Math.ceil(text.length * sampledTokensPerChar(text));
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
