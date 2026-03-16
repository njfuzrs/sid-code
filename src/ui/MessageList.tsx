/**
 * 消息列表组件
 * 渲染用户/助手/工具消息，支持 Markdown 渲染
 * 全屏模式：不使用 Static，通过 overflow hidden + 自动滚动实现
 */

import React, { useRef } from "react";
import { Box, Text } from "ink";
import type { Message, ContentBlock } from "../llm/types.ts";
import { renderMarkdown } from "./markdown.ts";
import { getLogger } from "../debug/logger.ts";

interface MessageListProps {
  messages: Message[];
  streamingText: string;
  /** 可用高度（行数），由父组件传入 */
  height?: number;
}

/** 生成内容块的唯一 key */
function getBlockKey(block: ContentBlock, idx: number): string {
  if (block.type === "text") {
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

/** 从工具输入中提取参数摘要（TUI 版本） */
function getToolSummary(name: string, input: unknown): string {
  const inp = input as any;
  const lower = name.toLowerCase();

  if (lower === "read") {
    const fp = inp?.file_path || inp?.filePath || "";
    const offset = inp?.offset;
    const limit = inp?.limit;
    let suffix = "";
    if (offset && limit) suffix = ` (行 ${offset}-${offset + limit})`;
    else if (limit) suffix = ` (前 ${limit} 行)`;
    return `${fp}${suffix}`;
  }
  if (lower === "edit") return inp?.file_path || inp?.filePath || "";
  if (lower === "write") return inp?.file_path || inp?.filePath || "";
  if (lower === "bash") {
    const cmd = inp?.command || "";
    return cmd.length > 50 ? cmd.slice(0, 47) + "..." : cmd;
  }
  if (lower === "grep") {
    const pattern = inp?.pattern || "";
    const glob = inp?.glob || "";
    return glob ? `"${pattern}" in ${glob}` : `"${pattern}"`;
  }
  if (lower === "glob") {
    const pattern = inp?.pattern || "";
    const path = inp?.path || "";
    return path ? `${pattern} in ${path}` : pattern;
  }
  // SubAgent / Skill
  if (lower.startsWith("subagent") || lower.startsWith("agent__") || lower.startsWith("skill__")) {
    const agentType = inp?.type || inp?.agentType || "";
    const prompt = inp?.prompt || inp?.task || "";
    const short = prompt.length > 30 ? prompt.slice(0, 27) + "..." : prompt;
    return agentType ? `${agentType} "${short}"` : short;
  }
  return "";
}

/** 从工具结果中提取结果摘要（TUI 版本） */
function getResultSummary(name: string, content: string, isError?: boolean): string {
  if (isError) {
    return content.length > 60 ? content.slice(0, 57) + "..." : content;
  }
  const lower = name.toLowerCase();
  if (lower === "read") {
    const lines = content.split("\n").length;
    return `${lines} 行`;
  }
  if (lower === "edit") return "替换完成";
  if (lower === "write") return `${content.length} 字符`;
  if (lower === "bash") {
    const lines = content.split("\n").length;
    return `${lines} 行输出`;
  }
  if (lower === "grep") {
    const lines = content.trim().split("\n").filter(l => l.length > 0).length;
    return `${lines} 个结果`;
  }
  if (lower === "glob") {
    const lines = content.trim().split("\n").filter(l => l.length > 0).length;
    return `${lines} 个文件`;
  }
  return `${content.length} 字符`;
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
    const summary = getToolSummary(block.name, block.input);
    return (
      <Box key={key} marginY={0}>
        <Text color="yellow">{"● "}{block.name}</Text>
        {summary ? <Text dimColor>{" "}{summary}</Text> : null}
      </Box>
    );
  }

  if (block.type === "tool_result") {
    const isErr = !!block.is_error;
    const icon = isErr ? "✗" : "✓";
    const color = isErr ? "red" : "green";
    const summary = getResultSummary("", block.content, isErr);
    return (
      <Box key={key} marginY={0}>
        <Text color={color}>{icon} </Text>
        <Text dimColor>{summary}</Text>
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
  const contentStr = msg.content.map((b) => {
    if (b.type === "text") return b.text;
    if (b.type === "tool_use") return `tool:${b.id}:${b.name}`;
    if (b.type === "tool_result") return `result:${b.tool_use_id}`;
    return "";
  }).join("|");

  let hash = 0;
  for (let i = 0; i < contentStr.length; i++) {
    hash = ((hash << 5) - hash) + contentStr.charCodeAt(i);
    hash = hash & hash;
  }

  return `${msg.role}-${idx}-${hash}`;
}

export function MessageList({ messages, streamingText, height }: MessageListProps) {
  const log = getLogger();
  const renderCountRef = useRef(0);
  renderCountRef.current++;

  if (renderCountRef.current % 20 === 1) {
    log.debug("UI:MSGLIST", `渲染 #${renderCountRef.current}`, {
      messagesLen: messages.length,
      streamingTextLen: streamingText.length,
    });
  }

  const isEmpty = messages.length === 0 && !streamingText;

  // 如果有流式文本，排除最后一条助手消息（它的内容正在被流式文本区域显示）
  let displayMessages = messages;
  if (streamingText && messages.length > 0) {
    const last = messages[messages.length - 1];
    if (last && last.role === "assistant") {
      displayMessages = messages.slice(0, -1);
    }
  }

  // 全屏模式：所有消息直接渲染，通过 Box overflow="hidden" + height 裁剪
  // Ink 的 Box 会自动从顶部裁剪超出部分，实现"滚动到底部"效果
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      overflow="hidden"
      {...(height ? { height } : {})}
    >
      {isEmpty ? (
        <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
          <Text color="blue" bold>
            {`   _____ _     _    _____          _
  / ____(_)   | |  / ____|        | |
 | (___  _  __| || |     ___   __| | ___
  \\___ \\| |/ _\` || |    / _ \\ / _\` |/ _ \\
  ____) | | (_| || |___| (_) | (_| |  __/
 |_____/|_|\\__,_| \\_____\\___/ \\__,_|\\___|`}
          </Text>
          <Box marginTop={1}>
            <Text dimColor>输入消息开始对话，或输入 /help 查看可用命令</Text>
          </Box>
        </Box>
      ) : (
        <>
          {displayMessages.map((msg, idx) => (
            <MessageItem key={getMessageKey(msg, idx)} message={msg} />
          ))}

          {/* 流式文本 */}
          {streamingText && (
            <Box flexDirection="column" marginBottom={1}>
              <Text bold color="green">助手</Text>
              <Text>{renderMarkdown(streamingText)}</Text>
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
