/**
 * 消息列表组件
 * 渲染用户/助手/工具消息，支持 Markdown 渲染
 */

import React from "react";
import { Box, Text } from "ink";
import type { Message, ContentBlock } from "../llm/types.ts";
import { renderMarkdown } from "./markdown.ts";

interface MessageListProps {
  messages: Message[];
  streamingText: string;
}

/** 渲染单个内容块 */
function renderBlock(block: ContentBlock, idx: number): React.ReactNode {
  if (block.type === "text") {
    const rendered = renderMarkdown(block.text);
    return (
      <Text key={idx}>{rendered}</Text>
    );
  }

  if (block.type === "tool_use") {
    return (
      <Box key={idx} marginY={0}>
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
      <Box key={idx} marginY={0}>
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

export function MessageList({ messages, streamingText }: MessageListProps) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {messages.map((msg, idx) => (
        <MessageItem key={idx} message={msg} />
      ))}
      {streamingText && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="green">助手</Text>
          <Text>{renderMarkdown(streamingText)}</Text>
        </Box>
      )}
    </Box>
  );
}
