/**
 * 消息序列化 → 带元数据的完整 JSON
 *
 * 导出完整对话历史为结构化 JSON，保留所有字段（tool_use_id、thinking.signature 等），
 * 可用于新会话恢复上下文。
 * 支持 maxBytes 截断保护（剪贴板场景）。
 */

import type { Message, ContentBlock } from "../../../llm/types.ts";

export interface SerializeJsonOptions {
  sessionId: string;
  model: string;
  provider: string;
  cwd: string;
  sidCodeVersion: string;
  maxBytes?: number;
}

export interface ExportedConversation {
  meta: {
    version: 1;
    exportedAt: string;
    sessionId: string;
    model: string;
    provider: string;
    cwd: string;
    messageCount: number;
    sidCodeVersion: string;
  };
  messages: Message[];
}

/**
 * 将 Message[] 包装为带元数据的 JSON 字符串。
 * 超过 maxBytes 时分级压缩：先 trim 大 tool_result 内容，再截断旧消息。
 */
export function serializeToJson(messages: Message[], options: SerializeJsonOptions): string {
  const { maxBytes } = options;

  // 构建导出对象（剥离 structuredPatch 字段，仅 UI 渲染用）
  const cleanMessages = messages.map(stripUIOnlyFields);

  const exported: ExportedConversation = {
    meta: {
      version: 1,
      exportedAt: new Date().toISOString(),
      sessionId: options.sessionId,
      model: options.model,
      provider: options.provider,
      cwd: options.cwd,
      messageCount: cleanMessages.length,
      sidCodeVersion: options.sidCodeVersion,
    },
    messages: cleanMessages,
  };

  // 无截断限制：直接序列化
  if (!maxBytes) {
    return JSON.stringify(exported, null, 2);
  }

  // 第一次尝试：完整序列化
  let json = JSON.stringify(exported, null, 2);
  if (Buffer.byteLength(json, "utf-8") <= maxBytes) {
    return json;
  }

  // 第二级压缩：trim 大 tool_result 内容（>1KB 的替换为占位符）
  const trimmedMessages = cleanMessages.map(trimLargeToolResults);
  exported.messages = trimmedMessages;
  exported.meta.messageCount = trimmedMessages.length;
  json = JSON.stringify(exported, null, 2);
  if (Buffer.byteLength(json, "utf-8") <= maxBytes) {
    return json;
  }

  // 第三级压缩：从头部截断旧消息
  let start = 0;
  while (Buffer.byteLength(json, "utf-8") > maxBytes && start < trimmedMessages.length - 1) {
    start += Math.max(1, Math.floor((trimmedMessages.length - start) * 0.1));
    const sliced = trimmedMessages.slice(start);
    exported.messages = sliced;
    exported.meta.messageCount = sliced.length;
    (exported.meta as Record<string, unknown>).truncatedMessages = start;
    json = JSON.stringify(exported, null, 2);
  }

  return json;
}

/** 剥离 structuredPatch 等仅 UI 渲染用的字段 */
function stripUIOnlyFields(msg: Message): Message {
  const cleanContent = msg.content.map((block: ContentBlock) => {
    if (block.type === "tool_result" && "structuredPatch" in block) {
      const { structuredPatch: _, ...rest } = block;
      return rest as ContentBlock;
    }
    return block;
  });
  return { ...msg, content: cleanContent };
}

/** 压缩大 tool_result 内容（>1KB 替换为占位符） */
function trimLargeToolResults(msg: Message): Message {
  const trimmedContent = msg.content.map((block: ContentBlock) => {
    if (block.type === "tool_result" && block.content && block.content.length > 1024) {
      return {
        ...block,
        content: block.content.slice(0, 200) + "\n\n[...内容已省略，原始长度: " + block.content.length + " 字符]",
      };
    }
    return block;
  });
  return { ...msg, content: trimmedContent };
}
