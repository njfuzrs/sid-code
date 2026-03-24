/**
 * LLM Message → HistoryItem 适配层
 *
 * 在 agent loop 产出消息时将 LLM Message 转换为 HistoryItem，
 * 而非在渲染时解析。这样 UI 层只需按 type 字段 switch 分发即可。
 */

import {
  type HistoryItemWithoutId,
  type IndividualToolCallDisplay,
  ToolCallStatus,
  type ToolResultDisplay,
} from "./types.ts";
import type { Message } from "../llm/types.ts";
import { getToolSummary, getResultSummary, isDiffContent, getFilenameFromInput } from "./ui-utils.ts";

/** 思考摘要（从 thinking block 提取） */
export interface ThoughtSummary {
  text: string;
}

/** 占位消息文本常量 */
const PLACEHOLDER_TEXT = "[系统] 自动插入占位消息以保持角色交替";

/** 判断是否为占位消息 */
export function isPlaceholderMessage(msg: Message): boolean {
  return msg.content.length === 1
    && msg.content[0].type === "text"
    && msg.content[0].text === PLACEHOLDER_TEXT;
}

/**
 * 将单条 LLM Message 转换为一组 HistoryItemWithoutId
 *
 * 一条 Message 可能产出多个 HistoryItem：
 * - assistant 消息中的文本 → HistoryItemAssistant
 * - assistant 消息中的 tool_use → 收集到 HistoryItemToolGroup
 * - user 消息中的纯文本 → HistoryItemUser
 * - user 消息中的 tool_result → 更新对应 ToolGroup 的结果
 */
export function messageToHistoryItems(
  msg: Message,
  toolNameMap: Map<string, string>,
): HistoryItemWithoutId[] {
  if (isPlaceholderMessage(msg)) return [];

  if (msg.role === "user") {
    return convertUserMessage(msg, toolNameMap);
  }
  return convertAssistantMessage(msg);
}

/**
 * 将完整消息数组转换为 HistoryItem 序列
 *
 * 处理跨消息的 tool_use → tool_result 关联：
 * assistant 消息中的 tool_use 产出 ToolGroup（status=executing），
 * 紧随其后的 user 消息中的 tool_result 产出 ToolGroup（status=success/error）。
 */
export function messagesToHistoryItems(msgs: Message[]): HistoryItemWithoutId[] {
  const items: HistoryItemWithoutId[] = [];
  // 全局 tool_use_id → toolName 映射
  const toolNameMap = new Map<string, string>();

  for (const msg of msgs) {
    // 先收集 tool_use 名称映射
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        toolNameMap.set(block.id, block.name);
      }
    }
    items.push(...messageToHistoryItems(msg, toolNameMap));
  }

  return items;
}

// ── 内部转换函数 ──

function convertUserMessage(
  msg: Message,
  toolNameMap: Map<string, string>,
): HistoryItemWithoutId[] {
  const items: HistoryItemWithoutId[] = [];
  const textBlocks: string[] = [];
  const toolResults: IndividualToolCallDisplay[] = [];

  for (const block of msg.content) {
    if (block.type === "text") {
      textBlocks.push(block.text);
    } else if (block.type === "tool_result") {
      const toolName = toolNameMap.get(block.tool_use_id) || "unknown";
      const isError = !!block.is_error;
      const isDiff = isDiffContent(toolName, block.content);
      const filename = getFilenameFromInput(toolName, {});

      const resultDisplay: ToolResultDisplay = {
        content: block.content,
        isError,
        isDiff,
        filename,
      };

      toolResults.push({
        callId: block.tool_use_id,
        name: toolName,
        description: isError
          ? getResultSummary(toolName, block.content, true)
          : getResultSummary(toolName, block.content),
        input: {},
        status: isError ? ToolCallStatus.Error : ToolCallStatus.Success,
        resultDisplay,
      });
    }
  }

  // 文本内容 → HistoryItemUser
  if (textBlocks.length > 0) {
    const text = textBlocks.join("\n");
    items.push({ type: "user", text });
  }

  // 工具结果 → HistoryItemToolGroup
  if (toolResults.length > 0) {
    items.push({ type: "tool_group", tools: toolResults });
  }

  return items;
}

function convertAssistantMessage(msg: Message): HistoryItemWithoutId[] {
  const items: HistoryItemWithoutId[] = [];
  let pendingToolCalls: IndividualToolCallDisplay[] = [];
  let textAccum = "";

  const flushText = () => {
    if (textAccum) {
      items.push({ type: "assistant", text: textAccum });
      textAccum = "";
    }
  };

  const flushTools = () => {
    if (pendingToolCalls.length > 0) {
      items.push({ type: "tool_group", tools: pendingToolCalls });
      pendingToolCalls = [];
    }
  };

  for (const block of msg.content) {
    if (block.type === "text") {
      // 遇到文本，先 flush 待输出的工具调用
      flushTools();
      textAccum += (textAccum ? "\n" : "") + block.text;
    } else if (block.type === "tool_use") {
      // 遇到 tool_use，先 flush 累积的文本
      flushText();
      pendingToolCalls.push({
        callId: block.id,
        name: block.name,
        description: getToolSummary(block.name, block.input),
        input: block.input,
        status: ToolCallStatus.Executing,
      });
    }
  }

  // flush 剩余
  flushText();
  flushTools();

  return items;
}

