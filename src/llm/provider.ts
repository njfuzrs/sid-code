/**
 * LLM Provider 接口
 * 所有 LLM 提供商（Anthropic/OpenAI/Ollama）必须实现此接口
 */

import type { SendParams, StreamEvent } from "./types.ts";

/** Provider 支持的能力 */
export interface ProviderCapabilities {
  streaming: boolean;       // 流式输出
  tools: boolean;           // 工具调用
  thinking: boolean;        // Extended Thinking / 深度思考
  vision: boolean;          // 图片输入
  promptCaching: boolean;   // Prompt Caching
  parallelToolCalls: boolean; // 并行工具调用
}

export interface Provider {
  /** 提供商名称 */
  name(): string;

  /** 默认模型 */
  defaultModel(): string;

  /** 发送消息并返回流式响应 */
  sendMessageStream(params: SendParams, signal?: AbortSignal): AsyncIterable<StreamEvent>;

  /** 查询 Provider 支持的能力（可选，默认全 true） */
  capabilities?(): ProviderCapabilities;
}

/** 默认能力（向后兼容，不强制实现） */
export const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  tools: true,
  thinking: false,
  vision: false,
  promptCaching: false,
  parallelToolCalls: true,
};

/** 获取 Provider 能力的辅助函数 */
export function getCapabilities(provider: Provider): ProviderCapabilities {
  return provider.capabilities?.() ?? DEFAULT_CAPABILITIES;
}
