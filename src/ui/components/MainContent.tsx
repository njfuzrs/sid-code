/**
 * 主内容区域组件
 *
 * 使用 ScrollableList → VirtualizedList 实现虚拟化滚动
 * 支持 Copy Mode（Ctrl+S）进行文本选择
 *
 * 参考 gemini-cli/packages/cli/src/ui/components/MainContent.tsx
 */

import React, { useCallback, memo } from "react";
import { ScrollableList } from "./ScrollableList.tsx";
import { SCROLL_TO_ITEM_END } from "./VirtualizedList.tsx";
import { MessageItemRenderer } from "./MessageItemRenderer.tsx";
import { StreamingMessage } from "./StreamingMessage.tsx";
import type { DisplayItem } from "../App.tsx";

const MemoizedMessageItemRenderer = memo(MessageItemRenderer);

interface MainContentProps {
  /** 完整数据列表（含流式虚拟项） */
  listData: DisplayItem[];
  /** 流式输出文本 */
  streamingText: string;
  /** 是否正在流式输出 */
  isStreaming: boolean;
  /** 终端宽度 */
  termWidth: number;
  /** 是否有焦点（控制滚动） */
  hasFocus: boolean;
  /** 高度估算回调 */
  estimatedItemHeight: (index: number) => number;
  /** key 提取器 */
  keyExtractor: (item: DisplayItem, index: number) => string;
  /** Copy Mode：禁用 Ink 滚动，允许终端原生文本选择 */
  copyModeEnabled?: boolean;
}

export const MainContent = memo(function MainContent({
  listData,
  streamingText,
  termWidth,
  hasFocus,
  estimatedItemHeight,
  keyExtractor,
  copyModeEnabled,
}: MainContentProps) {

  const renderListItem = useCallback(({ item, index }: { item: DisplayItem; index: number }) => {
    // 流式内容特殊项
    if (item.kind === "system" && item.text === "__streaming__") {
      return (
        <StreamingMessage
          fullText={streamingText}
          maxWidth={termWidth}
        />
      ) as React.ReactElement;
    }
    const prevItem = index > 0 ? listData[index - 1] : undefined;
    return (<MemoizedMessageItemRenderer item={item} prevItem={prevItem} />) as React.ReactElement;
  }, [listData, streamingText, termWidth]);

  return (
    <ScrollableList
      data={listData}
      renderItem={renderListItem}
      estimatedItemHeight={estimatedItemHeight}
      keyExtractor={keyExtractor}
      initialScrollIndex={SCROLL_TO_ITEM_END}
      initialScrollOffsetInIndex={SCROLL_TO_ITEM_END}
      hasFocus={hasFocus}
      copyModeEnabled={copyModeEnabled}
    />
  );
});
