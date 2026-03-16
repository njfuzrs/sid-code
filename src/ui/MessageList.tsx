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
  /** 终端宽度（用于分隔线），由父组件传入 */
  termWidth?: number;
  /** 从底部往上滚动的消息偏移量，0=显示最新（默认） */
  scrollOffset?: number;
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

/** 构建 tool_use_id → toolName 映射 */
function buildToolNameMap(message: Message, prevMessage?: Message): Map<string, string> {
  const map = new Map<string, string>();
  // 从前一条助手消息中收集 tool_use 块（tool_result 在用户消息中，对应的 tool_use 在前一条助手消息）
  const sourceMsg = message.role === "user" ? prevMessage : message;
  if (sourceMsg) {
    for (const block of sourceMsg.content) {
      if (block.type === "tool_use") {
        map.set(block.id, block.name);
      }
    }
  }
  // 也从当前消息中收集（助手消息可能同时包含 tool_use）
  for (const block of message.content) {
    if (block.type === "tool_use") {
      map.set(block.id, block.name);
    }
  }
  return map;
}

/** 渲染单个内容块 */
function renderBlock(block: ContentBlock, idx: number, toolNameMap: Map<string, string>): React.ReactNode {
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
      <Box key={key} paddingLeft={2}>
        <Text color="yellow">{"● "}</Text>
        <Text bold>{block.name}</Text>
        {summary ? <Text dimColor>{"  "}{summary}</Text> : null}
      </Box>
    );
  }

  if (block.type === "tool_result") {
    const isErr = !!block.is_error;
    const icon = isErr ? "✗" : "✓";
    const color = isErr ? "red" : "green";
    const toolName = toolNameMap.get(block.tool_use_id) || "";
    const summary = getResultSummary(toolName, block.content, isErr);
    return (
      <Box key={key} paddingLeft={2}>
        <Text color={color}>{icon} </Text>
        <Text bold>{toolName}</Text>
        <Text dimColor>{"  "}{summary}</Text>
      </Box>
    );
  }

  return null;
}

