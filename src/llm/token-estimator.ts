/**
 * Token 估算服务
 * 用字符级启发式算法快速估算 token 数，避免请求前上下文超限
 */

import type { Message, ToolDefinition } from "./types.ts";
import { lookupRegistry } from "./model-registry.ts";

/** 超过此长度使用快速近似（性能优化） */
const MAX_CHARS_FOR_FULL_HEURISTIC = 100_000;

/** 未知模型 + 未声明 contextWindow 时的保守兜底窗口（tokens）。
 *  默认 128K（主流模型普遍可达），可经 SID_FALLBACK_CONTEXT_WINDOW 放宽。
 *  非法值（NaN/≤0）静默回退默认，绝不更紧。 */
const DEFAULT_FALLBACK_CONTEXT_WINDOW = 128_000;

function resolveFallbackWindow(): number {
  const raw = process.env.SID_FALLBACK_CONTEXT_WINDOW;
  if (raw !== undefined && raw !== "") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_FALLBACK_CONTEXT_WINDOW;
}

/** ASCII 字符：英文散文实测 0.17、代码/JSON 偏高，取 0.20 折中 */
const ASCII_TOKENS_PER_CHAR = 0.20;
/** 非 ASCII 字符（中文等）：取 0.65 tok/char（9.4：偏保守，防长中文对话对 Claude 累积低估） */
const NON_ASCII_TOKENS_PER_CHAR = 0.65;

/**
 * 对超长文本抽样估算"每字符 token 数"（EST-6）。
 * 等距抽样若干字符，按 ASCII / 非 ASCII 占比加权得到混合系数，
 * 比固定 0.35 对大段中文（应为 0.65）准确得多，同时保持 O(样本数) 性能。
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
    // 旧固定 0.35 对大段中文低估（中文 0.65 远高于 0.35）。
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

  /**
   * 获取模型的上下文窗口大小。
   *
   * 优先级（SSOT）：
   *   1. 用户配置 availableModels[].contextWindow —— 权威来源，用户自己声明的最准
   *   2. 内置静态表精确匹配 / 最长前缀 / 家族匹配
   *   3. 字符启发式兜底（deepseek 系 1M，其余 SID_FALLBACK_CONTEXT_WINDOW / 默认 128K）
   *
   * @param model 模型名
   * @param availableModels 可选，用户配置的模型列表（携带权威 contextWindow）
   */
  getContextLimit(
    model: string,
    availableModels?: Array<{ name?: string; contextWindow?: number }>,
  ): number {
    // 1. 用户配置优先：availableModels 里同名模型声明的 contextWindow 是权威值，
    //    避免内置静态表与用户真实部署（自建/代理/新版本）漂移。
    const userModel = availableModels?.find(m => m.name === model);
    if (typeof userModel?.contextWindow === "number" && userModel.contextWindow > 0) {
      return userModel.contextWindow;
    }

    // 2. 从统一注册表查找（替代旧的 MODEL_CONTEXT_LIMITS 静态表）
    const entry = lookupRegistry(model);
    if (entry) return entry.contextWindow;

    // 兜底：含 deepseek 的未知变体按 1M（DeepSeek 全系 1M 上下文），其余回退到可配置的保守默认。
    if (/deepseek/i.test(model)) return 1_000_000;
    return resolveFallbackWindow();
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
