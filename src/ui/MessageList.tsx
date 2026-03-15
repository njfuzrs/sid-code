/**
 * 消息列表组件
 * 渲染用户/助手/工具消息，支持 Markdown 渲染
 */

import React, { useRef } from "react";
import { Box, Text, Static } from "ink";
import type { Message, ContentBlock } from "../llm/types.ts";
import { renderMarkdown } from "./markdown.ts";
import { getLogger } from "../debug/logger.ts";

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
    // 尝试从上下文中找到对应的 tool_use 块名称（通过 tool_use_id 匹配）
    // 这里简化处理，只显示结果摘要
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
  const log = getLogger();
  const renderCountRef = useRef(0);
  renderCountRef.current++;

  // 每 20 次渲染记录一次，避免日志爆炸
  if (renderCountRef.current % 20 === 1) {
    log.debug("UI:MSGLIST", `渲染 #${renderCountRef.current}`, {
      messagesLen: messages.length,
      streamingTextLen: streamingText.length,
    });
  }

  // 如果有流式文本，历史消息 = 除了最后一条助手消息的所有消息
  // 否则，历史消息 = 所有消息
  let historyMessages = messages;
  if (streamingText && messages.length > 0) {
    const last = messages[messages.length - 1];
    if (last && last.role === "assistant") {
      historyMessages = messages.slice(0, -1);
      log.debug("UI:MSGLIST", `流式模式: 历史消息 ${historyMessages.length} 条，排除最后一条助手消息`);
    } else {
      log.debug("UI:MSGLIST", `流式模式: 最后一条消息不是助手消息 (role=${last?.role})，不排除`);
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
