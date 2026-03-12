/**
 * LLM Provider 接口
 * 所有 LLM 提供商（Anthropic/OpenAI/Ollama）必须实现此接口
 */

import type { SendParams, StreamEvent } from "./types.ts";

export interface Provider {
  /** 提供商名称 */
  name(): string;

  /** 默认模型 */
  defaultModel(): string;

  /** 发送消息并返回流式响应 */
  sendMessageStream(params: SendParams, signal?: AbortSignal): AsyncIterable<StreamEvent>;
}
