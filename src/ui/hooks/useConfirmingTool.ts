/**
 * useConfirmingTool Hook
 *
 * 从 HistoryItem 列表中提取当前需要确认的工具调用。
 * 返回确认队列的"头部"（第一个 confirming 状态的工具）。
 *
 * 参考 gemini-cli useConfirmingTool.ts
 */

import { useMemo } from "react";
import type { HistoryItem, IndividualToolCallDisplay } from "../types.ts";
import { ToolCallStatus } from "../types.ts";

/** 确认中的工具状态 */
export interface ConfirmingToolState {
  /** 工具调用信息 */
  tool: IndividualToolCallDisplay;
  /** 在确认队列中的索引（从 1 开始） */
  index: number;
  /** 确认队列总数 */
  total: number;
}

/**
 * 从 HistoryItem 列表中提取所有 confirming 状态的工具
 */
function getConfirmingTools(items: HistoryItem[]): IndividualToolCallDisplay[] {
  const confirming: IndividualToolCallDisplay[] = [];

  for (const item of items) {
    if (item.type === "tool_group") {
      for (const tool of item.tools) {
        if (tool.status === ToolCallStatus.Confirming) {
          confirming.push(tool);
        }
      }
    }
  }

  return confirming;
}

/**
 * 获取确认队列的头部
 */
export function getConfirmingToolState(
  items: HistoryItem[],
): ConfirmingToolState | null {
  const confirming = getConfirmingTools(items);
  if (confirming.length === 0) return null;

  return {
    tool: confirming[0],
    index: 1,
    total: confirming.length,
  };
}

/**
 * Hook：选择确认队列的"头部"
 * 返回第一个需要确认的工具，或 null
 */
export function useConfirmingTool(
  historyItems: HistoryItem[],
): ConfirmingToolState | null {
  return useMemo(
    () => getConfirmingToolState(historyItems),
    [historyItems],
  );
}
