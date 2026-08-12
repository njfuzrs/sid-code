/**
 * Bridge 消息协议 — 资格判断 + 格式化
 *
 * 将 Agent 循环产生的事件转换为 BridgeOutMessage，
 * 过滤掉不应发送给远程客户端的内部事件。
 */

import type { BridgeOutMessage } from "./types.ts";

/** 单调递增消息 id 生成器（避免 Math.random 碰撞） */
let messageSeq = 0;
export function nextMessageId(prefix = "msg"): string {
  return `${prefix}-${Date.now()}-${++messageSeq}`;
}

/** 格式化文本消息 */
export function formatTextMessage(text: string): BridgeOutMessage {
  return {
    type: "text",
    id: nextMessageId("text"),
    data: { text },
    timestamp: Date.now(),
  };
}

/** 格式化工具调用消息 */
export function formatToolUseMessage(toolName: string, input: unknown): BridgeOutMessage {
  return {
    type: "tool_use",
    id: nextMessageId("tool"),
    data: { toolName, input },
    timestamp: Date.now(),
  };
}

/** 格式化工具结果消息 */
export function formatToolResultMessage(
  toolName: string,
  output: string,
  isError?: boolean,
): BridgeOutMessage {
  return {
    type: "tool_result",
    id: nextMessageId("result"),
    data: { toolName, output, isError: !!isError },
    timestamp: Date.now(),
  };
}

/** 格式化状态消息 */
export function formatStatusMessage(
  status: string,
  extra?: Record<string, unknown>,
): BridgeOutMessage {
  return {
    type: "status",
    id: nextMessageId("status"),
    data: { status, ...extra },
    timestamp: Date.now(),
  };
}

/**
 * 判断一个 Agent 事件是否应发送给远程客户端。
 * 过滤内部调试事件，仅转发对用户有意义的事件。
 */
export function isEligibleForBridge(eventKind: string): boolean {
  const ELIGIBLE = new Set([
    "text",
    "text_delta",
    "tool_use",
    "tool_result",
    "turn_complete",
    "error",
  ]);
  return ELIGIBLE.has(eventKind);
}
