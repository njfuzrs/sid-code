/**
 * 会话中断检测与恢复
 *
 * 从持久化的消息历史恢复会话时，检测上一次运行是否在中途被中断：
 * - 过滤未解析的 tool_use（有 tool_use 但无对应 tool_result）—— 否则 API 报错
 * - 过滤空白助手消息
 * - 末尾是纯用户输入（无助手响应）→ 标记 interrupted_prompt，可自动续跑
 *
 * 对齐 Claude Code deserializeMessagesWithInterruptDetection（spec §5.4）。
 */

import type { Message } from "../llm/types.ts";

/** 中断状态 */
export type TurnInterruptionState =
  | { kind: "none" }
  | { kind: "interrupted_prompt"; message: Message };

/** 反序列化结果 */
export interface DeserializeResult {
  messages: Message[];
  turnInterruptionState: TurnInterruptionState;
}

/**
 * 反序列化消息并检测中断状态
 */
export function deserializeMessagesWithInterruptDetection(
  serializedMessages: Message[],
): DeserializeResult {
  if (serializedMessages.length === 0) {
    return { messages: [], turnInterruptionState: { kind: "none" } };
  }

  // 1. 收集所有 tool_result 的 tool_use_id
  const resolvedToolUseIds = new Set<string>();
  for (const msg of serializedMessages) {
    for (const block of msg.content) {
      if (block.type === "tool_result") {
        resolvedToolUseIds.add(block.tool_use_id);
      }
    }
  }

  // 2. 过滤消息
  const messages: Message[] = [];
  for (const msg of serializedMessages) {
    if (msg.role === "assistant") {
      // 过滤未解析的 tool_use
      const filteredContent = msg.content.filter((block) => {
        if (block.type === "tool_use") {
          return resolvedToolUseIds.has(block.id);
        }
        return true;
      });

      // 过滤空白助手消息
      if (filteredContent.length === 0) continue;

      messages.push({ ...msg, content: filteredContent });
    } else {
      messages.push(msg);
    }
  }

  // 3. 检测中断状态：末尾是纯用户输入（无 tool_result）→ 中断的提示词
  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.role === "user") {
    const hasToolResult = lastMessage.content.some(
      (b) => b.type === "tool_result",
    );
    if (!hasToolResult) {
      return {
        messages: messages.slice(0, -1),
        turnInterruptionState: {
          kind: "interrupted_prompt",
          message: lastMessage,
        },
      };
    }
  }

  return { messages, turnInterruptionState: { kind: "none" } };
}
