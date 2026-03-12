/**
 * Ollama Provider 实现
 * 复用 OpenAI Provider，baseURL 改为 localhost:11434/v1
 */

import { OpenAIProvider } from "./openai.ts";

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
    return "llama3";
  }
}
