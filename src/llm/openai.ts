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
import { guardOutgoingMessages } from "./protocol-sentinel.ts";
import { sanitizeStrings } from "./sanitize-unicode.ts";

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
      // §3.4：诚实能力。模型（GPT-4o）确实支持图片，但 sid-code 内部 ContentBlock
      // 目前无 image 变体、convertMessages 也无 image → image_url content part 的转换，
      // 即没有任何上游路径能把图片喂进来。在补齐多模态管线前如实声明 false，避免能力虚标。
      vision: false,
      promptCaching: false,
      parallelToolCalls: true,
    };
  }

  /**
   * 判断模型是否为 OpenAI o-series 推理模型（o1/o3/o4...）。
   * o-series 协议差异：
   *   - system 消息须用 `developer` role（§3.1）
   *   - 须用 `max_completion_tokens`，`max_tokens` 已废弃且不兼容（§3.2）
   * 仅对官方端点的 o-series 生效；第三方兼容端点（deepseek/ollama 等）模型名不命中，保持旧行为。
   */
  private isReasoningModel(model: string): boolean {
    return /^o[0-9]/.test(model);
  }

  /**
   * 把内部 toolChoice 翻译为 OpenAI `tool_choice` 字段格式（§4.2）。
   *   "auto"/"none"/"required" → 同名字符串
   *   { name } → { type: "function", function: { name } }
   * 返回 undefined 表示不下发（沿用服务端默认）。
   */
  private static toToolChoice(
    tc: SendParams["toolChoice"],
  ): string | { type: "function"; function: { name: string } } | undefined {
    if (tc == null) return undefined;
    if (typeof tc === "string") return tc;
    return { type: "function", function: { name: tc.name } };
  }

  /**
   * 把 OpenAI finish_reason 映射为 sid-code 内部 stop_reason（§4.4）。
   * 规范枚举 5 值：stop / length / tool_calls / content_filter / function_call。
   *   - tool_calls / function_call → tool_use
   *   - length → max_tokens
   *   - content_filter → content_filter（不再误并入 end_turn，掩盖内容审查）
   *   - stop / 其它 → end_turn
   */
  private static mapFinishReason(finishReason: string | null | undefined): string {
    switch (finishReason) {
      case "tool_calls":
      case "function_call":
        return "tool_use";
      case "length":
        return "max_tokens";
      case "content_filter":
        return "content_filter";
      default:
        return "end_turn";
    }
  }

  /**
   * 统一注入 system 消息：o-series 用 `developer` role，其余用 `system`（§3.1）。
   * 仅在历史首条尚不是 system/developer 时注入，避免重复（§4.1）。
   */
  private prependSystemMessage(messages: any[], system: string, model: string): void {
    const first = messages[0];
    if (first && (first.role === "system" || first.role === "developer")) {
      return; // 已有，避免双 system（§4.1）
    }
    const role = this.isReasoningModel(model) ? "developer" : "system";
    messages.unshift({ role, content: system });
  }

  /**
   * 统一设置输出 token 上限字段：o-series 用 `max_completion_tokens`，
   * 其余用旧 `max_tokens`（§3.2）。直接写入 requestBody。
   */
  private applyMaxTokens(requestBody: any, maxTokens: number, model: string): void {
    if (this.isReasoningModel(model)) {
      requestBody.max_completion_tokens = maxTokens;
    } else {
      requestBody.max_tokens = maxTokens;
    }
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
            // §2.3 fail-fast：空 id 的 tool_use 无法与后续 tool message 配对，
            // 原样转发必然触发 OpenAI 400。在转换层提前抛错，比让服务端 400 更易定位。
            if (!block.id) {
              throw new Error(
                `OpenAI convertMessages: tool_use 缺少 id（name=${block.name}），无法构造合法 tool_calls`,
              );
            }
            toolCalls.push({
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                // §2.2：input 为 undefined 时 JSON.stringify 返回 JS undefined（非字符串），
                // 序列化进 body 会丢字段 → arguments 缺失 → 400。空参数应为 "{}"。
                arguments: JSON.stringify(block.input ?? {}),
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
            // §2.3 fail-fast：空 tool_call_id 的 tool message 无法与任何 tool_call 配对 → 400。
            if (!block.tool_use_id) {
              throw new Error(
                `OpenAI convertMessages: tool_result 缺少 tool_use_id，无法构造合法 role:tool 消息`,
              );
            }
            toolResults.push({
              tool_call_id: block.tool_use_id,
              // §2.1：规范要求 tool message content 为非空 string。工具返回空串
              //（如 bash 无输出、grep 无匹配）时部分严格网关会判非法 → 400，兜底占位。
              content: block.content && block.content.length > 0 ? block.content : "(empty)",
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
    // D1-1：发送前协议完整性关卡（只读校验 + 告警 + 落盘，不修数据，尊重 ADR-039）
    guardOutgoingMessages(params.messages, { providerName: this.name() });
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

    const effectiveModel = params.model || this._model;
    const requestBody: any = {
      model: effectiveModel,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    // §3.2：o-series 用 max_completion_tokens，其余用 max_tokens
    this.applyMaxTokens(requestBody, params.maxTokens, effectiveModel);

    if (params.system) {
      // §3.1：o-series 用 developer role，其余 system；并避免重复注入(§4.1)
      this.prependSystemMessage(requestBody.messages, params.system, effectiveModel);
    }

    if (tools && tools.length > 0) {
      requestBody.tools = tools;
      // §4.2：工具调用策略透传（不传则沿用服务端默认）
      const toolChoice = OpenAIProvider.toToolChoice(params.toolChoice);
      if (toolChoice !== undefined) requestBody.tool_choice = toolChoice;
      if (params.parallelToolCalls !== undefined) {
        requestBody.parallel_tool_calls = params.parallelToolCalls;
      }
    }

    try {
      const log = getLogger();
      const requestStartTime = Date.now();
      let firstTokenTime: number | null = null;

      log.debug("LLM:OPENAI", `发送请求到 ${this.baseURL}/chat/completions`, {
        model: requestBody.model,
        messageCount: requestBody.messages.length,
        toolCount: requestBody.tools?.length ?? 0,
        maxTokens: requestBody.max_completion_tokens ?? requestBody.max_tokens,
      });

      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(sanitizeStrings(requestBody)),
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
    // D1-1：发送前协议完整性关卡（非流式路径同样校验）
    guardOutgoingMessages(params.messages, { providerName: this.name() });
    const messages = this.convertMessages(params.messages);
    const tools = params.tools?.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    const effectiveModel = params.model || this._model;
    const requestBody: any = {
      model: effectiveModel,
      messages,
      stream: false,
    };
    // §3.2：o-series 用 max_completion_tokens，其余用 max_tokens
    this.applyMaxTokens(requestBody, params.maxTokens, effectiveModel);
    if (params.system) {
      // §3.1：o-series 用 developer role，其余 system；并避免重复注入(§4.1)
      this.prependSystemMessage(requestBody.messages, params.system, effectiveModel);
    }
    if (tools && tools.length > 0) {
      requestBody.tools = tools;
      // §4.2：工具调用策略透传（不传则沿用服务端默认）
      const toolChoice = OpenAIProvider.toToolChoice(params.toolChoice);
      if (toolChoice !== undefined) requestBody.tool_choice = toolChoice;
      if (params.parallelToolCalls !== undefined) {
        requestBody.parallel_tool_calls = params.parallelToolCalls;
      }
    }

    const log = getLogger();
    log.debug("LLM:OPENAI", "非流式请求", { model: requestBody.model });

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(sanitizeStrings(requestBody)),
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
    const stopReason = OpenAIProvider.mapFinishReason(finishReason);

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
    const requestStartAt = Date.now();
    let lastContentProgressAt = Date.now();
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

    /** 流式空闲超时（默认启用，不再依赖环境变量开关）
     *  仅 1 级 idle timeout：N 秒内 reader 无任何 chunk → 断开
     *  按模型区分：DeepSeek 大上下文处理慢 → 180s；Claude/OpenAI 等 → 90s */
    const isDeepSeek = /deepseek/i.test(this._model);
    const IDLE_TIMEOUT_MS = isDeepSeek ? 180_000 : 90_000;

    /** 30s stall 日志（只记不杀，对齐 claude-code，给弱模型喘息空间） */
    const STALL_LOG_MS = 30_000;
    const stallLogger = setInterval(() => {
      const elapsed = Date.now() - lastContentProgressAt;
      if (elapsed >= STALL_LOG_MS) {
        dbg(`stall: ${(elapsed / 1000).toFixed(0)}s 无内容进展 chunks=${totalChunks} empty=${emptyChunks}`);
      }
    }, STALL_LOG_MS);

    try {
      while (true) {
        // idle timeout 默认启用：reader 超时后 reject + cancel 释放底层 TCP 连接
        const readPromise = reader.read();
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`SSE 流空闲超时：${IDLE_TIMEOUT_MS / 1000} 秒无 chunk chunks=${totalChunks} empty=${emptyChunks}`));
          }, IDLE_TIMEOUT_MS);
          // 超时后 cancel reader，释放底层 TCP 连接（+100ms 确保 reject 先传播）
          setTimeout(() => { reader.cancel().catch(() => {}); }, IDLE_TIMEOUT_MS + 100);
        });

        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await Promise.race([readPromise, timeoutPromise]);
        } finally {
          if (timeoutId !== null) clearTimeout(timeoutId);
        }

        const { done, value } = result;
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
            dbg(`[DONE] received after ${Date.now() - requestStartAt}ms chunks=${totalChunks} empty=${emptyChunks}`);
            // [DONE] 前 flush 延迟的 message_delta（此时 usage 已更新）
            if (pendingFinishReason) {
              yield {
                type: "message_delta",
                delta: {
                  stop_reason: OpenAIProvider.mapFinishReason(pendingFinishReason),
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

            // §3.3：流中途的 API error chunk（配额超限/内容过滤/上游中断）。
            // 此前只看 choices/usage，error 被 `!delta && !finishReason` 静默跳过，
            // 表现为"流莫名结束/空响应/超时"。这里显式 yield error 并终止流。
            if (chunk.error) {
              const msg = chunk.error.message || JSON.stringify(chunk.error);
              dbg(`stream error chunk: ${msg}`);
              yield { type: "error", error: { message: `OpenAI 流内错误: ${msg}` } };
              return;
            }

            const delta = chunk.choices?.[0]?.delta;
            const finishReason = chunk.choices?.[0]?.finish_reason;
            totalChunks++;

            // Token 用量（可能在任何 chunk 中，包括 choices 为空的最终 chunk）
            if (chunk.usage) {
              usage.inputTokens = chunk.usage.prompt_tokens || 0;
              usage.outputTokens = chunk.usage.completion_tokens || 0;
            }

            if (!delta && !finishReason) continue;

            // 跟踪有效内容进展（供 stall 日志使用）
            // 仅 content/tool_calls/finish_reason 视为有效进展，reasoning 和空 chunk 不算
            const hasContent = typeof delta?.content === "string" && delta.content.length > 0;
            const hasToolCalls = Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0;
            if (hasContent || hasToolCalls || finishReason) {
              lastContentProgressAt = Date.now();
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
      clearInterval(stallLogger);
      try { reader.cancel(); } catch {}
      try { reader.releaseLock(); } catch {}
    }
  }
}
