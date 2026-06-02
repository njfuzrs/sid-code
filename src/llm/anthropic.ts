/**
 * Anthropic Provider 实现
 * 使用 @anthropic-ai/sdk 的流式 API
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Provider, ProviderCapabilities } from "./provider.ts";
import type {
  SendParams,
  StreamEvent,
  ContentBlock,
  Usage,
  AccumulatedResponse,
} from "./types.ts";
import { getLogger } from "../debug/logger.ts";
import { generateClientRequestId } from "../api/api-log.ts";
import { updateRateLimitStatus } from "../api/rate-limit.ts";

export class AnthropicProvider implements Provider {
  private client: Anthropic;
  private _model: string;

  constructor(apiKey: string, model?: string, baseURL?: string) {
    this.client = new Anthropic({
      apiKey,
      ...(baseURL && { baseURL }),
    });
    this._model = model || this.defaultModel();
  }

  name(): string {
    return "anthropic";
  }

  defaultModel(): string {
    return "claude-sonnet-4-20250514";
  }

  capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      tools: true,
      thinking: true,        // Anthropic 支持 Extended Thinking
      vision: true,          // Claude 支持图片
      promptCaching: true,   // Anthropic 支持 Prompt Caching
      parallelToolCalls: true,
    };
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

    // Prompt Caching：在最后一条用户消息的最后一个 content block 上标记 cache_control
    // 这样 system prompt + 工具定义 + 历史消息都能被缓存，只有新增部分需要计算
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user" && messages[i].content.length > 0) {
        const lastBlock = messages[i].content[messages[i].content.length - 1];
        (lastBlock as any).cache_control = { type: "ephemeral" };
        break;
      }
    }

    // 转换工具定义
    const tools = params.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));

    // system prompt 分区缓存：按 DYNAMIC_BOUNDARY 拆分为静态区和动态区
    // 静态区跨会话可缓存，动态区会话内缓存，分别标记 cache_control
    const DYNAMIC_BOUNDARY = "\n\n<!-- DYNAMIC_BOUNDARY -->\n\n";
    let system: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> | undefined;
    if (params.system) {
      const boundaryIdx = params.system.indexOf(DYNAMIC_BOUNDARY);
      if (boundaryIdx !== -1) {
        const staticPart = params.system.slice(0, boundaryIdx);
        const dynamicPart = params.system.slice(boundaryIdx + DYNAMIC_BOUNDARY.length);
        system = [
          { type: "text" as const, text: staticPart, cache_control: { type: "ephemeral" as const } },
          { type: "text" as const, text: dynamicPart, cache_control: { type: "ephemeral" as const } },
        ];
      } else {
        system = [{ type: "text" as const, text: params.system, cache_control: { type: "ephemeral" as const } }];
      }
    }

    try {
      const log = getLogger();
      const requestStartTime = Date.now();
      let firstTokenTime: number | null = null;

      // 注入客户端请求 ID，用于与服务端日志关联排查（请求超时时仍可追踪）
      const clientRequestId = generateClientRequestId();

      log.debug("LLM:ANTHROPIC", `发送请求（Prompt Caching 已启用）`, {
        model: params.model || this._model,
        messageCount: messages.length,
        toolCount: tools?.length ?? 0,
        maxTokens: params.maxTokens,
        clientRequestId,
      });

      const stream = this.client.messages.stream(
        {
          model: params.model || this._model,
          max_tokens: params.maxTokens,
          messages: messages as any,
          system: system as any,
          tools: tools as any,
          // Extended Thinking 支持
          ...(params.thinking?.enabled && {
            thinking: {
              type: "enabled",
              budget_tokens: params.thinking.budgetTokens,
            },
          }),
        },
        { headers: { "x-client-request-id": clientRequestId } },
      );

      // 从响应 headers 提取真实速率限制状态（不阻塞流式迭代）
      stream
        .withResponse()
        .then(({ response }) => {
          try {
            updateRateLimitStatus(response.headers);
          } catch {
            /* headers 提取失败不影响主流程 */
          }
        })
        .catch(() => {
          /* withResponse 失败（如请求被中止）忽略 */
        });

      let accumulatedUsage: Usage = { inputTokens: 0, outputTokens: 0 };

      // 转换 Anthropic SDK 事件到统一格式
      for await (const event of stream) {
        if (signal?.aborted) {
          throw new Error("Request aborted");
        }

        switch (event.type) {
          case "message_start":
            accumulatedUsage = this.convertUsage(event.message.usage);
            yield {
              type: "message_start",
              message: {
                usage: accumulatedUsage,
              },
            };
            break;

          case "content_block_start":
            yield {
              type: "content_block_start",
              index: event.index,
              content_block: this.convertContentBlock(event.content_block),
              // 保留原始块数据（thinking 块采集用）
              _raw_block: (event.content_block as any).type === "thinking" ? event.content_block : undefined,
            };
            break;

          case "content_block_delta":
            // 记录首 token 延迟（TTFT）
            if (!firstTokenTime) {
              firstTokenTime = Date.now();
              log.debug("LLM:ANTHROPIC", `首 token 延迟: ${firstTokenTime - requestStartTime}ms`);
            }

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
            } else if (event.delta.type === "thinking_delta") {
              // SDK v0.78 Extended Thinking：thinking_delta 作为 text_delta 透传
              yield {
                type: "content_block_delta",
                index: event.index,
                delta: { type: "text_delta", text: (event.delta as any).thinking || "" },
              };
            }
            // 其他 delta 类型（signature_delta、citations_delta）静默忽略
            break;

          case "content_block_stop":
            yield {
              type: "content_block_stop",
              index: event.index,
            };
            break;

          case "message_delta":
            accumulatedUsage = {
              ...accumulatedUsage,
              outputTokens: accumulatedUsage.outputTokens + (event.usage.output_tokens || 0),
            };
            yield {
              type: "message_delta",
              delta: { stop_reason: event.delta.stop_reason || null },
              usage: accumulatedUsage,
            };
            break;

          case "message_stop":
            log.debug("LLM:ANTHROPIC", "请求完成", {
              totalMs: Date.now() - requestStartTime,
              usage: accumulatedUsage,
            });
            yield { type: "message_stop" };
            break;

          default:
            // 处理未知事件类型（如 error）
            if ((event as any).type === "error") {
              yield {
                type: "error",
                error: { message: (event as any).error?.message || "Unknown error" },
              };
            }
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

  /**
   * 非流式请求（流式降级场景使用）。
   * 复用与 sendMessageStream 相同的消息/system/tools 转换逻辑，但用 SDK 的非流式 create()。
   */
  async sendMessageNonStreaming(
    params: SendParams,
    signal?: AbortSignal,
  ): Promise<AccumulatedResponse> {
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

    const tools = params.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));

    const system = params.system
      ? [{ type: "text" as const, text: params.system }]
      : undefined;

    const log = getLogger();
    log.debug("LLM:ANTHROPIC", "非流式请求", {
      model: params.model || this._model,
      maxTokens: params.maxTokens,
    });

    const message = await this.client.messages.create(
      {
        model: params.model || this._model,
        max_tokens: params.maxTokens,
        messages: messages as any,
        system: system as any,
        tools: tools as any,
        stream: false,
      },
      signal ? { signal } : undefined,
    );

    const content: ContentBlock[] = [];
    for (const block of (message as any).content ?? []) {
      const converted = this.convertContentBlock(block);
      // 跳过被忽略的空块（未知类型）
      if (converted.type === "text" && converted.text === "" && block.type !== "text") {
        continue;
      }
      content.push(converted);
    }

    return {
      role: "assistant",
      content,
      stopReason: (message as any).stop_reason ?? null,
      usage: this.convertUsage((message as any).usage),
    };
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
    } else if (block.type === "thinking") {
      // SDK v0.78 Extended Thinking：thinking 块作为文本透传
      return { type: "text", text: block.thinking || "" };
    }
    // 未知块类型（server_tool_use、redacted_thinking 等）静默忽略
    const log = getLogger();
    log.debug("LLM:ANTHROPIC", `忽略未知 content block 类型: ${block.type}`);
    return { type: "text", text: "" };
  }
}
