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
import type { SendParams, StreamEvent, ContentBlock, Usage, AccumulatedResponse } from "./types.ts";
import { getLogger } from "../debug/logger.ts";
import { generateClientRequestId } from "../api/api-log.ts";
import { updateRateLimitStatus } from "../api/rate-limit.ts";
import { guardOutgoingMessages } from "./protocol-sentinel.ts";
import { createStreamLifecycle, LIFECYCLE_PRESETS } from "./stream-lifecycle.ts";
import { resolveProviderStreamTimeouts } from "../config/network-profile.ts";
import { wrapFetchWithEventLineShim } from "./sse-event-line-shim.ts";
import { wrapFetchWithKeepAlive } from "./keepalive.ts";
import type { StreamTelemetrySignal } from "./types.ts";
import {
  emitTimeoutFired,
  emitStreamPhase,
  emitHttpConnected,
  cacheDimsFor,
} from "../trace/stream-observer.ts";
import { currentSseDumpContext } from "./sse-chunk-dumper.ts";
import { normalizeToolInput } from "./normalize-tool-input.ts";
import { pickWireModel } from "./wire-model.ts";
import {
  buildSystemBlocks,
  assertCacheBreakpointBudget,
  markLastToolCacheBreakpoint,
  markLastUserMessageCacheBreakpoint,
} from "../api/cache-strategy.ts";
import { getEffectiveBetaHeaders } from "../api/beta-header-latch.ts";
import { RequestAbortedError } from "./errors.ts";

/**
 * G6：把内部 tool_result 块序列化为 Anthropic SDK 的 tool_result param。
 *
 * 若带 mediaBlocks（图片/PDF），拼成多部件 content（text + image/document），
 * 让 Claude vision 直接看图/读 PDF；否则回退纯文本 content。收敛到单一函数供
 * 流式/非流式两条序列化路径共用，避免逻辑漂移。
 */
