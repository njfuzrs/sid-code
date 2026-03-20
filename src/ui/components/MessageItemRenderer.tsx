/**
 * 消息项渲染器
 *
 * 接收 DisplayItem，渲染为 React 组件。
 * 文本块用 renderMarkdownToReact()，工具调用/结果用紧凑格式。
 * React.memo() 避免不必要重渲染。
 */

import React from "react";
import { Box, Text, useStdout } from "ink";
import type { DisplayItem } from "../App.tsx";
import type { Message, ContentBlock } from "../../llm/types.ts";
import { renderMarkdownToReact } from "../markdown.ts";
import { SlicingMaxSizedBox } from "./SlicingMaxSizedBox.tsx";
import { getToolSummary, getResultSummary, ASSISTANT_PADDING_RIGHT } from "../ui-utils.ts";
import { theme } from "../semantic-colors.ts";

/** 分隔线 */
function Separator({ width }: { width: number }) {
  const sepWidth = Math.max(10, width - 4);
  const sep = "── ".repeat(Math.floor(sepWidth / 3));
  return <Text dimColor>{sep}</Text>;
}

/** 构建 tool_use_id → toolName 映射 */
function buildToolNameMap(message: Message, prevMessage?: Message): Map<string, string> {
  const map = new Map<string, string>();
  const sourceMsg = message.role === "user" ? prevMessage : message;
  if (sourceMsg) {
    for (const block of sourceMsg.content) {
      if (block.type === "tool_use") map.set(block.id, block.name);
    }
  }
  for (const block of message.content) {
    if (block.type === "tool_use") map.set(block.id, block.name);
  }
  return map;
}

/** 渲染单个内容块 */
function RenderBlock({ block, toolNameMap, maxWidth }: {
  block: ContentBlock;
  toolNameMap: Map<string, string>;
  maxWidth: number;
}) {
  if (block.type === "text") {
    return <>{renderMarkdownToReact(block.text, maxWidth)}</>;
  }

  if (block.type === "tool_use") {
    const summary = getToolSummary(block.name, block.input);
    return (
      <Box paddingLeft={2}>
        <Text color={theme.status.warning}>{"● "}</Text>
        <Text bold>{block.name}</Text>
        {summary ? <Text dimColor>{"  "}{summary}</Text> : null}
      </Box>
    );
  }

  if (block.type === "tool_result") {
    const isErr = !!block.is_error;
    const icon = isErr ? "✗" : "✓";
    const color = isErr ? theme.status.error : theme.status.success;
    const toolName = toolNameMap.get(block.tool_use_id) || "";
    const summary = getResultSummary(toolName, block.content, isErr);

    // 长工具结果截断
    if (block.content.length > 500 && !isErr) {
      return (
        <Box flexDirection="column" paddingLeft={2}>
          <Box>
            <Text color={color}>{icon} </Text>
            <Text bold>{toolName}</Text>
            <Text dimColor>{"  "}{summary}</Text>
          </Box>
          <SlicingMaxSizedBox text={block.content} maxLines={20} overflowDirection="top" />
        </Box>
      );
    }

    return (
      <Box paddingLeft={2}>
        <Text color={color}>{icon} </Text>
        <Text bold>{toolName}</Text>
        <Text dimColor>{"  "}{summary}</Text>
      </Box>
    );
  }

  return null;
}

interface MessageItemRendererProps {
  item: DisplayItem;
  prevItem?: DisplayItem;
}

export const MessageItemRenderer = React.memo(function MessageItemRenderer({
  item,
  prevItem,
}: MessageItemRendererProps) {
  const { stdout } = useStdout();
  const termWidth = stdout.columns || 80;

  if (item.kind === "system") {
    return (
      <Box justifyContent="center" paddingX={1}>
        <Text dimColor>{"── "}{item.text}{" ──"}</Text>
      </Box>
    );
  }

  if (item.kind === "command") {
    return (
      <Box flexDirection="column">
        {prevItem && <Separator width={termWidth} />}
        <Text color={theme.ui.active} bold>{"● 你"}</Text>
        <Box paddingLeft={2}>
          <Text dimColor>{item.input}</Text>
        </Box>
        {item.output ? (
          <Box paddingLeft={2}>
            <Text dimColor>{item.output}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  // kind === "message"
  const msg = item.message;
  const prevMsg = prevItem?.kind === "message" ? prevItem.message : undefined;
  const toolNameMap = buildToolNameMap(msg, prevMsg);

  // 纯 tool_result 消息——无角色标签
  const hasOnlyToolResults = msg.content.every(b => b.type === "tool_result");
  if (msg.role === "user" && hasOnlyToolResults) {
    return (
      <Box flexDirection="column">
        {msg.content.map((block, idx) => (
          <RenderBlock key={idx} block={block} toolNameMap={toolNameMap} maxWidth={termWidth} />
        ))}
      </Box>
    );
  }

  // 用户消息（到达此处时一定包含非 tool_result 内容）
  if (msg.role === "user") {
    return (
      <Box flexDirection="column">
        {prevItem && <Separator width={termWidth} />}
        <Text color={theme.ui.active} bold>{"● 你"}</Text>
        {msg.content.map((block, idx) => {
          if (block.type === "text") {
            return <Box key={idx} paddingLeft={2}><Text>{block.text}</Text></Box>;
          }
          return <RenderBlock key={idx} block={block} toolNameMap={toolNameMap} maxWidth={termWidth} />;
        })}
      </Box>
    );
  }

  // 助手消息
  const contentWidth = termWidth - ASSISTANT_PADDING_RIGHT;
  return (
    <Box flexDirection="column" paddingRight={ASSISTANT_PADDING_RIGHT}>
      {msg.content.map((block, idx) => (
        <RenderBlock key={idx} block={block} toolNameMap={toolNameMap} maxWidth={contentWidth} />
      ))}
    </Box>
  );
});
