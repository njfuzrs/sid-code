/**
 * 双模式内容区域
 *
 * 模式 1（Alternate Buffer）：ScrollableList → VirtualizedList，完整滚动
 * 模式 2（Static）：Static 历史 + 动态 pending，无滚动（屏幕阅读器友好）
 *
 * 参考 gemini-cli/packages/cli/src/ui/components/MainContent.tsx
 */

import React, { useMemo, useCallback, memo } from "react";
import { Box, Static } from "ink";
import { ScrollableList } from "./ScrollableList.tsx";
import { SCROLL_TO_ITEM_END } from "./VirtualizedList.tsx";
import { MessageItemRenderer } from "./MessageItemRenderer.tsx";
import { StreamingMessage } from "./StreamingMessage.tsx";
import type { DisplayItem } from "../App.tsx";

const MemoizedMessageItemRenderer = memo(MessageItemRenderer);

interface MainContentProps {
  /** 是否使用 alternate buffer 模式 */
  useAlternateBuffer: boolean;
  /** 已确认的历史消息（Static 模式用） */
  confirmedItems: DisplayItem[];
  /** 当前轮次进行中的消息（Static 模式用） */
  pendingItems: DisplayItem[];
  /** 完整数据列表（Alternate Buffer 模式用，含流式虚拟项） */
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
}

/** Static 模式下的单条消息渲染 */
function StaticMessageItem({ item, index, allItems }: {
  item: DisplayItem;
  index: number;
  allItems: DisplayItem[];
}) {
  const prevItem = index > 0 ? allItems[index - 1] : undefined;
  return <MessageItemRenderer item={item} prevItem={prevItem} />;
}

export const MainContent = memo(function MainContent({
  useAlternateBuffer,
  confirmedItems,
  pendingItems,
  listData,
  streamingText,
  isStreaming,
  termWidth,
  hasFocus,
  estimatedItemHeight,
  keyExtractor,
}: MainContentProps) {

  // ── Alternate Buffer 模式：ScrollableList ──
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

  if (useAlternateBuffer) {
    return (
      <ScrollableList
        data={listData}
        renderItem={renderListItem}
        estimatedItemHeight={estimatedItemHeight}
        keyExtractor={keyExtractor}
        initialScrollIndex={SCROLL_TO_ITEM_END}
        initialScrollOffsetInIndex={SCROLL_TO_ITEM_END}
        hasFocus={hasFocus}
      />
    );
  }

  // ── Static 模式：已确认历史 + pending 动态区 ──
  // Static 中的 items 只渲染一次，不会重渲染
  const staticElements = useMemo(() =>
    confirmedItems.map((item, index) => ({
      id: keyExtractor(item, index),
      item,
      index,
    })),
    [confirmedItems, keyExtractor],
  );

  return (
    <>
      <Static items={staticElements}>
        {({ item, index }) => (
          <StaticMessageItem
            key={keyExtractor(item, index)}
            item={item}
            index={index}
            allItems={confirmedItems}
          />
        )}
      </Static>
      <Box flexDirection="column">
        {pendingItems.map((item, index) => {
          const globalIndex = confirmedItems.length + index;
          const prevItem = index === 0
            ? confirmedItems[confirmedItems.length - 1]
            : pendingItems[index - 1];
          return (
            <MemoizedMessageItemRenderer
              key={keyExtractor(item, globalIndex)}
              item={item}
              prevItem={prevItem}
            />
          );
        })}
        {isStreaming && streamingText ? (
          <StreamingMessage
            fullText={streamingText}
            maxWidth={termWidth}
          />
        ) : null}
      </Box>
    </>
  );
});
