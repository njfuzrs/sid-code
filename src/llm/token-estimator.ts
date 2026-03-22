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
};

/** 超过此长度使用快速近似（性能优化） */
const MAX_CHARS_FOR_FULL_HEURISTIC = 100_000;

const ASCII_TOKENS_PER_CHAR = 0.25;
const NON_ASCII_TOKENS_PER_CHAR = 1.3;

export class TokenEstimator {
  /** 估算文本的 token 数 */
  estimateText(text: string): number {
    if (text.length === 0) return 0;
    // 超长文本用快速近似
    if (text.length > MAX_CHARS_FOR_FULL_HEURISTIC) {
      return Math.ceil(text.length * 0.35); // 混合语言平均值
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
    // 前缀匹配（如 claude-sonnet-4-xxx）
    for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
      if (model.startsWith(key.split("-").slice(0, 3).join("-"))) return limit;
    }
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
