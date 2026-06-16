/**
 * Ollama Provider 实现
 * 复用 OpenAI Provider，baseURL 改为 localhost:11434/v1
 */

import { OpenAIProvider } from "./openai.ts";
import type { ProviderCapabilities } from "./provider.ts";

export class OllamaProvider extends OpenAIProvider {
  constructor(model?: string, baseURL?: string) {
    super(
      "ollama",  // Ollama 不需要真实 API Key
      model || "llama3",
      baseURL || "http://localhost:11434/v1",
    );
  }

  name(): string {
    return "ollama";
  }

  defaultModel(): string {
    // Ollama Provider 默认模型（仅作内部兜底，正常路径下模型名由 config.model 提供）。
    return "llama3";
  }

  capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      tools: true,           // 部分模型支持
      thinking: false,
      vision: false,         // 取决于具体模型
      promptCaching: false,
      parallelToolCalls: false,
    };
  }
}
