/**
 * 消息规范化（API 发送前）
 *
 * 职责（对标 Claude Code 的 normalizeMessagesForAPI）：
 * 1. tool_use/tool_result 配对修复（缺失的 tool_result 补占位，避免 API 400）
 * 2. 角色交替修复（合并相邻同角色消息）
 * 3. 媒体数量限制（单次请求最多 N 个，超出从最早消息移除）
 * 4. 空内容块清理
 *
 * 关键约束（spec §9.3 低风险）：只在 API 发送前规范化，返回新数组，
 * 不修改内存中的原始消息（深拷贝 content）。
 *
 * 注意：sid-code 的 ContentBlock 联合类型目前只有 text/tool_use/tool_result，
 * 媒体块（image/document）通过 type 字符串判定，保持前向兼容。
 */

import type { Message, ContentBlock, ToolUseBlock, ToolResultBlock } from "../llm/types.ts";

const INTERRUPTED_RESULT = "[工具执行被中断]";
const MEDIA_TYPES = new Set(["image", "document"]);

function isMedia(block: ContentBlock): boolean {
  return MEDIA_TYPES.has((block as { type: string }).type);
}

/** 深拷贝一条消息的 content（避免修改原始消息） */
function cloneMessage(msg: Message): Message {
  return { ...msg, content: [...msg.content] };
}

/**
 * 主入口：规范化消息序列。
 */
export function normalizeMessagesForAPI(
  messages: Message[],
  maxMedia = 100,
): Message[] {
  let result = messages.map(cloneMessage);
  result = ensureToolResultPairing(result);
  result = ensureAlternatingRoles(result);
  result = limitMediaCount(result, maxMedia);
  result = removeEmptyContentBlocks(result);
  return result;
}

/**
 * 确保每个 tool_use 都有对应的 tool_result。
 * assistant 含 tool_use 但下一条 user 缺对应 tool_result 时，补一个 error 占位。
 */
export function ensureToolResultPairing(messages: Message[]): Message[] {
  const result: Message[] = [];

  for (let i = 0; i < messages.length; i++) {
    result.push(messages[i]);

    if (messages[i].role !== "assistant") continue;

    const toolUseIds = messages[i].content
      .filter((b): b is ToolUseBlock => b.type === "tool_use")
      .map((b) => b.id);

    if (toolUseIds.length === 0) continue;

    const nextMsg = messages[i + 1];
    if (!nextMsg || nextMsg.role !== "user") {
      // 没有后续 user 消息，插入完整 tool_result 占位
      result.push({
        role: "user",
        content: toolUseIds.map((id) => ({
          type: "tool_result" as const,
          tool_use_id: id,
          content: INTERRUPTED_RESULT,
          is_error: true,
        })),
      });
      continue;
    }

    const existingResultIds = new Set(
      nextMsg.content
        .filter((b): b is ToolResultBlock => b.type === "tool_result")
        .map((b) => b.tool_use_id),
    );

    const missingIds = toolUseIds.filter((id) => !existingResultIds.has(id));
    if (missingIds.length > 0) {
      // 在下一条 user 消息开头补缺失的 tool_result
      nextMsg.content = [
        ...missingIds.map((id) => ({
          type: "tool_result" as const,
          tool_use_id: id,
          content: INTERRUPTED_RESULT,
          is_error: true,
        })),
        ...nextMsg.content,
      ];
    }
  }

  return result;
}

/**
 * 确保角色交替：合并相邻的同角色消息。
 * 注意：tool_result 必须留在 user 消息里，合并不会跨角色破坏配对。
 */
export function ensureAlternatingRoles(messages: Message[]): Message[] {
  const result: Message[] = [];
  for (const msg of messages) {
    const last = result[result.length - 1];
    if (last && last.role === msg.role) {
      // 合并 content（先 tool_result 后其它，保持 user 消息里 tool_result 在前）
      last.content = [...last.content, ...msg.content];
    } else {
      result.push(cloneMessage(msg));
    }
  }
  return result;
}

/**
 * 限制媒体项数量，超出从最早消息开始移除。
 */
export function limitMediaCount(messages: Message[], maxMedia: number): Message[] {
  let mediaCount = 0;
  for (const msg of messages) {
    for (const block of msg.content) {
      if (isMedia(block)) mediaCount++;
    }
  }
  if (mediaCount <= maxMedia) return messages;

  const result = messages.map(cloneMessage);
  let toRemove = mediaCount - maxMedia;
  for (const msg of result) {
    if (toRemove <= 0) break;
    msg.content = msg.content.filter((block) => {
      if (toRemove <= 0) return true;
      if (isMedia(block)) {
        toRemove--;
        return false;
      }
      return true;
    });
  }
  return result;
}

/**
 * 清理空内容块与空消息。
 * - 移除空文本块（text === ""）
 * - 移除清理后 content 为空的消息
 */
export function removeEmptyContentBlocks(messages: Message[]): Message[] {
  const result: Message[] = [];
  for (const msg of messages) {
    const content = msg.content.filter((block) => {
      if (block.type === "text") return block.text.trim().length > 0;
      return true;
    });
    if (content.length > 0) {
      result.push({ ...msg, content });
    }
  }
  return result;
}