/** 渲染单条消息 */
function MessageItem({ message, prevMessage }: { message: Message; prevMessage?: Message }) {
  const isUser = message.role === "user";
  const toolNameMap = buildToolNameMap(message, prevMessage);

  // 纯 tool_result 消息（用户角色但只包含工具结果）——保持缩进样式，不显示角色标签
  const hasOnlyToolResults = message.content.every((b) => b.type === "tool_result");
  if (isUser && hasOnlyToolResults) {
    return (
      <Box flexDirection="column" flexShrink={0}>
        {message.content.map((block, idx) => renderBlock(block, idx, toolNameMap))}
      </Box>
    );
  }

  // 用户消息：边框包裹
  if (isUser) {
    return (
      <Box flexDirection="column" flexShrink={0} borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">你</Text>
        {message.content.map((block, idx) => renderBlock(block, idx, toolNameMap))}
      </Box>
    );
  }

  // 助手消息：无边框
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text bold color="green">助手</Text>
      {message.content.map((block, idx) => renderBlock(block, idx, toolNameMap))}
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

/** 粗略估算一条消息占用的终端行数 */
function estimateMessageLines(msg: Message, contentWidth: number): number {
  const isUser = msg.role === "user";
  const hasOnlyToolResults = msg.content.every((b) => b.type === "tool_result");
  let lines = 0;

  // 角色标签行（纯 tool_result 消息没有标签）
  if (!(isUser && hasOnlyToolResults)) {
    lines += 1;
  }

  // 用户消息边框（上 + 下各 1 行）
  if (isUser && !hasOnlyToolResults) {
    lines += 2;
  }

  for (const block of msg.content) {
    if (block.type === "text") {
      // 按换行符分割，每行按终端宽度估算折行
      for (const line of block.text.split("\n")) {
        lines += Math.max(1, Math.ceil((line.length || 1) / contentWidth));
      }
    } else {
      // tool_use / tool_result 各占 1 行
      lines += 1;
    }
  }

  return Math.max(1, lines);
}

export function MessageList({ messages, streamingText, height, termWidth, scrollOffset = 0 }: MessageListProps) {
  const log = getLogger();
  const renderCountRef = useRef(0);
  renderCountRef.current++;

  if (renderCountRef.current % 20 === 1) {
    log.debug("UI:MSGLIST", `渲染 #${renderCountRef.current}`, {
      messagesLen: messages.length,
      streamingTextLen: streamingText.length,
      scrollOffset,
    });
  }

  const isEmpty = messages.length === 0 && !streamingText;
  const tw = termWidth || 80;

  // 如果有流式文本，排除最后一条助手消息（它的内容正在被流式文本区域显示）
  let displayMessages = messages;
  if (streamingText && messages.length > 0) {
    const last = messages[messages.length - 1];
    if (last && last.role === "assistant") {
      displayMessages = messages.slice(0, -1);
    }
  }

  // 分隔线宽度
  const sepWidth = Math.max(10, tw - 4);
  const separator = "── ".repeat(Math.floor(sepWidth / 3));

  const availableHeight = height || 999;
  const contentWidth = Math.max(20, tw - 6);

  // 滚动窗口计算：
  // 1. scrollOffset 表示从底部跳过多少条消息
  // 2. 截掉尾部 scrollOffset 条消息后，从剩余消息的末尾往前填充 availableHeight
  const clampedOffset = Math.min(scrollOffset, Math.max(0, displayMessages.length - 1));
  const endIdx = displayMessages.length - clampedOffset;
  const windowMessages = displayMessages.slice(0, endIdx);

  // 是否有被滚动跳过的更新消息（底部还有内容）
  const hasMoreBelow = clampedOffset > 0;
  // 流式文本：仅在 scrollOffset=0 时显示（滚动中隐藏流式文本）
  const showStreaming = streamingText && !hasMoreBelow;

  // 预留行数：滚动提示占 1 行，流式文本占 N 行
  let reservedLines = 0;
  if (hasMoreBelow) reservedLines += 1; // 底部提示
  if (showStreaming) reservedLines += 2 + streamingText.split("\n").length;

  // 从后往前计算能放进可用高度的消息
  let usedLines = reservedLines;
  let sliceStart = windowMessages.length;

  for (let i = windowMessages.length - 1; i >= 0; i--) {
    const msg = windowMessages[i];
    const msgLines = estimateMessageLines(msg, contentWidth);
    const hasSep = i > 0 && msg.role === "user"
      && !msg.content.every((b) => b.type === "tool_result");
    const sepLine = hasSep ? 1 : 0;

    if (usedLines + msgLines + sepLine > availableHeight) break;
    usedLines += msgLines + sepLine;
    sliceStart = i;
  }

  const visibleMessages = windowMessages.slice(sliceStart);
  // 视口上方还有更早的消息
  const hasMoreAbove = sliceStart > 0;

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
            {`   _____ _     _     _____          _
  / ____(_)   | |   / ____|        | |
 | (___  _  __| |  | |     ___   __| | ___
  \\___ \\| |/ _\` |  | |    / _ \\ / _\` |/ _ \\
  ____) | | (_| |  | |___| (_) | (_| |  __/
 |_____/|_|\\__,_|   \\_____\\___/ \\__,_|\\___|`}
          </Text>
          <Box marginTop={1}>
            <Text dimColor>输入消息开始对话，或输入 /help 查看可用命令</Text>
          </Box>
        </Box>
      ) : (
        <>
          {/* 顶部滚动提示 */}
          {hasMoreAbove && (
            <Box flexShrink={0} paddingX={1}>
              <Text dimColor>{"↑ PageUp 查看更早的消息 (" + sliceStart + " 条被折叠)"}</Text>
            </Box>
          )}

          {visibleMessages.map((msg, idx) => {
            const globalIdx = sliceStart + idx;
            const showSeparator = globalIdx > 0 && msg.role === "user"
              && !msg.content.every((b) => b.type === "tool_result");
            const prevMessage = globalIdx > 0 ? windowMessages[globalIdx - 1] : undefined;
            return (
              <React.Fragment key={getMessageKey(msg, globalIdx)}>
                {showSeparator && (
                  <Box flexShrink={0} paddingX={1}>
                    <Text dimColor>{separator}</Text>
                  </Box>
                )}
                <MessageItem message={msg} prevMessage={prevMessage} />
              </React.Fragment>
            );
          })}

          {/* 流式文本（仅在底部时显示） */}
          {showStreaming && (
            <Box flexDirection="column" flexShrink={0}>
              <Box>
                <Text bold color="green">{"助手 "}</Text>
                <Text color="green">●</Text>
              </Box>
              <Text>{renderMarkdown(streamingText)}</Text>
            </Box>
          )}

          {/* 底部滚动提示 */}
          {hasMoreBelow && (
            <Box flexShrink={0} paddingX={1}>
              <Text dimColor>{"↓ PageDown 查看更新的消息 (" + clampedOffset + " 条)"}</Text>
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
