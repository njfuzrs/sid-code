/**
 * OpenAI Provider 实现
 * 使用 fetch + SSE 流式解析
 */

import type { Provider } from "./provider.ts";
import type {
  SendParams,
  StreamEvent,
  ContentBlock,
  Usage,
} from "./types.ts";
import { getLogger } from "../debug/logger.ts";

export class OpenAIProvider implements Provider {
  private apiKey: string;
  private baseURL: string;
  private _model: string;

  constructor(apiKey: string, model?: string, baseURL?: string) {
    this.apiKey = apiKey;
    this.baseURL = baseURL || "https://api.openai.com/v1";
    this._model = model || this.defaultModel();
  }

  name(): string {
    return "openai";
  }

  defaultModel(): string {
    return "gpt-4o";
  }

  async *sendMessageStream(
    params: SendParams,
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    // 转换消息格式
    const messages = params.messages.map((msg) => ({
      role: msg.role,
      content: msg.content.map((block) => {
        if (block.type === "text") {
          return { type: "text", text: block.text };
        } else if (block.type === "tool_use") {
          // OpenAI 使用 tool_calls 格式
          return {
            type: "tool_call",
            id: block.id,
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          };
        } else if (block.type === "tool_result") {
          // OpenAI 使用 tool 角色
          return {
            type: "tool",
            tool_call_id: block.tool_use_id,
            content: block.content,
          };
        }
        return block;
      }),
    }));

    // 转换工具定义
    const tools = params.tools?.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    const requestBody: any = {
      model: params.model || this._model,
      messages,
      max_tokens: params.maxTokens,
      stream: true,
    };

    if (params.system) {
      // OpenAI 将 system 作为第一条消息
      requestBody.messages.unshift({
        role: "system",
        content: params.system,
      });
    }

    if (tools && tools.length > 0) {
      requestBody.tools = tools;
    }

    try {
      const log = getLogger();
      log.debug("LLM:OPENAI", `发送请求到 ${this.baseURL}/chat/completions`, {
        model: requestBody.model,
        messageCount: requestBody.messages.length,
        toolCount: requestBody.tools?.length ?? 0,
        maxTokens: requestBody.max_tokens,
      });

      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal,
      });

      if (!response.ok) {
        const error = await response.text();
        log.error("LLM:OPENAI", `API 错误: ${response.status}`, error);
        yield {
          type: "error",
          error: { message: `OpenAI API 错误: ${response.status} ${error}` },
        };
        return;
      }

      log.debug("LLM:OPENAI", `开始接收 SSE 流`);
      // 解析 SSE 流
      yield* this.parseSSE(response.body!);
    } catch (err: any) {
      const log = getLogger();
      log.error("LLM:OPENAI", `请求异常`, { error: err.message, stack: err.stack });
      yield {
        type: "error",
        error: { message: err.message || String(err) },
      };
    }
  }

  private async *parseSSE(stream: ReadableStream<Uint8Array>): AsyncIterable<StreamEvent> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let contentIndex = 0;
    let currentToolCall: any = null;
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim() || line.startsWith(":")) continue;
          if (!line.startsWith("data: ")) continue;

          const data = line.slice(6);
          if (data === "[DONE]") {
            yield { type: "message_stop" };
            continue;
          }

          try {
            const chunk = JSON.parse(data);
            const delta = chunk.choices?.[0]?.delta;
            const finishReason = chunk.choices?.[0]?.finish_reason;

            if (!delta) continue;

            // 文本内容
            if (delta.content) {
              if (contentIndex === 0) {
                yield {
                  type: "content_block_start",
                  index: contentIndex,
                  content_block: { type: "text", text: "" },
                };
              }
              yield {
                type: "content_block_delta",
                index: contentIndex,
                delta: { type: "text_delta", text: delta.content },
              };
            }

            // 工具调用
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (!currentToolCall) {
                  currentToolCall = {
                    id: tc.id || "",
                    name: tc.function?.name || "",
                    arguments: "",
                  };
                  yield {
                    type: "content_block_start",
                    index: contentIndex,
                    content_block: {
                      type: "tool_use",
                      id: currentToolCall.id,
                      name: currentToolCall.name,
                      input: {},
                    },
                  };
                }

                if (tc.function?.arguments) {
                  currentToolCall.arguments += tc.function.arguments;
                  yield {
                    type: "content_block_delta",
                    index: contentIndex,
                    delta: {
                      type: "input_json_delta",
                      partial_json: tc.function.arguments,
                    },
                  };
                }
              }
            }

            // 完成
            if (finishReason) {
              yield {
                type: "content_block_stop",
                index: contentIndex,
              };
              yield {
                type: "message_delta",
                delta: {
                  stop_reason: finishReason === "tool_calls" ? "tool_use" : "end_turn",
                },
                usage,
              };
            }

            // Token 用量
            if (chunk.usage) {
              usage.inputTokens = chunk.usage.prompt_tokens || 0;
              usage.outputTokens = chunk.usage.completion_tokens || 0;
            }
          } catch (parseErr) {
            // 跳过无法解析的行
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
