/**
 * LLM Provider 接口
 * 所有 LLM 提供商（Anthropic/OpenAI/Ollama）必须实现此接口
 */

import type { SendParams, StreamEvent, AccumulatedResponse } from "./types.ts";

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

  /** 发送消息并返回流式响应 */
  sendMessageStream(params: SendParams, signal?: AbortSignal): AsyncIterable<StreamEvent>;

  /** 查询 Provider 支持的能力（可选，默认全 true） */
  capabilities?(): ProviderCapabilities;

  /**
   * 非流式请求（可选，用于流式降级场景）。
   * 当某些网关不支持 SSE 时，stream-handler 会降级到此方法。
   * 返回累积好的完整响应，由调用方转换为流式事件序列。
   */
  sendMessageNonStreaming?(
    params: SendParams,
    signal?: AbortSignal,
  ): Promise<AccumulatedResponse>;
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
