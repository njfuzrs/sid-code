/**
 * 主内容区域组件
 *
 * 使用 ScrollableList → VirtualizedList 实现虚拟化滚动
 * 支持 Copy Mode（Ctrl+S）进行文本选择
 *
 * 参考 gemini-cli/packages/cli/src/ui/components/MainContent.tsx
 */

import React, { useCallback, memo } from "react";
import Box from "../../ink/components/Box.js";
import { ScrollableList } from "./ScrollableList.tsx";
import { SCROLL_TO_ITEM_END } from "./VirtualizedList.tsx";
import { HistoryItemDisplay } from "./HistoryItemDisplay.tsx";
import { StreamingMessage } from "./StreamingMessage.tsx";
import { ThinkingMessage } from "./messages/ThinkingMessage.tsx";
import type { HistoryItem } from "../types.ts";

const STREAMING_ITEM_ID = -1;

interface MainContentProps {
  /** 完整数据列表（含流式虚拟项） */
  listData: HistoryItem[];
  /** 流式输出文本 */
  streamingText: string;
  /** v2：流式思考内容（独立于 streamingText） */
  streamingThinking: string;
  /** 是否正在流式输出 */
  isStreaming: boolean;
  /** 终端宽度 */
  termWidth: number;
  /** 是否有焦点（控制滚动） */
  hasFocus: boolean;
  /** 高度估算回调 */
  estimatedItemHeight: (index: number) => number;
  /** key 提取器 */
  keyExtractor: (item: HistoryItem, index: number) => string;
  /** Copy Mode：禁用 Ink 滚动，允许终端原生文本选择 */
  copyModeEnabled?: boolean;
  /** v2：思考块折叠状态 */
  thinkCollapsed?: boolean;
}

export const MainContent = memo(function MainContent({
  listData,
  streamingText,
  streamingThinking,
  isStreaming,
  termWidth,
  hasFocus,
  estimatedItemHeight,
  keyExtractor,
  copyModeEnabled,
  thinkCollapsed = false,
}: MainContentProps) {
  const renderListItem = useCallback(({ item, index }: { item: HistoryItem; index: number }) => {
    // 流式内容特殊项
    if (item.id === STREAMING_ITEM_ID) {
      return (
        <StreamingMessage
          fullText={streamingText}
          maxWidth={termWidth}
        />
      ) as React.ReactElement;
    }
    const prevItem = index > 0 ? listData[index - 1] : undefined;
    return (
      <HistoryItemDisplay
        item={item}
        prevItem={prevItem}
        terminalWidth={termWidth}
        thinkCollapsed={thinkCollapsed}
      />
    ) as React.ReactElement;
  }, [listData, streamingText, termWidth, thinkCollapsed]);

  // 与 gemini-cli 一致：alternate buffer 模式下直接返回 ScrollableList
  // ScrollableList 自身容器 Box 有 flexGrow=1，会填充剩余空间
  return (
    <>
      {/* v2：流式思考区域 — 独立于 streamingText（对标 Claude Code） */}
      {isStreaming && streamingThinking && (
        <Box marginTop={1}>
          <ThinkingMessage
            text={streamingThinking}
            width={termWidth}
            collapsed={false}
            streaming={true}
          />
        </Box>
      )}
      <ScrollableList
      data={listData}
      renderItem={renderListItem}
      estimatedItemHeight={estimatedItemHeight}
      keyExtractor={keyExtractor}
      initialScrollIndex={SCROLL_TO_ITEM_END}
      initialScrollOffsetInIndex={SCROLL_TO_ITEM_END}
      hasFocus={hasFocus}
      copyModeEnabled={copyModeEnabled}
      width={termWidth}
    />
    </>
  );
});
