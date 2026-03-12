/**
 * 消息列表组件
 * 渲染用户/助手/工具消息，支持 Markdown 渲染
 */

import React from "react";
import { Box, Text, Static } from "ink";
import type { Message, ContentBlock } from "../llm/types.ts";
import { renderMarkdown } from "./markdown.ts";

interface MessageListProps {
  messages: Message[];
  streamingText: string;
}

/** 生成内容块的唯一 key */
function getBlockKey(block: ContentBlock, idx: number): string {
  if (block.type === "text") {
    // 使用文本内容的前 50 个字符作为 key 的一部分
    const preview = block.text.slice(0, 50);
    return `text-${idx}-${preview.length}`;
  }
  if (block.type === "tool_use") {
    return `tool-${block.id}`;
  }
  if (block.type === "tool_result") {
    return `result-${block.tool_use_id}`;
  }
  return `unknown-${idx}`;
}

/** 渲染单个内容块 */
function renderBlock(block: ContentBlock, idx: number): React.ReactNode {
  const key = getBlockKey(block, idx);

  if (block.type === "text") {
    const rendered = renderMarkdown(block.text);
    return (
      <Text key={key}>{rendered}</Text>
    );
  }

  if (block.type === "tool_use") {
    return (
      <Box key={key} marginY={0}>
        <Text color="yellow">{"[工具调用: "}{block.name}{"]"}</Text>
      </Box>
    );
  }

  if (block.type === "tool_result") {
    const color = block.is_error ? "red" : "green";
    const prefix = block.is_error ? "工具错误" : "工具结果";
    const preview = block.content.length > 200
      ? block.content.slice(0, 200) + "..."
      : block.content;
    return (
      <Box key={key} marginY={0}>
        <Text color={color}>{"["}{prefix}{": "}{preview}{"]"}</Text>
      </Box>
    );
  }

  return null;
}

/** 渲染单条消息 */
function MessageItem({ message }: { message: Message }) {
  const isUser = message.role === "user";

  // 跳过纯 tool_result 消息（用户角色但只包含工具结果）
  const hasOnlyToolResults = message.content.every((b) => b.type === "tool_result");
  if (isUser && hasOnlyToolResults) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        {message.content.map((block, idx) => renderBlock(block, idx))}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={isUser ? "cyan" : "green"}>
        {isUser ? "你" : "助手"}
      </Text>
      {message.content.map((block, idx) => renderBlock(block, idx))}
    </Box>
  );
}

/** 生成消息的唯一 key */
function getMessageKey(msg: Message, idx: number): string {
  // 使用消息内容的哈希作为 key，避免使用索引
  const contentStr = msg.content.map((b) => {
    if (b.type === "text") return b.text;
    if (b.type === "tool_use") return `tool:${b.id}:${b.name}`;
    if (b.type === "tool_result") return `result:${b.tool_use_id}`;
    return "";
  }).join("|");

  // 简单哈希函数
  let hash = 0;
  for (let i = 0; i < contentStr.length; i++) {
    hash = ((hash << 5) - hash) + contentStr.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit integer
  }

  return `${msg.role}-${idx}-${hash}`;
}

export function MessageList({ messages, streamingText }: MessageListProps) {
  // 如果有流式文本，历史消息 = 除了最后一条助手消息的所有消息
  // 否则，历史消息 = 所有消息
  let historyMessages = messages;
  if (streamingText && messages.length > 0) {
    const last = messages[messages.length - 1];
    if (last && last.role === "assistant") {
      historyMessages = messages.slice(0, -1);
    }
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* 使用 Static 渲染历史消息，永久写入终端历史 */}
      <Static items={historyMessages}>
        {(msg, idx) => (
          <MessageItem key={getMessageKey(msg, idx)} message={msg} />
        )}
      </Static>

      {/* 动态渲染流式文本 */}
      {streamingText && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="green">助手</Text>
          <Text>{renderMarkdown(streamingText)}</Text>
        </Box>
      )}
    </Box>
  );
}
