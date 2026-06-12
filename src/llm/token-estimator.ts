/**
 * Token 估算服务
 * 用字符级启发式算法快速估算 token 数，避免请求前上下文超限
 */

import type { Message, ToolDefinition } from "./types.ts";

/** 各模型的上下文窗口大小 */
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // Anthropic
  "claude-sonnet-4-20250514": 200000,
  "claude-opus-4-20250514": 200000,
  "claude-haiku-3-5-20241022": 200000,
  // OpenAI
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "o1": 200000,
  "o3-mini": 200000,
  // DeepSeek（doc 实证 1M 上下文，见 api-reference/deepseek-api.md「模型细节」）
  "deepseek-v4-pro": 1_000_000,
  "deepseek-v4-flash": 1_000_000,
};

/** 超过此长度使用快速近似（性能优化） */
const MAX_CHARS_FOR_FULL_HEURISTIC = 100_000;

/** ASCII 字符：英文散文实测 0.17、代码/JSON 偏高，取 0.20 折中 */
const ASCII_TOKENS_PER_CHAR = 0.20;
/** 非 ASCII 字符（中文等）：DeepSeek 官方 tokenizer 实测中文 ≈0.52，取 0.55（旧值 1.3 高估 ~2.5 倍） */
const NON_ASCII_TOKENS_PER_CHAR = 0.55;

/**
 * 对超长文本抽样估算"每字符 token 数"（EST-6）。
 * 等距抽样若干字符，按 ASCII / 非 ASCII 占比加权得到混合系数，
 * 比固定 0.35 对大段中文（应为 0.55）准确得多，同时保持 O(样本数) 性能。
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

export class TokenEstimator {
  /** 估算文本的 token 数 */
  estimateText(text: string): number {
    if (text.length === 0) return 0;
    // 超长文本用快速近似：EST-6 改为按抽样的非 ASCII 占比估算，
    // 旧固定 0.35 对大段中文低估约 36%（中文 0.55 远高于 0.35）。
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

  /** 估算消息列表的总 token 数 */
  estimateMessages(messages: Message[]): number {
    let total = 0;
    for (const msg of messages) {
      total += 4; // 每条消息的固定开销（role + 分隔符）
      for (const block of msg.content) {
        if (block.type === "text") {
          total += this.estimateText(block.text);
        } else if (block.type === "tool_use") {
          total += this.estimateText(block.name) + this.estimateText(JSON.stringify(block.input));
        } else if (block.type === "tool_result") {
          total += this.estimateText(block.content);
        }
      }
    }
    return total;
  }

  /** 估算工具定义的 token 数 */
  estimateTools(tools: ToolDefinition[]): number {
    let total = 0;
    for (const tool of tools) {
      total += this.estimateText(tool.name);
      total += this.estimateText(tool.description);
      total += this.estimateText(JSON.stringify(tool.input_schema));
    }
    return total;
  }

  /** 获取模型的上下文窗口大小 */
  getContextLimit(model: string): number {
    // 精确匹配
    if (MODEL_CONTEXT_LIMITS[model]) return MODEL_CONTEXT_LIMITS[model];
    // EST-3：正向最长前缀匹配（model 以表项 key 开头）。
    // 旧实现 key.split("-").slice(0,3) 把表项 key 粗暴截成 3 段再做 startsWith，
    // 1M 窗口变体（deepseek 带后缀命名）会错配或回退到 128K（分母最高偏 8 倍）。
    let bestLimit = -1;
    let bestLen = -1;
    for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
      if (model.startsWith(key) && key.length > bestLen) {
        bestLimit = limit;
        bestLen = key.length;
      }
    }
    if (bestLimit > 0) return bestLimit;

    // 家族匹配：表项 key 与 model 仅尾部日期/版本号不同（如 claude-sonnet-4-20260101
    // 与表里的 claude-sonnet-4-20250514）。剥掉双方尾部的 -YYYYMMDD / -数字 段得到家族基名，
    // 基名相互前缀即视为同族。取最长基名匹配，避免短家族抢先命中。
    const familyBase = (m: string) => m.replace(/-\d{4,}.*$/, "");
    const modelBase = familyBase(model);
    for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
      const keyBase = familyBase(key);
      if (keyBase.length === 0) continue;
      if ((modelBase.startsWith(keyBase) || keyBase.startsWith(modelBase)) && keyBase.length > bestLen) {
        bestLimit = limit;
        bestLen = keyBase.length;
      }
    }
    if (bestLimit > 0) return bestLimit;

    // 兜底：含 deepseek 的未知变体按 1M（DeepSeek 全系 1M 上下文），其余保守 128K
    if (/deepseek/i.test(model)) return 1_000_000;
    return 128000; // 保守默认值
  }

  /**
   * 检查请求是否可能超出上下文限制
   * 返回 null 表示安全，否则返回超出的 token 数
   */
  checkContextFit(params: {
    model: string;
    messages: Message[];
    system?: string;
    tools?: ToolDefinition[];
    maxTokens: number;
  }): { fits: true } | { fits: false; estimated: number; limit: number } {
    const limit = this.getContextLimit(params.model);
    let estimated = this.estimateMessages(params.messages);
    if (params.system) estimated += this.estimateText(params.system);
    if (params.tools) estimated += this.estimateTools(params.tools);
    estimated += params.maxTokens; // 预留输出空间

    if (estimated < limit * 0.95) { // 留 5% 安全余量
      return { fits: true };
    }
    return { fits: false, estimated, limit };
  }
}
