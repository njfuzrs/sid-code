/**
 * Anthropic Provider 实现
 * 使用 @anthropic-ai/sdk 的流式 API
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Provider } from "./provider.ts";
import type {
  SendParams,
  StreamEvent,
  ContentBlock,
  ToolUseBlock,
  Usage,
} from "./types.ts";
import { getLogger } from "../debug/logger.ts";

export class AnthropicProvider implements Provider {
  private client: Anthropic;
  private _model: string;

  constructor(apiKey: string, model?: string) {
    this.client = new Anthropic({ apiKey });
    this._model = model || this.defaultModel();
  }

  name(): string {
    return "anthropic";
  }

  defaultModel(): string {
    return "claude-sonnet-4-20250514";
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
          return { type: "text" as const, text: block.text };
        } else if (block.type === "tool_use") {
          return {
            type: "tool_use" as const,
            id: block.id,
            name: block.name,
            input: block.input,
          };
        } else if (block.type === "tool_result") {
          return {
            type: "tool_result" as const,
            tool_use_id: block.tool_use_id,
            content: block.content,
            is_error: block.is_error,
          };
        }
        throw new Error(`Unknown content block type: ${(block as any).type}`);
      }),
    }));

    // 转换工具定义
    const tools = params.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));

    try {
      const log = getLogger();
      log.debug("LLM:ANTHROPIC", `发送请求`, {
        model: params.model || this._model,
        messageCount: messages.length,
        toolCount: tools?.length ?? 0,
        maxTokens: params.maxTokens,
      });

      const stream = await this.client.messages.stream({
        model: params.model || this._model,
        max_tokens: params.maxTokens,
        messages: messages as any,
        system: params.system,
        tools: tools as any,
      });

      // 转换 Anthropic SDK 事件到统一格式
      for await (const event of stream) {
        if (signal?.aborted) {
          throw new Error("Request aborted");
        }

        switch (event.type) {
          case "message_start":
            yield {
              type: "message_start",
              message: {
                usage: this.convertUsage(event.message.usage),
              },
            };
            break;

          case "content_block_start":
            yield {
              type: "content_block_start",
              index: event.index,
              content_block: this.convertContentBlock(event.content_block),
            };
            break;

          case "content_block_delta":
            if (event.delta.type === "text_delta") {
              yield {
                type: "content_block_delta",
                index: event.index,
                delta: { type: "text_delta", text: event.delta.text },
              };
            } else if (event.delta.type === "input_json_delta") {
              yield {
                type: "content_block_delta",
                index: event.index,
                delta: {
                  type: "input_json_delta",
                  partial_json: event.delta.partial_json,
                },
              };
            }
            break;

          case "content_block_stop":
            yield {
              type: "content_block_stop",
              index: event.index,
            };
            break;

          case "message_delta":
            yield {
              type: "message_delta",
              delta: { stop_reason: event.delta.stop_reason || null },
              usage: this.convertUsage(event.usage),
            };
            break;

          case "message_stop":
            yield { type: "message_stop" };
            break;

          case "error":
            yield {
              type: "error",
              error: { message: (event as any).error?.message || "Unknown error" },
            };
            break;
        }
      }
    } catch (err: any) {
      const log = getLogger();
      log.error("LLM:ANTHROPIC", `请求异常`, { error: err.message, stack: err.stack });
      yield {
        type: "error",
        error: { message: err.message || String(err) },
      };
    }
  }

  private convertUsage(usage: any): Usage {
    return {
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cacheCreationInputTokens: usage.cache_creation_input_tokens,
      cacheReadInputTokens: usage.cache_read_input_tokens,
    };
  }

  private convertContentBlock(block: any): ContentBlock {
    if (block.type === "text") {
      return { type: "text", text: block.text || "" };
    } else if (block.type === "tool_use") {
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input || {},
      };
    }
    throw new Error(`Unknown content block type: ${block.type}`);
  }
}
