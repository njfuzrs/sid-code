/**
 * OpenAI Provider 实现
 * 使用 fetch + SSE 流式解析
 *
 * 消息格式转换规则（sid-code 内部格式 → OpenAI API 格式）：
 * - assistant 消息中的 tool_use 块 → 顶层 tool_calls 字段
 * - user 消息中的 tool_result 块 → 独立的 role:"tool" 消息
 * - 纯文本消息 → content 为字符串
 */

import type { Provider } from "./provider.ts";
import type {
  SendParams,
  StreamEvent,
  Message,
  Usage,
} from "./types.ts";
import { getLogger } from "../debug/logger.ts";

/** 工具调用追踪状态（用于 SSE 流中多工具并行解析） */
interface ToolCallState {
  id: string;
  name: string;
  arguments: string;
  contentIndex: number; // 对应的 content block 索引
}

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

  /**
   * 将 sid-code 内部消息格式转换为 OpenAI API 格式
   *
   * 关键差异：
   * 1. OpenAI 的 tool_use 不在 content 数组里，而是 assistant 消息顶层的 tool_calls 字段
   * 2. OpenAI 的 tool_result 不在 user 消息的 content 里，而是独立的 role:"tool" 消息
   * 3. OpenAI 的 content 字段对于纯文本消息应该是字符串，不是数组
   */
  private convertMessages(messages: Message[]): any[] {
    const result: any[] = [];

    for (const msg of messages) {
      if (msg.role === "assistant") {
        // 提取文本和工具调用
        const textParts: string[] = [];
        const toolCalls: any[] = [];

        for (const block of msg.content) {
          if (block.type === "text") {
            textParts.push(block.text);
          } else if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            });
          }
        }

        const assistantMsg: any = {
          role: "assistant",
          content: textParts.join("") || null,
        };

        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls;
        }

        result.push(assistantMsg);
      } else if (msg.role === "user") {
        // 分离 tool_result 和普通内容
        const textParts: string[] = [];
        const toolResults: { tool_call_id: string; content: string }[] = [];

        for (const block of msg.content) {
          if (block.type === "text") {
            textParts.push(block.text);
          } else if (block.type === "tool_result") {
            toolResults.push({
              tool_call_id: block.tool_use_id,
              content: block.content,
            });
          }
        }

        // tool_result 拆分为独立的 role:"tool" 消息
        for (const tr of toolResults) {
          result.push({
            role: "tool",
            tool_call_id: tr.tool_call_id,
            content: tr.content,
          });
        }

        // 纯文本部分作为 user 消息（如果有的话）
        if (textParts.length > 0) {
          result.push({
            role: "user",
            content: textParts.join("\n"),
          });
        }
      }
    }

    return result;
  }

  async *sendMessageStream(
    params: SendParams,
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    // 转换消息格式
    const messages = this.convertMessages(params.messages);

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

  /**
   * 解析 SSE 流，转换为统一的 StreamEvent
   * 支持多工具并行调用：用 Map<index, ToolCallState> 追踪每个工具调用
   */
  private async *parseSSE(stream: ReadableStream<Uint8Array>): AsyncIterable<StreamEvent> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let nextContentIndex = 0;
    let textBlockStarted = false;
    // 多工具并行追踪：key 是 OpenAI 的 tool_call index
    const toolCalls = new Map<number, ToolCallState>();
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

            if (!delta && !finishReason) continue;

            // 文本内容
            if (delta?.content) {
              if (!textBlockStarted) {
                textBlockStarted = true;
                yield {
                  type: "content_block_start",
                  index: nextContentIndex,
                  content_block: { type: "text", text: "" },
                };
              }
              yield {
                type: "content_block_delta",
                index: 0, // 文本块始终是 index 0
                delta: { type: "text_delta", text: delta.content },
              };
            }

            // 工具调用（支持多个并行）
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const tcIndex = tc.index ?? 0;

                if (!toolCalls.has(tcIndex)) {
                  // 新工具调用开始
                  // 如果文本块已开始，先关闭它
                  if (textBlockStarted && nextContentIndex === 0) {
                    yield { type: "content_block_stop", index: 0 };
                    nextContentIndex = 1;
                  }
                  if (!textBlockStarted && nextContentIndex === 0) {
                    nextContentIndex = 0;
                  }

                  const contentIdx = textBlockStarted ? nextContentIndex : nextContentIndex;
                  const state: ToolCallState = {
                    id: tc.id || "",
                    name: tc.function?.name || "",
                    arguments: "",
                    contentIndex: contentIdx,
                  };
                  toolCalls.set(tcIndex, state);
                  nextContentIndex = contentIdx + 1;

                  yield {
                    type: "content_block_start",
                    index: state.contentIndex,
                    content_block: {
                      type: "tool_use",
                      id: state.id,
                      name: state.name,
                      input: {},
                    },
                  };
                }

                const state = toolCalls.get(tcIndex)!;

                // 补充 id（首个 chunk 可能没有 id）
                if (tc.id && !state.id) {
                  state.id = tc.id;
                }
                // 补充 name
                if (tc.function?.name && !state.name) {
                  state.name = tc.function.name;
                }

                if (tc.function?.arguments) {
                  state.arguments += tc.function.arguments;
                  yield {
                    type: "content_block_delta",
                    index: state.contentIndex,
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
              // 关闭文本块（如果还没关闭）
              if (textBlockStarted && nextContentIndex === 0) {
                yield { type: "content_block_stop", index: 0 };
                nextContentIndex = 1;
              }

              // 关闭所有工具调用块
              for (const [, state] of toolCalls) {
                yield { type: "content_block_stop", index: state.contentIndex };
              }

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
