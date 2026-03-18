/**
 * 消息渲染组件
 * 导出 MessageItem 供 Static 组件使用，每条消息独立渲染
 */

import React from "react";
import { Box, Text } from "ink";
import type { Message, ContentBlock } from "../llm/types.ts";
import { renderMarkdown } from "./markdown.ts";

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

/** 从工具输入中提取参数摘要 */
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
  if (lower.startsWith("subagent") || lower.startsWith("agent__") || lower.startsWith("skill__")) {
    const agentType = inp?.type || inp?.agentType || "";
    const prompt = inp?.prompt || inp?.task || "";
    const short = prompt.length > 30 ? prompt.slice(0, 27) + "..." : prompt;
    return agentType ? `${agentType} "${short}"` : short;
  }
  return "";
}

/** 从工具结果中提取结果摘要 */
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
  const sourceMsg = message.role === "user" ? prevMessage : message;
  if (sourceMsg) {
    for (const block of sourceMsg.content) {
      if (block.type === "tool_use") {
        map.set(block.id, block.name);
      }
    }
  }
  for (const block of message.content) {
    if (block.type === "tool_use") {
      map.set(block.id, block.name);
    }
  }
  return map;
}

/** 渲染单个内容块 */
function renderBlock(block: ContentBlock, idx: number, toolNameMap: Map<string, string>, maxWidth?: number): React.ReactNode {
  const key = getBlockKey(block, idx);

  if (block.type === "text") {
    const rendered = renderMarkdown(block.text, maxWidth);
    return <Text key={key}>{rendered}</Text>;
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

/** 渲染单条消息（供 Static 组件使用） */
export const MessageItem = React.memo(function MessageItem({ message, prevMessage, termWidth }: { message: Message; prevMessage?: Message; termWidth?: number }) {
  const isUser = message.role === "user";
  const toolNameMap = buildToolNameMap(message, prevMessage);
  const tw = termWidth || 80;

  // 纯 tool_result 消息——无角色标签
  const hasOnlyToolResults = message.content.every((b) => b.type === "tool_result");
  if (isUser && hasOnlyToolResults) {
    return (
      <Box flexDirection="column" width={tw}>
        {message.content.map((block, idx) => renderBlock(block, idx, toolNameMap, tw))}
      </Box>
    );
  }

  // 用户消息：右对齐，圆角气泡
  if (isUser) {
    return (
      <Box width={tw} justifyContent="flex-end">
        <Box flexDirection="column" borderStyle="round" borderColor="blueBright" paddingX={1} paddingY={0}>
          {message.content.map((block, idx) => {
            const key = getBlockKey(block, idx);
            if (block.type === "text") {
              return <Text key={key}>{block.text}</Text>;
            }
            return renderBlock(block, idx, toolNameMap);
          })}
        </Box>
      </Box>
    );
  }

  // 助手消息：左对齐，paddingRight=10 所以可用宽度要减去
  const ASSISTANT_PADDING_RIGHT = 10;
  return (
    <Box flexDirection="column" paddingRight={ASSISTANT_PADDING_RIGHT}>
      {message.content.map((block, idx) => renderBlock(block, idx, toolNameMap, tw - ASSISTANT_PADDING_RIGHT))}
    </Box>
  );
});

/** 系统消息组件（命令输出等，居中灰色圆角气泡） */
export const SystemItem = React.memo(function SystemItem({ text, termWidth }: { text: string; termWidth?: number }) {
  const tw = termWidth || 80;
  return (
    <Box width={tw} justifyContent="center">
      <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
        <Text>{text}</Text>
      </Box>
    </Box>
  );
});
