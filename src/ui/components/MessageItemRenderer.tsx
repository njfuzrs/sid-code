/**
 * 消息项渲染器（调度层）
 *
 * 接收 DisplayItem，根据消息类型分发到对应的专用子组件：
 * - system → 系统消息（内联渲染）
 * - command → UserMessage
 * - message/user（纯 tool_result）→ ToolGroupMessage
 * - message/user（含文本）→ UserMessage
 * - message/assistant → AssistantMessage + ToolGroupMessage
 *
 * React.memo() 避免不必要重渲染。
 */

import React from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import useStdout from "../../ink/_vendor/use-stdout.js";
import type { DisplayItem } from "../App.tsx";
import type { Message } from "../../llm/types.ts";
import { UserMessage } from "./messages/UserMessage.tsx";
import { AssistantMessage } from "./messages/AssistantMessage.tsx";
import { ToolGroupMessage, type ToolCallDisplay } from "./messages/ToolGroupMessage.tsx";
import { getToolSummary, getResultSummary } from "../ui-utils.ts";
import { DEFAULT_TERM_WIDTH } from "../markdown.ts";

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

/** 从消息内容块中提取工具调用显示数据 */
function extractToolCalls(message: Message, _toolNameMap: Map<string, string>): ToolCallDisplay[] {
  const toolUseMap = new Map<string, ToolCallDisplay>();

  // 先收集 tool_use
  for (const block of message.content) {
    if (block.type === "tool_use") {
      toolUseMap.set(block.id, {
        id: block.id,
        name: block.name,
        input: block.input,
        status: "executing",
      });
    }
  }

  return Array.from(toolUseMap.values());
}

/** 从 tool_result 消息中提取工具结果显示数据 */
function extractToolResults(message: Message, toolNameMap: Map<string, string>): ToolCallDisplay[] {
  const results: ToolCallDisplay[] = [];

  for (const block of message.content) {
    if (block.type === "tool_result") {
      const toolName = toolNameMap.get(block.tool_use_id) || "unknown";
      results.push({
        id: block.tool_use_id,
        name: toolName,
        input: {},
        status: block.is_error ? "error" : "success",
        result: block.content,
        isError: !!block.is_error,
      });
    }
  }

  return results;
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
  const termWidth = stdout.columns || DEFAULT_TERM_WIDTH;

  // ── 系统消息 ──
  if (item.kind === "system") {
    return (
      <Box justifyContent="center" paddingX={1}>
        <Text dimColor>{"── "}{item.text}{" ──"}</Text>
      </Box>
    );
  }

  // ── 命令消息 ──
  if (item.kind === "command") {
    return (
      <Box flexDirection="column">
        {prevItem && <Separator width={termWidth} />}
        <UserMessage text={item.input} width={termWidth} />
        {item.output ? (
          <Box paddingLeft={2}>
            <Text dimColor>{item.output}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  // ── 消息类型 ──
  const msg = item.message;
  const prevMsg = prevItem?.kind === "message" ? prevItem.message : undefined;
  const toolNameMap = buildToolNameMap(msg, prevMsg);

  // 纯 tool_result 消息 → ToolGroupMessage
  const hasOnlyToolResults = msg.content.every(b => b.type === "tool_result");
  if (msg.role === "user" && hasOnlyToolResults) {
    const toolResults = extractToolResults(msg, toolNameMap);
    if (toolResults.length > 0) {
      return <ToolGroupMessage tools={toolResults} terminalWidth={termWidth} />;
    }
    return null;
  }

  // 用户消息（含文本内容）
  if (msg.role === "user") {
    const textBlocks = msg.content.filter(b => b.type === "text");
    const text = textBlocks.map(b => b.type === "text" ? b.text : "").join("\n");
    return (
      <Box flexDirection="column">
        {prevItem && <Separator width={termWidth} />}
        <UserMessage text={text} width={termWidth} />
      </Box>
    );
  }

  // 助手消息 → 拆分为文本块 + 工具调用分组
  const toolCalls = extractToolCalls(msg, toolNameMap);
  const elements: React.ReactNode[] = [];

  let textAccum = "";
  for (const block of msg.content) {
    if (block.type === "text") {
      textAccum += (textAccum ? "\n" : "") + block.text;
    } else {
      // 遇到非文本块，先输出累积的文本
      if (textAccum) {
        elements.push(
          <AssistantMessage key={`text-${elements.length}`} text={textAccum} width={termWidth} />
        );
        textAccum = "";
      }
    }
  }
  // 输出剩余文本
  if (textAccum) {
    elements.push(
      <AssistantMessage key={`text-${elements.length}`} text={textAccum} width={termWidth} />
    );
  }

  // 工具调用分组
  if (toolCalls.length > 0) {
    elements.push(
      <ToolGroupMessage key="tool-group" tools={toolCalls} terminalWidth={termWidth} />
    );
  }

  return (
    <Box flexDirection="column">
      {elements}
    </Box>
  );
});
