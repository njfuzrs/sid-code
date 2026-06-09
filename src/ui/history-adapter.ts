/**
 * LLM Message → HistoryItem 适配层
 *
 * 在 agent loop 产出消息时将 LLM Message 转换为 HistoryItem，
 * 而非在渲染时解析。这样 UI 层只需按 type 字段 switch 分发即可。
 *
 * 核心设计：
 * - tool_use（assistant）和 tool_result（user）合并为单条 ToolGroup 记录
 * - 维护全局 toolNameMap 解决增量同步时 "unknown" 工具名问题
 */

import {
  type HistoryItem,
  type HistoryItemWithoutId,
  type IndividualToolCallDisplay,
  ToolCallStatus,
  type ToolResultDisplay,
} from "./types.ts";
import type { Message } from "../llm/types.ts";
import { getToolSummary, getResultSummary, isDiffContent, getFilenameFromInput } from "./ui-utils.ts";

/**
 * 构建主屏 Static 模式的历史项数组（ADR-040）。
 *
 * - 空历史 → 空数组（不插 header，让 EmptyLogo 显示）
 * - 非空 → 顶部插入一个 app_header，其后接全部已完成历史项
 *
 * 关键不变量：返回结果**绝不包含流式虚拟项**（STREAMING_ITEM_ID）。
 * 流式内容在 MainScreenLayout 动态区单独渲染，流式完成后才并入 historyItems，
 * 届时本函数才把它纳入 Static（保证一条消息要么在动态区要么在 Static，不重叠）。
 */
export function buildStaticItems(historyItems: HistoryItem[], version: string): HistoryItem[] {
  if (historyItems.length === 0) return [];
  return [
    { id: -2, type: "app_header", version } as HistoryItem,
    ...historyItems,
  ];
}

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
 * 从消息数组中构建 tool_use_id → toolName 映射
 * 用于增量同步时传入完整的映射关系
 */
export function buildToolNameMapFromMessages(msgs: Message[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of msgs) {
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        map.set(block.id, block.name);
      }
    }
  }
  return map;
}

/**
 * 将完整消息数组转换为 HistoryItem 序列
 *
 * 核心改进：合并 tool_use + tool_result 为单条记录
 * - assistant 消息中的 tool_use → 暂存到 pendingToolCalls
 * - user 消息中的 tool_result → 与 pending 合并，输出完整的 ToolGroup
 */
export function messagesToHistoryItems(msgs: Message[]): HistoryItemWithoutId[] {
  const toolNameMap = buildToolNameMapFromMessages(msgs);
  return messagesToHistoryItemsWithMap(msgs, toolNameMap);
}

/**
 * 带外部 toolNameMap 的转换（用于增量同步）
 */
export function messagesToHistoryItemsWithMap(
  msgs: Message[],
  toolNameMap: Map<string, string>,
): HistoryItemWithoutId[] {
  const items: HistoryItemWithoutId[] = [];
  // 暂存 assistant 消息中的 tool_use，等待 tool_result 合并
  const pendingToolCalls = new Map<string, IndividualToolCallDisplay>();

  for (const msg of msgs) {
    if (isPlaceholderMessage(msg)) continue;

    // 收集 tool_use 名称映射
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        toolNameMap.set(block.id, block.name);
      }
    }

    if (msg.role === "assistant") {
      items.push(...convertAssistantMessage(msg, pendingToolCalls));
    } else {
      items.push(...convertUserMessage(msg, toolNameMap, pendingToolCalls));
    }
  }

  // 如果还有未匹配的 pending tool_use（流式中断等场景），输出为 executing 状态
  if (pendingToolCalls.size > 0) {
    items.push({ type: "tool_group", tools: Array.from(pendingToolCalls.values()) });
    pendingToolCalls.clear();
  }

  return items;
}

// ── 内部转换函数 ──

function convertUserMessage(
  msg: Message,
  toolNameMap: Map<string, string>,
  pendingToolCalls: Map<string, IndividualToolCallDisplay>,
): HistoryItemWithoutId[] {
  const items: HistoryItemWithoutId[] = [];
  const textBlocks: string[] = [];
  const mergedTools: IndividualToolCallDisplay[] = [];

  for (const block of msg.content) {
    if (block.type === "text") {
      textBlocks.push(block.text);
    } else if (block.type === "tool_result") {
      const toolName = toolNameMap.get(block.tool_use_id) || "unknown";
      const isError = !!block.is_error;
      const pending = pendingToolCalls.get(block.tool_use_id);

      const resultDisplay: ToolResultDisplay = {
        content: block.content,
        isError,
        isDiff: isDiffContent(toolName, block.content),
        filename: getFilenameFromInput(toolName, pending?.input ?? {}),
      };

      // 合并 pending tool_use + tool_result
      mergedTools.push({
        callId: block.tool_use_id,
        name: pending?.name ?? toolName,
        description: pending?.description ?? getToolSummary(toolName, {}),
        input: pending?.input ?? {},
        status: isError ? ToolCallStatus.Error : ToolCallStatus.Success,
        resultDisplay,
        resultSummary: getResultSummary(toolName, block.content, isError),
      });

      // 已合并，从 pending 中移除
      pendingToolCalls.delete(block.tool_use_id);
    }
  }

  // 文本内容 → HistoryItemUser
  if (textBlocks.length > 0) {
    const text = textBlocks.join("\n");
    items.push({ type: "user", text });
  }

  // 合并后的工具结果 → HistoryItemToolGroup
  if (mergedTools.length > 0) {
    items.push({ type: "tool_group", tools: mergedTools });
  }

  return items;
}

function convertAssistantMessage(
  msg: Message,
  pendingToolCalls: Map<string, IndividualToolCallDisplay>,
): HistoryItemWithoutId[] {
  const items: HistoryItemWithoutId[] = [];
  let textAccum = "";

  const flushText = () => {
    if (textAccum) {
      items.push({ type: "assistant", text: textAccum });
      textAccum = "";
    }
  };

  for (const block of msg.content) {
    if (block.type === "thinking") {
      // v2：思考块 → 独立 thinking HistoryItem（对标 Claude Code）
      flushText();
      items.push({
        type: "thinking",
        thought: { text: block.thinking },
      });
    } else if (block.type === "text") {
      flushText(); // 先 flush 前面的文本（如果有的话）
      textAccum += (textAccum ? "\n" : "") + block.text;
    } else if (block.type === "tool_use") {
      flushText();
      // 暂存到 pendingToolCalls，等待 tool_result 合并
      pendingToolCalls.set(block.id, {
        callId: block.id,
        name: block.name,
        description: getToolSummary(block.name, block.input),
        input: block.input,
        status: ToolCallStatus.Executing,
      });
    }
  }

  // flush 剩余文本
  flushText();

  // 注意：不在这里输出 tool_use 的 ToolGroup
  // 它们会在 convertUserMessage 中与 tool_result 合并后输出

  return items;
}
