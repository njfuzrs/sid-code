/**
 * 消息转换器：QueryEngineEvent → SDKMessage
 *
 * 将内部事件流转换为标准化 SDK 消息协议。
 * 返回 null 表示该事件不转发给 SDK 调用者（内部控制信号）。
 *
 * 映射关系见 spec §3.6 / §4.4。done 与 max_turns 的 result 消息中
 * 部分字段（result 文本 / duration_api_ms）由 SDKQueryEngine 在合成时补齐，
 * 这里给出结构骨架。
 */

import type { QueryEngineEvent } from "../query/types.ts";
import type { SDKMessage } from "./types.ts";
import type { Usage } from "../llm/types.ts";

export interface ConvertContext {
  sessionId: string;
  totalUsage: Usage;
  startTime: number;
  turnCount: number;
  totalCostUsd: number;
  /** 单调时钟（可注入，便于测试）；默认 Date.now */
  now?: () => number;
  /** UUID 生成（可注入，便于测试）；默认 crypto.randomUUID */
  uuid?: () => string;
}

function nowOf(ctx: ConvertContext): number {
  return (ctx.now ?? Date.now)();
}

function uuidOf(ctx: ConvertContext): string {
  return (ctx.uuid ?? (() => crypto.randomUUID()))();
}

/**
 * 将 QueryEngineEvent 转换为 SDKMessage
 * @returns SDKMessage 或 null（不转发）
 */
export function convertToSDKMessage(
  event: QueryEngineEvent,
  ctx: ConvertContext,
): SDKMessage | null {
  switch (event.kind) {
    case "user_message_added":
      // 用户消息由 SDKQueryEngine 在添加时直接 yield，这里不重复
      return null;

    case "assistant_message":
      return {
        type: "assistant",
        uuid: uuidOf(ctx),
        session_id: ctx.sessionId,
        message: event.message,
        stop_reason: null,
        usage: { ...ctx.totalUsage },
      };

    case "stream_text":
      return {
        type: "stream_event",
        event: { type: "content_block_delta", text: event.text },
      };

    case "tool_start":
      return {
        type: "tool_progress",
        tool_name: event.toolName,
        status: "start",
        input: event.toolInput,
      };

    case "tool_end":
      return {
        type: "tool_progress",
        tool_name: event.toolName,
        status: "end",
        result: event.result
          ? {
              is_error: event.result.isError,
              elapsed_ms: event.result.elapsedMs,
            }
          : undefined,
      };

    case "compact":
      return {
        type: "system",
        subtype: "compact_boundary",
      };

    case "context_warning":
      return {
        type: "system",
        subtype: "status",
        message: `上下文剩余 ${event.remaining}%`,
      };

    case "max_turns":
      return {
        type: "result",
        subtype: "error_max_turns",
        errors: [`达到最大轮次限制: ${event.maxTurns}`],
        duration_ms: nowOf(ctx) - ctx.startTime,
        num_turns: ctx.turnCount,
        total_cost_usd: ctx.totalCostUsd,
        usage: { ...ctx.totalUsage },
        session_id: ctx.sessionId,
      };

    case "done":
      return {
        type: "result",
        subtype: "success",
        duration_ms: nowOf(ctx) - ctx.startTime,
        duration_api_ms: 0, // 由 SDKQueryEngine 用 SessionState 补齐
        is_error: false,
        num_turns: event.turns,
        result: "", // 由 SDKQueryEngine 填充最终文本
        stop_reason: "end_turn",
        total_cost_usd: ctx.totalCostUsd,
        usage: { ...ctx.totalUsage },
        session_id: ctx.sessionId,
      };

    case "hook_blocked":
      return {
        type: "system",
        subtype: "hook_response",
        hook_event: "user_prompt_submit",
        decision: event.reason,
      };

    case "loop_detected":
      return {
        type: "system",
        subtype: "status",
        message: `循环检测: ${event.detail}`,
      };

    case "loop_recovery":
      return {
        type: "system",
        subtype: "status",
        message: `循环恢复尝试 ${event.attempt}/${event.maxAttempts}`,
      };

    case "system":
      return {
        type: "system",
        subtype: "status",
        message: event.text,
      };

    case "tombstone":
      return null; // 内部控制信号，不转发

    default:
      return null;
  }
}
