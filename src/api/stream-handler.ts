/**
 * 流式处理层 — 带非流式降级能力
 *
 * 职责（对标 Claude Code 的流式→非流式降级）：
 * - 优先走流式请求
 * - 当遇到"流式传输层"错误（SSE 不被网关支持、连接提前关闭等）时，
 *   自动降级到非流式请求（provider.sendMessageNonStreaming），并把结果重放为流式事件
 * - 仅传输错误触发降级；API 逻辑错误（429/401/prompt too long 等）原样抛出
 *
 * 关键约束：降级时 max_tokens 被收紧（非流式响应无增量，过大会超时），
 * 默认上限 16384，超时默认 120s。
 */

import type { Provider } from "../llm/provider.ts";
import type { SendParams, StreamEvent, AccumulatedResponse } from "../llm/types.ts";
import { getNetworkErrorCode } from "../llm/errors.ts";
import { getErrorMessage } from "./error-utils.ts";
import { getLogger } from "../debug/index.ts";

/** 流式处理配置 */
export interface StreamHandlerConfig {
  /** 是否允许非流式降级（默认 true） */
  allowNonStreamingFallback?: boolean;
  /** 非流式 max_tokens 上限（默认 16384，比流式小） */
  nonStreamingMaxTokens?: number;
}

const DEFAULT_NON_STREAMING_MAX_TOKENS = 16_384;

/**
 * 判断是否是流式传输层面的错误（而非 API 逻辑错误）。
 * 只有传输错误才应该触发非流式降级。
 */
export function isStreamingTransportError(error: unknown): boolean {
  const code = getNetworkErrorCode(error);
  if (code === "ECONNRESET" || code === "EPIPE") return true;

  const msg = getErrorMessage(error).toLowerCase();
  return (
    msg.includes("sse") ||
    msg.includes("event stream") ||
    msg.includes("text/event-stream") ||
    msg.includes("chunked transfer") ||
    msg.includes("unexpected end of") ||
    msg.includes("premature close") ||
    msg.includes("stream closed") ||
    msg.includes("incomplete chunked encoding")
  );
}

/**
 * 将累积好的非流式响应转换为流式事件序列。
 * 重放顺序：message_start → 每个 block(start/delta/stop) → message_delta → message_stop。
 */
export function* convertToStreamEvents(
  response: AccumulatedResponse,
): Generator<StreamEvent> {
  yield {
    type: "message_start",
    message: { usage: response.usage },
  };

  for (let index = 0; index < response.content.length; index++) {
    const block = response.content[index];
    yield { type: "content_block_start", index, content_block: block };

    if (block.type === "text") {
      if (block.text) {
        yield {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: block.text },
        };
      }
    } else if (block.type === "tool_use") {
      const json = JSON.stringify(block.input ?? {});
      yield {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: json },
      };
    }

    yield { type: "content_block_stop", index };
  }

  yield {
    type: "message_delta",
    delta: { stop_reason: response.stopReason },
    usage: response.usage,
  };
  yield { type: "message_stop" };
}

/**
 * 带降级能力的流式请求。
 * 流式失败且为传输错误时，自动降级到 provider.sendMessageNonStreaming。
 *
 * 注意：流式错误既可能以 throw 抛出，也可能以 { type:"error" } 事件透传。
 * 两种形态都会被识别并按传输错误判定是否降级。
 */
export async function* streamWithFallback(
  provider: Provider,
  params: SendParams,
  config: StreamHandlerConfig = {},
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const allowFallback = config.allowNonStreamingFallback ?? true;
  const log = getLogger();

  // 已 yield 过内容则不能降级（会导致重复内容）；记录是否已开始输出
  let yieldedContent = false;
  let transportError: unknown | undefined;

  try {
    for await (const event of provider.sendMessageStream(params, signal)) {
      // error 事件：判定是否传输错误
      if (event.type === "error") {
        if (!yieldedContent && allowFallback && isStreamingTransportError(new Error(event.error.message))) {
          transportError = new Error(event.error.message);
          break; // 跳出去走降级
        }
        yield event; // 非传输错误或已输出内容，原样透传
        return;
      }
      if (event.type === "content_block_delta") yieldedContent = true;
      yield event;
    }
  } catch (streamError) {
    if (signal?.aborted) throw streamError;
    if (!allowFallback || yieldedContent || !isStreamingTransportError(streamError)) {
      throw streamError;
    }
    transportError = streamError;
  }

  if (transportError === undefined) return; // 流式正常完成

  // ── 降级到非流式 ──
  if (!provider.sendMessageNonStreaming) {
    log.warn("STREAM", "流式传输失败且 Provider 不支持非流式降级", {
      error: getErrorMessage(transportError),
    });
    throw transportError;
  }

  const nonStreamMaxTokens = Math.min(
    params.maxTokens,
    config.nonStreamingMaxTokens ?? DEFAULT_NON_STREAMING_MAX_TOKENS,
  );
  log.warn("STREAM", "流式请求失败，降级到非流式", {
    error: getErrorMessage(transportError),
    maxTokens: nonStreamMaxTokens,
  });

  const result = await provider.sendMessageNonStreaming(
    { ...params, maxTokens: nonStreamMaxTokens },
    signal,
  );
  yield* convertToStreamEvents(result);
}
