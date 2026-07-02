/**
 * Anthropic Provider 实现
 *
 * § 架构决策（2026-06-26 P1 改造）：
 * 使用 SDK 的 raw stream 模式 `messages.create({ stream: true })` 而非高层 `messages.stream()`。
 * SDK 只负责 HTTP 连接建立 + SSE 字节流解码为 typed event 对象（确定性、无状态），
 * 所有流内业务逻辑（idle timeout、block 拼接、usage 累加、tool input JSON 拼接）由我们自管。
 *
 * § 对齐 Claude Code（/claude-code/src/services/api/claude.ts line 1818-1820）：
 * - 避免 BetaMessageStream 的 O(n²) partialParse() 性能问题
 * - 自己管理 tool input 拼接（简单 string concat）
 * - 拿到 Stream.controller 可主动 abort
 * - .withResponse() 获取 response headers（用于 request-id 关联）
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
import { guardOutgoingMessages } from "./protocol-sentinel.ts";
import { guardedStream } from "./stream-guard.ts";
import type { StreamGuardTelemetryEvent } from "./stream-guard.ts";
import { normalizeToolInput } from "./normalize-tool-input.ts";
import { buildSystemBlocks } from "../api/cache-strategy.ts";
import { getEffectiveBetaHeaders } from "../api/beta-header-latch.ts";

export class AnthropicProvider implements Provider {
  private client: Anthropic;
  private _model: string;

  constructor(apiKey: string, model: string, baseURL?: string) {
    this.client = new Anthropic({
      apiKey,
      ...(baseURL && { baseURL }),
      // SDK 自带重试与 fallback.ts 的重试引擎会叠加放大请求次数，
      // 这里关掉 SDK 层重试，统一由 fallback.ts 管理重试/退避策略。
      maxRetries: 0,
    });
    this._model = model;
  }

  name(): string {
    return "anthropic";
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
    const log = getLogger();

    // § P1: 发送前消息完整性校验（对齐 openai.ts 的 guardOutgoingMessages 调用）
    // 提前发现 orphan tool_use 问题，比让 SDK 内部报错更可诊断
    guardOutgoingMessages(params.messages, { providerName: "anthropic" });

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
        } else if (block.type === "thinking") {
          // 多轮回传 thinking 块（含 signature）—— 丢失/修改 → 400
          // [来源: anthropic-api.md:358; tavily 确认]
          return {
            type: "thinking" as const,
            thinking: block.thinking,
            signature: block.signature,
          };
        } else if (block.type === "redacted_thinking") {
          // 多轮回传 redacted_thinking 块 —— 必须原样回传以维持推理链
          // [来源: anthropic-api.md:356-357]
          return {
            type: "redacted_thinking" as const,
            data: (block as any).data,
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
    // P1-3: strict 模式（Constrained Decoding）— 仅 Claude 4.x 模型支持
    // P1-4: FGTS（eager_input_streaming）— 仅 Anthropic 直连时启用
    // P2-4: Token Efficient Tools 与 strict 互斥
    const model = params.model || this._model;
    const enableStrict = !process.env.SID_DISABLE_STRICT_TOOLS && modelSupportsStrict(model);
    const enableFGTS = isDirectAnthropicEndpoint(this.client.baseURL)
      && !process.env.SID_DISABLE_FGTS;
    const tokenEfficientToolsEnabled = !enableStrict
      && process.env.SID_ENABLE_TOKEN_EFFICIENT_TOOLS === "1";

    const tools = params.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
      // strict 三重门控：工具声明 + 模型支持 + 环境变量未禁用
      ...(t.strict && enableStrict && { strict: true }),
      // FGTS：让 API 在生成过程中就流式发送 JSON 片段（减少大输入的等待时间）
      ...(enableFGTS && { eager_input_streaming: true }),
    }));

    // system prompt 分区缓存：按 DYNAMIC_BOUNDARY 拆分为静态区和动态区
    // 静态区跨会话可缓存，动态区会话内缓存，分别标记 cache_control
    // G4：Anthropic 直连且未禁用时，静态区用 global scope（跨用户共享 KV Cache）。
    const useGlobalScope = isDirectAnthropicEndpoint(this.client.baseURL)
      && !process.env.SID_DISABLE_GLOBAL_CACHE;
    const system = buildSystemBlocks(params.system, { globalScopeEnabled: useGlobalScope });

    try {
      const requestStartTime = Date.now();
      let firstTokenTime: number | null = null;

      // 注入客户端请求 ID，用于与服务端日志关联排查（请求超时时仍可追踪）
      const clientRequestId = generateClientRequestId();

      log.debug("LLM:ANTHROPIC", `发送请求（Prompt Caching 已启用，raw stream 模式）`, {
        model: params.model || this._model,
        messageCount: messages.length,
        toolCount: tools?.length ?? 0,
        maxTokens: params.maxTokens,
        clientRequestId,
      });

      const requestParams = {
        model: params.model || this._model,
        max_tokens: params.maxTokens,
        messages: messages as any,
        system: system as any,
        tools: tools as any,
        stream: true as const,
        // Extended Thinking 支持：根据 outputConfig.thinkingType 分发 adaptive/manual
        ...(params.thinking?.enabled && buildThinkingParam(params)),
        // output_config.effort：adaptive 模型 + DeepSeek-via-Anthropic 端点均走此字段。
        // adaptive 模型由 effort.ts 填充 params.outputConfig；DeepSeek-via-Anthropic 同理。
        ...(params.outputConfig && !params.outputFormat && {
          output_config: { effort: params.outputConfig.effort },
        }),
        // P3-1: API 级结构化输出（output_config.format）— 独立于工具调用的 JSON 约束
        ...(params.outputFormat && {
          output_config: {
            ...(params.outputConfig && { effort: params.outputConfig.effort }),
            format: params.outputFormat,
          },
        }),
        // G2: cache_edits — 服务器侧删除旧工具结果（Anthropic 私有字段，缓存友好压缩产出）。
        // SID_DISABLE_CACHE_EDITS=1 时一键关闭降级（见方案 §12 风险表）。
        ...(params.cacheEdits && params.cacheEdits.length > 0
          && !process.env.SID_DISABLE_CACHE_EDITS && {
          cache_edits: params.cacheEdits,
        }),
      };

      // § 关键改动：create({stream:true}) 替代 messages.stream()
      // SDK 只负责 HTTP 连接 + SSE 解码，流内状态完全由我们管理
      // G7: beta header sticky-on — 一旦启用某 header，整个会话不移除（移除会破坏 prompt cache）。
      const neededBetaHeaders = tokenEfficientToolsEnabled
        ? ["token-efficient-tools-2025-02-19"]
        : [];
      const effectiveBetaHeaders = getEffectiveBetaHeaders(neededBetaHeaders);
      const { data: rawStream, response } = await this.client.messages
        .create(requestParams as any, {
          headers: {
            "x-client-request-id": clientRequestId,
            // P2-4: Token Efficient Tools beta header（与 strict 互斥）+ G7 sticky-on
            ...(effectiveBetaHeaders.length > 0 && {
              "anthropic-beta": effectiveBetaHeaders.join(","),
            }),
          },
          // ⭐ 关键：把 signal 透传给 SDK，使 abort() 能真正中断底层 HTTP/TCP 连接。
          ...(signal ? { signal } : {}),
        })
        .withResponse();

      // 从 response headers 提取速率限制状态
      try {
        updateRateLimitStatus(response.headers);
      } catch {
        /* headers 提取失败不影响主流程 */
      }

      // § stream-guard 包装：idle timeout + stall detection
      const guarded = guardedStream(rawStream as unknown as AsyncIterable<any>, {
        idleTimeoutMs: 90_000,
        stallWarnMs: 30_000,
        label: "ANTHROPIC",
        onTimeout: () => {
          // § 主动 abort 底层连接（对齐 Claude Code 的 releaseStreamResources）
          try {
            (rawStream as any).controller?.abort();
          } catch { /* ignore */ }
          try {
            response.body?.cancel().catch(() => {});
          } catch { /* ignore */ }
        },
        onTelemetry: (evt: StreamGuardTelemetryEvent) => {
          // 遥测事件通过 logger 记录，接入现有可观测性系统
          log.debug("TELEMETRY:ANTHROPIC", `${evt.type}`, evt as any);
          // § 转发到统一的 RetryTelemetry 通道（由 fallback.ts 注入 onStreamTelemetry）
          // 让 stream_stall / idle_timeout / completed 进 events.jsonl，被 trace-digest.ts 消费
          try {
            params.onStreamTelemetry?.(evt);
          } catch { /* 遥测失败不影响主流程 */ }
        },
      });

      // § 自建 event 状态机处理 raw events（对齐 Claude Code contentBlocks[] 模式）
      // PARSE-2：Anthropic 的 message_delta.usage.output_tokens 是**累积值**
      let accumulatedUsage: Usage = { inputTokens: 0, outputTokens: 0 };
      let emittedOutputTokens = 0;

      // § content block 拼接与 tool input 自管
      interface InternalBlock {
        block: ContentBlock;
        /** tool_use 的 partial_json 累加器 */
        _inputAccumulator?: string;
      }
      const contentBlocks: (InternalBlock | null)[] = [];

      try {
        for await (const event of guarded) {
          if (signal?.aborted) {
            throw new Error("Request aborted");
          }

          switch ((event as any).type) {
            case "message_start": {
              const msg = (event as any).message;
              accumulatedUsage = this.convertUsage(msg.usage);
              // message_start 的 output_tokens 会被下游累加，计入"已发出累积"基线
              emittedOutputTokens = accumulatedUsage.outputTokens;
              yield {
                type: "message_start",
                message: {
                  usage: accumulatedUsage,
                },
              };
              break;
            }

            case "content_block_start": {
              const idx = (event as any).index;
              const rawBlock = (event as any).content_block;
              const converted = this.convertContentBlock(rawBlock);

              // § content_block null check 策略：fail-safe + 诊断日志
              // 不 throw（支持第三方代理的跳跃 index），stream-processor 层有兜底
              contentBlocks[idx] = { block: converted };

              yield {
                type: "content_block_start",
                index: idx,
                content_block: converted,
                // 保留原始块数据（thinking 块采集用）
                _raw_block: rawBlock?.type === "thinking" ? rawBlock : undefined,
              };
              break;
            }

            case "content_block_delta": {
              const idx = (event as any).index;
              const delta = (event as any).delta;

              // § null check 防御（第三方代理可能返回跳跃 index）
              const entry = contentBlocks[idx];
              if (!entry) {
                log.error("LLM:ANTHROPIC", `content_block_delta 引用不存在的 index=${idx}`, {
                  totalBlocks: contentBlocks.length, eventIndex: idx,
                });
                continue; // fail-safe：跳过而非崩溃
              }

              // 记录首 token 延迟（TTFT）
              if (!firstTokenTime) {
                firstTokenTime = Date.now();
                log.debug("LLM:ANTHROPIC", `首 token 延迟: ${firstTokenTime - requestStartTime}ms`);
              }

              if (delta.type === "text_delta") {
                yield {
                  type: "content_block_delta",
                  index: idx,
                  delta: { type: "text_delta", text: delta.text },
                };
              } else if (delta.type === "input_json_delta") {
                // § tool input 自管拼接（替代 SDK 的 O(n²) partialParse）
                // O(n) 设计：简单 string concat + 最终一次性 JSON.parse，不做增量 parse
                entry._inputAccumulator = (entry._inputAccumulator || "") + delta.partial_json;
                yield {
                  type: "content_block_delta",
                  index: idx,
                  delta: {
                    type: "input_json_delta",
                    partial_json: delta.partial_json,
                  },
                };
              } else if (delta.type === "thinking_delta") {
                // SDK v0.78 Extended Thinking：thinking_delta 作为 text_delta 透传
                yield {
                  type: "content_block_delta",
                  index: idx,
                  delta: { type: "text_delta", text: delta.thinking || "" },
                };
              } else if (delta.type === "signature_delta") {
                // 多轮回传必需：把 signature 累积到对应 thinking block
                // [来源: anthropic-messages-api.md:104-111; tavily 确认丢失 → 400]
                const entry = contentBlocks[idx];
                if (entry) {
                  (entry as any)._signature = ((entry as any)._signature || "") + ((delta as any).signature || "");
                }
              }
              // citations_delta 等非关键 delta 静默忽略
              break;
            }

            case "content_block_stop": {
              const idx = (event as any).index;

              // § tool input 拼接完成后一次性 JSON.parse（非每个 delta 都 parse）
              const entry = contentBlocks[idx];
              if (entry && entry.block.type === "tool_use" && entry._inputAccumulator) {
                try {
                  (entry.block as any).input = normalizeToolInput(JSON.parse(entry._inputAccumulator));
                } catch (e) {
                  log.error("LLM:ANTHROPIC", `tool input JSON 解析失败`, {
                    raw: entry._inputAccumulator.slice(0, 200),
                  });
                  (entry.block as any).input = {}; // 兜底空对象，避免下游崩溃
                }
                delete entry._inputAccumulator;
              }

              // § 把累积的 signature 写入 thinking block（多轮回传必需）
              if (entry && entry.block.type === "thinking" && (entry as any)._signature) {
                (entry.block as any).signature = (entry as any)._signature;
              }

              yield {
                type: "content_block_stop",
                index: idx,
              };
              break;
            }

            case "message_delta": {
              const delta = (event as any).delta;
              const usage = (event as any).usage;
              // output_tokens 是累积值 → 取增量发出，下游累加后等于最终累积，不重复计种子
              const cumulativeOutput = usage?.output_tokens || 0;
              const deltaOutput = Math.max(0, cumulativeOutput - emittedOutputTokens);
              emittedOutputTokens = Math.max(emittedOutputTokens, cumulativeOutput);
              accumulatedUsage = {
                ...accumulatedUsage,
                outputTokens: accumulatedUsage.outputTokens + deltaOutput,
              };
              yield {
                type: "message_delta",
                delta: { stop_reason: delta?.stop_reason || null },
                // 只发本次增量（下游 accumulateUsage 会累加）
                usage: { inputTokens: 0, outputTokens: deltaOutput },
              };
              break;
            }

            case "message_stop":
              log.debug("LLM:ANTHROPIC", "请求完成", {
                totalMs: Date.now() - requestStartTime,
                usage: accumulatedUsage,
              });
              yield { type: "message_stop" };
              break;

            case "error":
              yield {
                type: "error",
                error: { message: (event as any).error?.message || "Unknown error" },
              };
              break;

            default:
              // 处理未知事件类型
              break;
          }
        }
      } finally {
        // § 显式资源清理（对齐 Claude Code 的 releaseStreamResources）
        // 防止 TLS/socket 泄漏
        try {
          const controller = (rawStream as any).controller;
          if (controller && !controller.signal?.aborted) {
            controller.abort();
          }
        } catch { /* ignore */ }
        try {
          response.body?.cancel().catch(() => {});
        } catch { /* ignore */ }
      }
    } catch (err: any) {
      log.error("LLM:ANTHROPIC", `请求异常`, { error: err.message, stack: err.stack });
      // 接入审计日志:连接/流式异常(含超时中断、ECONNRESET)是会话 hang/中断的关键信号。
      log.warn("AUDIT:API", `✗ Anthropic 请求异常 model=${this._model} err=${(err?.message ?? String(err)).slice(0, 200)}`);
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
    // § P1: 非流式路径也加入 guardOutgoingMessages（对齐 openai.ts 双路径都有调用）
    guardOutgoingMessages(params.messages, { providerName: "anthropic" });

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
        } else if (block.type === "thinking") {
          // 多轮回传 thinking 块（含 signature）
          return {
            type: "thinking" as const,
            thinking: block.thinking,
            signature: block.signature,
          };
        } else if (block.type === "redacted_thinking") {
          // 多轮回传 redacted_thinking 块
          return {
            type: "redacted_thinking" as const,
            data: (block as any).data,
          };
        }
        throw new Error(`Unknown content block type: ${(block as any).type}`);
      }),
    }));

    const tools = params.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
      // 非流式路径同样支持 strict（对齐流式路径门控逻辑）
      ...(t.strict && !process.env.SID_DISABLE_STRICT_TOOLS
        && modelSupportsStrict(params.model || this._model) && { strict: true }),
    }));

    // G8: 非流式路径缓存标记对齐流式路径——
    // ① system 按 DYNAMIC_BOUNDARY 分区打 cache_control（含 G4 global scope）；
    // ② 在最后一条 user 消息末块打 cache_control（与流式路径同策略）；
    // ③ 携带 cache_edits（G2）。否则非流式降级路径完全不命中缓存，每次全价重算前缀。
    const useGlobalScope = isDirectAnthropicEndpoint(this.client.baseURL)
      && !process.env.SID_DISABLE_GLOBAL_CACHE;
    const system = buildSystemBlocks(params.system, { globalScopeEnabled: useGlobalScope });

    // 在最后一条 user 消息的最后一个 content block 上标记 cache_control（与流式路径一致）
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user" && messages[i].content.length > 0) {
        const lastBlock = messages[i].content[messages[i].content.length - 1];
        (lastBlock as any).cache_control = { type: "ephemeral" };
        break;
      }
    }

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
        // 与流式路径一致：Extended Thinking（adaptive/manual 双模式）
        ...(params.thinking?.enabled && buildThinkingParam(params)),
        ...(params.outputConfig && {
          output_config: { effort: params.outputConfig.effort },
        }),
        // G2: cache_edits（同流式路径门控）
        ...(params.cacheEdits && params.cacheEdits.length > 0
          && !process.env.SID_DISABLE_CACHE_EDITS && {
          cache_edits: params.cacheEdits,
        }),
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
      inputTokens: usage?.input_tokens || 0,
      outputTokens: usage?.output_tokens || 0,
      cacheCreationInputTokens: usage?.cache_creation_input_tokens,
      cacheReadInputTokens: usage?.cache_read_input_tokens,
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
      // SDK v0.78 Extended Thinking：保留结构化 ThinkingBlock 类型 + signature
      return { type: "thinking", thinking: block.thinking || "", signature: block.signature };
    } else if (block.type === "redacted_thinking") {
      // 被编辑的思考块：必须原样保留，丢弃会静默破坏推理链
      // [来源: anthropic-api.md:356-357]
      return { type: "redacted_thinking" as any, data: block.data };
    }
    // 未知块类型（server_tool_use 等）静默忽略
    const log = getLogger();
    log.debug("LLM:ANTHROPIC", `忽略未知 content block 类型: ${block.type}`);
    return { type: "text", text: "" };
  }
}