function serializeToolResultBlock(block: {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  mediaBlocks?: import("./types.ts").ToolResultMediaBlock[];
}): any {
  if (block.mediaBlocks && block.mediaBlocks.length > 0) {
    const parts: any[] = [];
    if (block.content) {
      parts.push({ type: "text", text: block.content });
    }
    for (const mb of block.mediaBlocks) {
      if (mb.kind === "image") {
        parts.push({
          type: "image",
          source: { type: "base64", media_type: mb.mediaType, data: mb.data },
        });
      } else if (mb.kind === "document") {
        parts.push({
          type: "document",
          source: { type: "base64", media_type: mb.mediaType, data: mb.data },
        });
      }
    }
    return {
      type: "tool_result" as const,
      tool_use_id: block.tool_use_id,
      content: parts,
      is_error: block.is_error,
    };
  }
  return {
    type: "tool_result" as const,
    tool_use_id: block.tool_use_id,
    content: block.content,
    is_error: block.is_error,
  };
}

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
      // §2.3：给 SDK 传自定义 fetch，对 text/event-stream 响应注入缺失的 event: 行。
      // 部分第三方 Anthropic 兼容代理只发 data: 行、省略 event: 行，会导致 SDK 的
      // SSE 解析器静默丢弃整条流（earendil-works/pi #1983）。shim 仅在检测到缺失时
      // 介入，对规范代理零影响；SIDCODE_SSE_EVENT_SHIM=off 可完全旁路。
      // B1-b：再套一层 keep-alive 包装（内层，最贴近真实 fetch），让 fallback 在
      // ECONNRESET/EPIPE 后置位的开关真正进入 fetch 选项。SDK 的请求 init 由其内部
      // 构造、我们拿不到，故只能在 fetch 边界注入；包装内部每次调用动态读开关，
      // 所以 client 构造早于 disableKeepAlive() 也能生效。
      fetch: wrapFetchWithEventLineShim(wrapFetchWithKeepAlive()),
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
      thinking: true, // Anthropic 支持 Extended Thinking
      vision: true, // Claude 支持图片
      promptCaching: true, // Anthropic 支持 Prompt Caching
      parallelToolCalls: true,
    };
  }

  async *sendMessageStream(params: SendParams, signal?: AbortSignal): AsyncIterable<StreamEvent> {
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
          return serializeToolResultBlock(block); // G6：支持富媒体多部件 content
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
    // P1-4：与非流式路径共用同一函数（此前两处各手写一遍倒序循环）
    markLastUserMessageCacheBreakpoint(messages);

    // 转换工具定义
    // P1-3: strict 模式（Constrained Decoding）— 仅 Claude 4.x 模型支持
    // P1-4: FGTS（eager_input_streaming）— 仅 Anthropic 直连时启用
    // P2-4: Token Efficient Tools 与 strict 互斥
    // 能力判定必须按**真名**：modelSupportsStrict 是前缀/正则匹配，喂本地别名
    // （如 claude-sonnet-5-gateway 的兄弟条目 gw-claude-sonnet-5）会静默判 false，
    // strict 工具无声降级——不报错，只是行为变差，比报错更难发现。
    const model = pickWireModel(params, this._model);
    const enableStrict = !process.env.SID_DISABLE_STRICT_TOOLS && modelSupportsStrict(model);
    const enableFGTS =
      isDirectAnthropicEndpoint(this.client.baseURL) && !process.env.SID_DISABLE_FGTS;
    const tokenEfficientToolsEnabled =
      !enableStrict && process.env.SID_ENABLE_TOKEN_EFFICIENT_TOOLS === "1";

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
    const useGlobalScope =
      isDirectAnthropicEndpoint(this.client.baseURL) && !process.env.SID_DISABLE_GLOBAL_CACHE;
    const system = buildSystemBlocks(params.system, { globalScopeEnabled: useGlobalScope });

    // 增强 5.1：工具区缓存断点（对齐 CC toolToAPISchema cacheControl）。
    // 仅直连 Anthropic 且未禁用时，在最后一个工具上打一个断点，把整个工具区纳入前缀缓存分层。
    // 走网关时降级不打（网关对 scope/beta 字段兼容性差，且收益仅直连链路）。
    // SID_DISABLE_TOOL_CACHE=1 可一键关闭降级。
    const enableToolCache =
      isDirectAnthropicEndpoint(this.client.baseURL) && !process.env.SID_DISABLE_TOOL_CACHE;
    if (enableToolCache) {
      markLastToolCacheBreakpoint(tools, { globalScope: useGlobalScope });
    }

    // 比 CC 更进一步：发请求前断言 cache_control 断点数未超 Anthropic 上限(4)，
    // 把"comment-only 不变量"升级为运行时护栏(dev 抛错暴露 / prod 打日志容错)。
    // tools 一并计入(增强 5.1 新增工具区断点后总数不得超 4)。
    assertCacheBreakpointBudget(system, messages as any, getLogger(), tools as any);

    try {
      const requestStartTime = Date.now();
      let firstTokenTime: number | null = null;
      /**
       * P2-3：供 first_content 事件携带的缓存命中数（undefined = 尚未知）。
       *
       * Anthropic 在 `message_start` 就下发完整 usage，而 first content 必然晚于它，
       * 所以这里能在 emit 时刻拿到真值。保持 undefined 而非预置 0：
       * "还不知道"与"知道且为 0"必须可区分，否则 miss 桶会被未知样本污染。
       */
      let ttftCacheRead: number | undefined;

      // 注入客户端请求 ID，用于与服务端日志关联排查（请求超时时仍可追踪）
      const clientRequestId = generateClientRequestId();

      // 发往线上的真名（同名多端点时 ≠ params.model 别名，见 wire-model.ts）。
      // 日志刻意打真名：排查 400 "model not found" 时要看到实际发出去的值。
      const wireModel = pickWireModel(params, this._model);

      log.debug("LLM:ANTHROPIC", `发送请求（Prompt Caching 已启用，raw stream 模式）`, {
        model: wireModel,
        messageCount: messages.length,
        toolCount: tools?.length ?? 0,
        maxTokens: params.maxTokens,
        clientRequestId,
      });

      const requestParams = {
        model: wireModel,
        max_tokens: params.maxTokens,
        messages: messages as any,
        system: system as any,
        tools: tools as any,
        stream: true as const,
        // OPT-2: 透传 tool_choice（此前 Anthropic 两条路径均漏传，auto-compact 的 "none" 被静默丢弃）
        ...buildToolChoiceParam(params),
        // Extended Thinking 支持：根据 outputConfig.thinkingType 分发 adaptive/manual
        ...(params.thinking?.enabled && buildThinkingParam(params)),
        // output_config.effort：adaptive 模型 + DeepSeek-via-Anthropic 端点均走此字段。
        // adaptive 模型由 effort.ts 填充 params.outputConfig；DeepSeek-via-Anthropic 同理。
        ...(params.outputConfig &&
          !params.outputFormat && {
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
        ...(params.cacheEdits &&
          params.cacheEdits.length > 0 &&
          !process.env.SID_DISABLE_CACHE_EDITS && {
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

      // 缺口分析（一类·TTFB）：此前只有 openai.ts emit headers_received/HttpConnected，
      // anthropic 路径的"发出请求→收到响应头"延迟（含网关握手/排队）完全不可观测。
      // 补齐后 anthropic 与 openai 同口径，digest/provider-health 的 TTFB 归因才完整。
      try {
        const obsIndex = currentSseDumpContext().turnIndex;
        const ttfbMs = Date.now() - requestStartTime;
        const contentType = response.headers.get?.("content-type") ?? undefined;
        emitStreamPhase(obsIndex, "headers_received", {
          http_status: response.status,
          content_type: contentType,
          ttfb_ms: ttfbMs,
          model: this._model,
        });
        emitHttpConnected(obsIndex, {
          status: response.status,
          content_type: contentType,
          ttfb_ms: ttfbMs,
          model: this._model,
        });
      } catch {
        /* 可观测性 emit 失败绝不影响主流程 */
      }

      // § StreamLifecycle 包装（T7）：三层超时 idle / content progress / overall + stall detection。
      // 从 guardedStream 升级为 createStreamLifecycle，额外获得 Layer 3 请求级整体超时，
      // 对齐官方 SDK 的 request-level timeout。
      // 配置-3：content-progress / overall 阈值走 network-profile 统一解析（不再就地读 env）。
      const anthropicStreamTimeouts = resolveProviderStreamTimeouts({ providerKind: "anthropic" });
      const lifecycle = createStreamLifecycle<any>({
        // idle timeout（90s）：任何数据包（含 ping keep-alive）都 reset，保护"TCP 彻底断开"场景。
        idleTimeoutMs: LIFECYCLE_PRESETS.mainLoop.idleTimeoutMs,
        // content progress timeout：只在 content_block_delta / message_delta 到达时 reset。
        // ping / message_start / content_block_start 不续命——识破"只有 keep-alive、无真内容"的僵死流。
        // 配置-3：阈值走 network-profile 统一解析（env override > 默认），不再就地 Number(process.env)。
        // env 名保留 SID_CODE_ANTHROPIC_CONTENT_PROGRESS_TIMEOUT_MS / SID_CODE_ANTHROPIC_OVERALL_TIMEOUT_MS。
        contentProgressTimeoutMs: anthropicStreamTimeouts.contentProgressTimeoutMs,
        // T7 overall timeout：请求级绝对上限，不因任何事件重置。
        overallTimeoutMs: anthropicStreamTimeouts.overallTimeoutMs,
        isContentProgress: (event: any) =>
          event?.type === "content_block_delta" || event?.type === "message_delta",
        stallWarnMs: 30_000,
        label: "ANTHROPIC",
        // T14.6：收敛 first_content emit 到 lifecycle 层。first content 专指首个 content_block_delta
        // （与迁移前的 TTFT 口径一致，message_delta 不算首内容）。
        isFirstContent: (event: any) => event?.type === "content_block_delta",
        requestStartTimeMs: requestStartTime,
        onFirstContentProgress: (ttftMs) => {
          if (!firstTokenTime) {
            firstTokenTime = Date.now();
            log.debug("LLM:ANTHROPIC", `首 token 延迟: ${ttftMs}ms`);
            try {
              // P2-3：first_content 带上缓存维度，让"命中是否真的更快"可分桶统计。
              //
              // 为什么不做事后 join：TTFT 是 per-fetch、usage 是 per-turn，两者共享的
              // index 是 1:N（实测同会话 index=3 有 6 条 first_content 但只有 1 条
              // AfterModelRaw，另一会话 index=4 有 18 条）——按 index 关联会把一次命中的
              // usage 摊给同轮所有 fetch。所以必须在 emit 时就把维度带上。
              //
              // Anthropic 可以在此刻拿到命中数：usage 在 message_start 就下发了
              //（见下方 case "message_start"），而 first_content 必然晚于它。
              // OpenAI 族做不到（usage 在流尾部），只能在 completed 阶段补 emit。
              emitStreamPhase(currentSseDumpContext().turnIndex, "first_content", {
                ttft_ms: ttftMs,
                model: this._model,
                ...cacheDimsFor(ttftCacheRead),
              });
            } catch {
              /* 可观测性不影响主流程 */
            }
          }
        },
        // § 行为等价（T7）：不把 signal 交给 lifecycle 做早退——abort 语义完全保留在下方
        // 消费循环（`if (signal?.aborted) throw`）+ SDK signal 透传，与迁移前 guardedStream
        // 完全一致（旧 guardedStream 调用同样未传 signal）。若交给 lifecycle 早退，pre-abort
        // 场景会在 yield 前 break 导致外层不再抛 "Request aborted"，破坏既有契约。
        onTimeout: (layer) => {
          // T2/T7：记录超时触发事件（区分 idle / content_progress / overall 层）到 events.jsonl。
          // Anthropic 路径此前不写 stream-observer，这里补上超时可观测性（对齐 openai.ts）。
          try {
            const timeoutLayer =
              layer === "content_progress"
                ? "content_progress_timeout"
                : layer === "overall"
                  ? "turn_hard_timeout"
                  : "idle_timeout";
            const threshold =
              layer === "content_progress"
                ? LIFECYCLE_PRESETS.mainLoop.contentProgressTimeoutMs
                : layer === "overall"
                  ? LIFECYCLE_PRESETS.mainLoop.overallTimeoutMs
                  : LIFECYCLE_PRESETS.mainLoop.idleTimeoutMs;
            emitTimeoutFired(currentSseDumpContext().turnIndex, timeoutLayer, {
              threshold_ms: threshold,
              model: this._model,
            });
          } catch {
            /* 可观测性不影响主流程 */
          }
          // § 主动 abort 底层连接（对齐 Claude Code 的 releaseStreamResources）
          try {
            (rawStream as any).controller?.abort();
          } catch {
            /* ignore */
          }
          try {
            response.body?.cancel().catch(() => {});
          } catch {
            /* ignore */
          }
        },
        onTelemetry: (evt: StreamTelemetrySignal) => {
          // 遥测事件通过 logger 记录，接入现有可观测性系统
          log.debug("TELEMETRY:ANTHROPIC", `${evt.type}`, evt as any);
          // § 转发到统一的 RetryTelemetry 通道（由 fallback.ts 注入 onStreamTelemetry）
          // 让 stream_stall / idle_timeout / completed 进 events.jsonl，被 trace-digest.ts 消费
          try {
            params.onStreamTelemetry?.(evt);
          } catch {
            /* 遥测失败不影响主流程 */
          }
        },
      });
      const guarded = lifecycle.guard(rawStream as unknown as AsyncIterable<any>);

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
        // §7.3 修复：与 fallback.ts/stream-processor.ts/stream-lifecycle.ts 同理，
        // `for await` 内 signal?.aborted 检查只在下一个事件到达时执行——SDK signal 透传
        // 虽会中断 fetch，但若 SDK 内部缓冲/未及时释放 reader，guarded 仍可能永不 yield，
        // 使这层检查形同虚设。补 abortPromise race，abort 触发时不等下一个事件立即退出。
        const abortPromise: Promise<never> | null = (() => {
          if (!signal || signal.aborted) return null;
          return new Promise<never>((_, reject) => {
            const onAbort = () =>
              reject(new RequestAbortedError("请求已中止（anthropic consume race）"));
            signal.addEventListener("abort", onAbort, { once: true });
          });
        })();

        const iterator = guarded[Symbol.asyncIterator]();
        let iterDone = false;
        while (!iterDone) {
          if (signal?.aborted) {
            throw new RequestAbortedError("Request aborted");
          }
          const racers: Promise<IteratorResult<any>>[] = [iterator.next()];
          if (abortPromise) racers.push(abortPromise as any);
          const iterResult = await Promise.race(racers);
          if (iterResult.done) {
            iterDone = true;
            break;
          }
          const event = iterResult.value;

          if (signal?.aborted) {
            throw new RequestAbortedError("Request aborted");
          }

          switch ((event as any).type) {
            case "message_start": {
              const msg = (event as any).message;
              accumulatedUsage = this.convertUsage(msg.usage);
              // P2-3：命中数在此刻已知，记给随后的 first_content 事件做分桶维度。
              // 落 0 而非 undefined 是对的：message_start 已到达即"已知"，
              // 只是这次没命中（冷启动），它应当计入 miss 桶。
              ttftCacheRead = accumulatedUsage.cacheReadInputTokens ?? 0;
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
                  totalBlocks: contentBlocks.length,
                  eventIndex: idx,
                });
                continue; // fail-safe：跳过而非崩溃
              }

              // T14.2/T14.6：首 token 延迟（TTFT）已收敛到 lifecycle 的 onFirstContentProgress
              // 回调，在首个 content_block_delta 到达时统一 emit first_content。此处不再重复检测。

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
                  (entry as any)._signature =
                    ((entry as any)._signature || "") + ((delta as any).signature || "");
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
                  (entry.block as any).input = normalizeToolInput(
                    JSON.parse(entry._inputAccumulator),
                  );
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
              // T6：透传上游结构化 error.type（如 overloaded_error）+ streamLevel 标记，
              // 让 fallback.ts 按结构化字段而非消息文本关键词判定重试。
              yield {
                type: "error",
                error: {
                  message: (event as any).error?.message || "Unknown error",
                  type: (event as any).error?.type,
                  streamLevel: true,
                },
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
        } catch {
          /* ignore */
        }
        try {
          response.body?.cancel().catch(() => {});
        } catch {
          /* ignore */
        }
      }
    } catch (err: any) {
      log.error("LLM:ANTHROPIC", `请求异常`, { error: err.message, stack: err.stack });
      // 接入审计日志:连接/流式异常(含超时中断、ECONNRESET)是会话 hang/中断的关键信号。
      log.warn(
        "AUDIT:API",
        `✗ Anthropic 请求异常 model=${this._model} err=${(err?.message ?? String(err)).slice(0, 200)}`,
      );
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
          return serializeToolResultBlock(block); // G6：支持富媒体多部件 content
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
      // 非流式路径同样支持 strict（对齐流式路径门控逻辑）。
      // 同流式路径：能力判定吃真名，别名会静默判 false。
      ...(t.strict &&
        !process.env.SID_DISABLE_STRICT_TOOLS &&
        modelSupportsStrict(pickWireModel(params, this._model)) && { strict: true }),
    }));

    // G8: 非流式路径缓存标记对齐流式路径——
    // ① system 按 DYNAMIC_BOUNDARY 分区打 cache_control（含 G4 global scope）；
    // ② 在最后一条 user 消息末块打 cache_control（与流式路径同策略）；
    // ③ 携带 cache_edits（G2）。否则非流式降级路径完全不命中缓存，每次全价重算前缀。
    const useGlobalScope =
      isDirectAnthropicEndpoint(this.client.baseURL) && !process.env.SID_DISABLE_GLOBAL_CACHE;
    const system = buildSystemBlocks(params.system, { globalScopeEnabled: useGlobalScope });

    // 在最后一条 user 消息的最后一个 content block 上标记 cache_control（与流式路径一致）
    // P1-4：与流式路径共用同一函数，消除"同一件事两处手写"的漂移面
    markLastUserMessageCacheBreakpoint(messages);

    // 增强 5.1：工具区缓存断点（与流式路径同策略，仅直连 Anthropic 且未禁用时打）。
    const enableToolCache =
      isDirectAnthropicEndpoint(this.client.baseURL) && !process.env.SID_DISABLE_TOOL_CACHE;
    if (enableToolCache) {
      markLastToolCacheBreakpoint(tools, { globalScope: useGlobalScope });
    }

    // 与流式路径一致：发请求前断言 cache_control 断点数未超上限（tools 一并计入）。
    assertCacheBreakpointBudget(system, messages as any, getLogger(), tools as any);

    const log = getLogger();
    // 与流式路径同源：发线上的是真名，不是本地别名（见 wire-model.ts）
    const wireModel = pickWireModel(params, this._model);
    log.debug("LLM:ANTHROPIC", "非流式请求", {
      model: wireModel,
      maxTokens: params.maxTokens,
    });

    const message = await this.client.messages.create(
      {
        model: wireModel,
        max_tokens: params.maxTokens,
        messages: messages as any,
        system: system as any,
        tools: tools as any,
        stream: false,
        // OPT-2: 透传 tool_choice（与流式路径一致）
        ...buildToolChoiceParam(params),
        // 与流式路径一致：Extended Thinking（adaptive/manual 双模式）
        ...(params.thinking?.enabled && buildThinkingParam(params)),
        ...(params.outputConfig && {
          output_config: { effort: params.outputConfig.effort },
        }),
        // G2: cache_edits（同流式路径门控）
        ...(params.cacheEdits &&
          params.cacheEdits.length > 0 &&
          !process.env.SID_DISABLE_CACHE_EDITS && {
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

/**
 * 把内部 toolChoice 翻译为 Anthropic 的 `tool_choice` 字段并透传。
 *
 * § 此前 Anthropic 流式/非流式两条路径都**不下发** tool_choice（仅 OpenAI 兼容路径处理），
 * 导致上层设的 toolChoice 被静默丢弃——最典型的受害者是 auto-compact.ts 的
 * `toolChoice: "none"`（禁止摘要时调用工具），在 Anthropic 直连下形同虚设，
 * 模型摘要时仍可能调工具，浪费一轮或污染摘要。此函数补齐透传。
 *
 * § 取值映射（Anthropic 与 OpenAI 语义不同，别照搬）：
 *   "auto"      → { type: "auto" }
 *   "none"      → { type: "none" }
 *   "required"  → { type: "any" }          （OpenAI 叫 required，Anthropic 叫 any）
 *   { name }    → { type: "tool", name }
 *
 * § thinking 交互（比原方案更精确）：
 *   Anthropic 官方约束——开启 thinking 时，tool_choice 只接受 auto / none，
 *   传 any / tool（强制）会 400（见 anthropics/claude-code#18759）。
 *   因此仅当 thinking 开启 **且** 请求的是"强制"类取值（required/{name}）时，
 *   才降级为 auto 并告警；none/auto 在 thinking 下合法，原样透传（保住 auto-compact 的 none）。
 *
 * 返回可展开进 requestParams 的对象（不下发时返回空对象 `{}`）。
 */
function buildToolChoiceParam(params: SendParams): Record<string, unknown> {
  const tc = params.toolChoice;
  if (tc == null) return {};

  const isForced = tc === "required" || typeof tc === "object";
  if (params.thinking?.enabled && isForced) {
    // thinking 下强制 tool_choice 会 400：降级 auto + 依赖 prompt 引导，并告警留痕
    getLogger().warn(
      "LLM:ANTHROPIC",
      `thinking 开启时不支持强制 tool_choice，已将 ${JSON.stringify(tc)} 降级为 auto（Anthropic 约束，见 claude-code#18759）`,
    );
    return { tool_choice: { type: "auto" as const } };
  }

  if (typeof tc === "string") {
    switch (tc) {
      case "auto":
        return { tool_choice: { type: "auto" as const } };
      case "none":
        return { tool_choice: { type: "none" as const } };
      case "required":
        return { tool_choice: { type: "any" as const } };
    }
  }
  // { name } → 强制调用指定工具
  return { tool_choice: { type: "tool" as const, name: tc.name } };
}

/**
 * 判断模型是否支持 strict tool use（Constrained Decoding）。
 *
 * ## 判定方向：排除法，不是枚举法
 *
 * 原实现是 `/claude-(sonnet|opus|haiku)-4/`——**枚举已知支持的版本号**。它在写下的
 * 那一刻是对的，但 Claude 5 系列发布后立刻失效：`claude-sonnet-5` / `claude-opus-5` /
 * `claude-fable-5` 全部不匹配，于是 `registry.ts:79` 给内置工具打的 `strict: true`
 * 被 `anthropic.ts` 的门控在发线前静默剥掉，**整个 Claude 5 系列失去 Constrained
 * Decoding**，且无任何日志。
 *
 * 后果不是"少个优化"。strict 是从协议层杜绝「required 字段漏发」的机制；关掉它，
 * 模型漏字段就只能靠工具层 zod 事后报错 + 模型自己重试一轮。实测事故
 * （会话 20260803-135816-8c8619e7，`ask_user_question` 漏 `question` 字段、
 * `header`/`options` 完好、`stop_reason: tool_use` 非截断）正是这个缺口的产物：
 * 开着 strict 时该错误在物理上不可能发生。
 *
 * 所以判定方向必须反转：**默认认为支持，只排除已知不支持的**。新模型发布时
 * 默认享受 strict（发错了会 400，是响亮失败、当场可见），而不是默认静默失去
 * 保护（无声退化，要靠一次线上事故 + 一次轨迹考古才能发现）。
 *
 * 这也是本仓库的既有约定：开关类默认值禁止写死模型名单判断，否则必随模型迭代漂移。
 *
 * ## 为什么只排除 claude-3 及更早
 *
 * strict / Constrained Decoding 自 Claude 4 起提供，Claude 3.x 及 instant/2.x 不支持。
 * 这些是**已冻结的历史版本号**，不会再新增，因此枚举它们不会漂移——与枚举"未来还会
 * 不断新增的支持版本"有本质区别。
 *
 * 非 Claude 模型（走 Anthropic 兼容端点的第三方模型）一律不发 strict：它们的兼容层
 * 通常只实现 Messages API 的公共子集，发未知字段风险不对称（收益是省一次重试，
 * 代价可能是整条链路 400）。
 *
 * 兜底逃生阀仍是 `SID_DISABLE_STRICT_TOOLS=1`（在两处调用点判定）。
 */
export function modelSupportsStrict(model: string): boolean {
  // 非 Claude 模型（第三方兼容端点）：不发 strict，避免未知字段打挂兼容层
  if (!/claude/i.test(model)) return false;
  // Claude 3.x / 2.x / instant / v1：strict 于 Claude 4 才引入。
  // 这些是**已冻结**的历史版本号（不会再新增），枚举它们不产生漂移。
  // 版本号后可紧跟 `-` / `.` / 串尾，故三种边界都要认（claude-3-opus / claude-3.5 / claude-3）。
  if (/claude-(?:3|2|instant|v?1)(?:[.\-]|$)/i.test(model)) return false;
  // 其余 Claude（4.x / 5.x / 以及未来版本）默认支持——新模型不再静默失去保护
  return true;
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
