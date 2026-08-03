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
  /**
   * S4：流式**正常结束但零内容**时是否也降级（默认 false，保持旧语义）。
   *
   * 场景（§5 缺口 5）：网关把非 SSE 的错误页 / 空 body 回成 200，provider 解析出
   * 0 个事件、不抛错也不产出 error 事件。此时"流式"这条路是通的、只是没内容，
   * 传输错误判据（`isStreamingTransportError`）永远命中不了，于是漏斗只能判
   * "响应为空" → 白重试 N 次 → 每次都同样空。非流式请求恰好能穿过这类网关。
   *
   * 安全性：仅在**下游一个块都没收到**时才降级（见 `yieldedAnyBlock`），
   * 所以重放不可能产生重复内容。
   */
  degradeOnEmptyStream?: boolean;
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
  /**
   * S4：是否向下游 yield 过**任何** content block（含 `content_block_start`）。
   *
   * 与 `yieldedContent` 的分工：后者只认 delta，是"传输错误能否降级"的判据
   * （已有文本流出去了，重放会重复）；本标志更严，用于空流降级的安全闸门——
   * 无参数工具调用只有 start+stop、零 delta，若拿 `yieldedContent` 判空流降级，
   * 会把一次**成功的**无参工具调用重放一遍（漏斗 B2 修过同型误判）。
   */
  let yieldedAnyBlock = false;
  let transportError: unknown | undefined;
  /** S4：流式正常结束却零内容（网关回非 SSE 错误页/空 body 的典型形态）。 */
  let emptyStream = false;

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
      if (event.type === "content_block_delta" || event.type === "content_block_start") {
        yieldedAnyBlock = true;
      }
      yield event;
    }
    // S4：流跑完了、没抛错、也没有 error 事件，但一个内容块都没有。
    // 只在开关显式打开且确实零块时才降级——否则保持旧语义原样返回。
    if (!yieldedAnyBlock && allowFallback && config.degradeOnEmptyStream) {
      emptyStream = true;
    }
  } catch (streamError) {
    if (signal?.aborted) throw streamError;
    if (!allowFallback || yieldedContent || !isStreamingTransportError(streamError)) {
      throw streamError;
    }
    transportError = streamError;
  }

  if (transportError === undefined && !emptyStream) return; // 流式正常完成

  // ── 降级到非流式 ──
  /** 降级成因，供日志与"无非流式能力"时的兜底抛错使用。 */
  const trigger = emptyStream ? "流式正常结束但零内容块" : getErrorMessage(transportError);

  if (!provider.sendMessageNonStreaming) {
    log.warn("STREAM", "流式传输失败且 Provider 不支持非流式降级", { error: trigger });
    // 空流路径没有 transportError（`throw undefined` 会把 catch 方的 err 变成 undefined，
    // 上游一切按 message 取值的代码全部拿到 undefined —— 比不降级更难排查）。
    throw emptyStream
      ? new Error("流式响应为空且 Provider 不支持非流式降级")
      : transportError;
  }

  const nonStreamMaxTokens = Math.min(
    params.maxTokens,
    config.nonStreamingMaxTokens ?? DEFAULT_NON_STREAMING_MAX_TOKENS,
  );
  log.warn("STREAM", "流式请求失败，降级到非流式", {
    error: trigger,
    maxTokens: nonStreamMaxTokens,
  });

  const result = await provider.sendMessageNonStreaming(
    { ...params, maxTokens: nonStreamMaxTokens },
    signal,
  );
  yield* convertToStreamEvents(result);
}