// ─── P1-3 / P1-4 / P2-4 辅助函数 ───────────────────────────────────────────

/**
 * 根据 outputConfig.thinkingType 构建 thinking 请求参数。
 * - adaptive 模型（Opus 4.7+/Sonnet 4.6/Fable 5）→ `{ thinking: { type: "adaptive" } }`
 * - manual 模型（旧）→ `{ thinking: { type: "enabled", budget_tokens: N } }`
 * [来源: anthropic-api.md:316-323]
 */
function buildThinkingParam(params: SendParams): Record<string, unknown> {
  if (params.outputConfig?.thinkingType === "adaptive") {
    return { thinking: { type: "adaptive" } };
  }
  // manual 模式（旧模型）：下发 budget_tokens
  return {
    thinking: {
      type: "enabled",
      budget_tokens: params.thinking!.budgetTokens,
    },
  };
}

/** 判断模型是否支持 strict tool use（Constrained Decoding） */
function modelSupportsStrict(model: string): boolean {
  // 仅 Claude 4.x 系列支持（opus-4, sonnet-4, haiku-4）
  return /claude-(sonnet|opus|haiku)-4/.test(model);
}

/** 判断是否为 Anthropic 直连（非代理/非 Bedrock/非 Vertex） */
function isDirectAnthropicEndpoint(baseUrl?: string): boolean {
  if (!baseUrl) return true; // 默认 SDK 行为 = 直连 api.anthropic.com
  try {
    const url = new URL(baseUrl);
    return url.hostname.endsWith("anthropic.com");
  } catch {
    return false;
  }
}
