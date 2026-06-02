/**
 * OpenAI Provider 实现
 * 使用 fetch + SSE 流式解析
 *
 * 消息格式转换规则（sid-code 内部格式 → OpenAI API 格式）：
 * - assistant 消息中的 tool_use 块 → 顶层 tool_calls 字段
 * - user 消息中的 tool_result 块 → 独立的 role:"tool" 消息
 * - 纯文本消息 → content 为字符串
 */

import type { Provider, ProviderCapabilities } from "./provider.ts";
import type {
  SendParams,
  StreamEvent,
  Message,
  Usage,
  AccumulatedResponse,
  ContentBlock,
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

  capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      tools: true,
      thinking: false,       // OpenAI 的 o1/o3 有内置推理，但接口不同
      vision: true,          // GPT-4o 支持图片
      promptCaching: false,
      parallelToolCalls: true,
    };
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

        // DeepSeek: 回传 reasoning_content
        if (msg._meta?.reasoning_content) {
          assistantMsg.reasoning_content = msg._meta.reasoning_content;
        }

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
      stream_options: { include_usage: true },
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
      const requestStartTime = Date.now();
      let firstTokenTime: number | null = null;

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
      let accumulatedUsage: Usage = { inputTokens: 0, outputTokens: 0 };
      for await (const event of this.parseSSE(response.body!)) {
        // 记录首 token 延迟（TTFT）
        if (event.type === "content_block_delta" && !firstTokenTime) {
          firstTokenTime = Date.now();
          log.debug("LLM:OPENAI", `首 token 延迟: ${firstTokenTime - requestStartTime}ms`);
        }

        // 累积 usage
        if (event.type === "message_delta") {
          accumulatedUsage = event.usage;
        }

        yield event;
      }

      log.debug("LLM:OPENAI", "请求完成", {
        totalMs: Date.now() - requestStartTime,
        usage: accumulatedUsage,
      });
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
   * 非流式请求（流式降级场景使用）。
   * 复用 convertMessages，用普通 chat/completions 请求（stream:false）。
   */
  async sendMessageNonStreaming(
    params: SendParams,
    signal?: AbortSignal,
  ): Promise<AccumulatedResponse> {
    const messages = this.convertMessages(params.messages);
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
      stream: false,
    };
    if (params.system) {
      requestBody.messages.unshift({ role: "system", content: params.system });
    }
    if (tools && tools.length > 0) {
      requestBody.tools = tools;
    }

    const log = getLogger();
    log.debug("LLM:OPENAI", "非流式请求", { model: requestBody.model });

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
      const errText = await response.text();
      throw new Error(`OpenAI API 错误: ${response.status} ${errText}`);
    }

    const data: any = await response.json();
    const choice = data.choices?.[0];
    const msg = choice?.message ?? {};
    const content: ContentBlock[] = [];

    if (typeof msg.content === "string" && msg.content.length > 0) {
      content.push({ type: "text", text: msg.content });
    }
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        let input: unknown = {};
        try {
          input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          input = {};
        }
        content.push({
          type: "tool_use",
          id: tc.id || "",
          name: tc.function?.name || "",
          input,
        });
      }
    }

    const finishReason = choice?.finish_reason;
    const stopReason =
      finishReason === "tool_calls"
        ? "tool_use"
        : finishReason === "length"
          ? "max_tokens"
          : "end_turn";

    return {
      role: "assistant",
      content,
      stopReason,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
    };
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
    let textBlockIndex = -1;
    // 多工具并行追踪：key 是 OpenAI 的 tool_call index
    const toolCalls = new Map<number, ToolCallState>();
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    /** 30s 内 reader 一个字节都没拿到 → 网络层断连 */
    const HEARTBEAT_TIMEOUT_MS = 30_000;
    /** 90s 内没拿到任何 content/tool_calls/finish_reason → 进入"思考但不出活"状态（reasoning 不算） */
    const CONTENT_PROGRESS_TIMEOUT_MS = 90_000;
    /** 180s 内连 reasoning_content 也不增长 → 完全死锁 */
    const REASONING_PROGRESS_TIMEOUT_MS = 180_000;
    /** 240s 单次请求总时长上限 → 防止 reasoning 一直续命 */
    const TOTAL_DEADLINE_MS = 240_000;
    const requestStartAt = Date.now();
    let lastContentProgressAt = Date.now();
    let lastReasoningProgressAt = Date.now();
    /** 诊断日志：SID_CODE_DEBUG_SSE=1 启用，打印关键事件到 stderr */
    const debugSse = process.env.SID_CODE_DEBUG_SSE === "1";
    const dbg = (msg: string) => {
      if (debugSse) process.stderr.write(`[SSE] ${msg}\n`);
    };
    let totalChunks = 0;
    let emptyChunks = 0;
    /** 延迟 message_delta：finish_reason 和 usage 可能在不同 chunk 中 */
    let pendingFinishReason: string | null = null;
    // DeepSeek reasoning_content 追踪
    let reasoningBlockStarted = false;
    let reasoningContent = "";

    try {
      while (true) {
        // 4 重死锁检测 race：网络断连 / 思考停滞 / reasoning 停滞 / 总超时
        const readPromise = reader.read();
        const heartbeatTimeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`SSE 流超时：${HEARTBEAT_TIMEOUT_MS / 1000} 秒无字节(heartbeat)`)), HEARTBEAT_TIMEOUT_MS)
        );
        const contentProgressTimeout = new Promise<never>((_, reject) => {
          const remainingMs = Math.max(1, CONTENT_PROGRESS_TIMEOUT_MS - (Date.now() - lastContentProgressAt));
          setTimeout(
            () => reject(new Error(`SSE 流超时：${CONTENT_PROGRESS_TIMEOUT_MS / 1000} 秒无有效内容(content_progress) chunks=${totalChunks} empty=${emptyChunks}`)),
            remainingMs,
          );
        });
        const reasoningProgressTimeout = new Promise<never>((_, reject) => {
          const remainingMs = Math.max(1, REASONING_PROGRESS_TIMEOUT_MS - (Date.now() - lastReasoningProgressAt));
          setTimeout(
            () => reject(new Error(`SSE 流超时：${REASONING_PROGRESS_TIMEOUT_MS / 1000} 秒 reasoning 无进展(reasoning_progress)`)),
            remainingMs,
          );
        });
        const totalDeadline = new Promise<never>((_, reject) => {
          const remainingMs = Math.max(1, TOTAL_DEADLINE_MS - (Date.now() - requestStartAt));
          setTimeout(
            () => reject(new Error(`SSE 流超时：单次请求超过 ${TOTAL_DEADLINE_MS / 1000}s(total_deadline) chunks=${totalChunks}`)),
            remainingMs,
          );
        });

        const { done, value } = await Promise.race([readPromise, heartbeatTimeout, contentProgressTimeout, reasoningProgressTimeout, totalDeadline]);
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim() || line.startsWith(":")) continue;
          if (!line.startsWith("data: ")) continue;

          const data = line.slice(6);
          if (data === "[DONE]") {
            lastContentProgressAt = Date.now();
            lastReasoningProgressAt = Date.now();
            dbg(`[DONE] received after ${Date.now() - requestStartAt}ms chunks=${totalChunks} empty=${emptyChunks}`);
            // [DONE] 前 flush 延迟的 message_delta（此时 usage 已更新）
            if (pendingFinishReason) {
              yield {
                type: "message_delta",
                delta: {
                  stop_reason:
                    pendingFinishReason === "tool_calls"
                      ? "tool_use"
                      : pendingFinishReason === "length"
                        ? "max_tokens"
                        : "end_turn",
                },
                usage,
              };
              pendingFinishReason = null;
            }
            yield { type: "message_stop" };
            continue;
          }

          try {
            const chunk = JSON.parse(data);
            const delta = chunk.choices?.[0]?.delta;
            const finishReason = chunk.choices?.[0]?.finish_reason;
            totalChunks++;

            // Token 用量（可能在任何 chunk 中，包括 choices 为空的最终 chunk）
            if (chunk.usage) {
              usage.inputTokens = chunk.usage.prompt_tokens || 0;
              usage.outputTokens = chunk.usage.completion_tokens || 0;
            }

            if (!delta && !finishReason) continue;

            // 区分两类进度：content_progress 只看真产出（reasoning 不算）；reasoning_progress 单独跟踪
            // 防止 deepseek 持续吐 reasoning 但永不出 content/tool 的"思考续命"死锁
            const hasContent = typeof delta?.content === "string" && delta.content.length > 0;
            const hasReasoning = typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0;
            const hasToolCalls = Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0;
            if (hasContent || hasToolCalls || finishReason) {
              lastContentProgressAt = Date.now();
              lastReasoningProgressAt = Date.now();
            } else if (hasReasoning) {
              lastReasoningProgressAt = Date.now();
            } else {
              emptyChunks++;
            }

            // DeepSeek reasoning_content（思考链）
            if (delta?.reasoning_content) {
              if (!reasoningBlockStarted) {
                reasoningBlockStarted = true;
                yield {
                  type: "content_block_start",
                  index: nextContentIndex,
                  content_block: { type: "text", text: "" },
                  _raw_block: { type: "thinking" },
                };
                nextContentIndex++;
              }
              reasoningContent += delta.reasoning_content;
              yield {
                type: "content_block_delta",
                index: nextContentIndex - 1,
                delta: { type: "text_delta", text: delta.reasoning_content },
              };
            }

            // 文本内容
            if (delta?.content) {
              if (reasoningBlockStarted && !textBlockStarted) {
                yield { type: "content_block_stop", index: nextContentIndex - 1 };
                reasoningBlockStarted = false;
              }
              if (!textBlockStarted) {
                textBlockStarted = true;
                textBlockIndex = nextContentIndex;
                yield {
                  type: "content_block_start",
                  index: nextContentIndex,
                  content_block: { type: "text", text: "" },
                };
                nextContentIndex++;
              }
              yield {
                type: "content_block_delta",
                index: textBlockIndex,
                delta: { type: "text_delta", text: delta.content },
              };
            }

            // 工具调用（支持多个并行）
            if (delta?.tool_calls) {
              // 如果 reasoning 块还开着（没有 content 的情况下直接到 tool_calls），先关闭
              if (reasoningBlockStarted) {
                yield { type: "content_block_stop", index: nextContentIndex - 1 };
                reasoningBlockStarted = false;
              }
              for (const tc of delta.tool_calls) {
                const tcIndex = tc.index ?? 0;

                if (!toolCalls.has(tcIndex)) {
                  // 新工具调用开始
                  // 如果文本块已开始，先关闭它
                  if (textBlockStarted) {
                    yield { type: "content_block_stop", index: textBlockIndex };
                    textBlockStarted = false;
                  }

                  const contentIdx = nextContentIndex;
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

            // 完成：延迟 message_delta，等 usage chunk 到达后再 yield
            if (finishReason) {
              // 关闭 reasoning 块（如果还没关闭）
              if (reasoningBlockStarted) {
                yield { type: "content_block_stop", index: nextContentIndex - 1 };
                reasoningBlockStarted = false;
              }

              // 关闭文本块（如果还没关闭）
              if (textBlockStarted) {
                yield { type: "content_block_stop", index: textBlockIndex };
                textBlockStarted = false;
              }

              // 关闭所有工具调用块
              for (const [, state] of toolCalls) {
                yield { type: "content_block_stop", index: state.contentIndex };
              }

              pendingFinishReason = finishReason;
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
