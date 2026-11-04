/**
 * 全屏应用布局（`--alternate-buffer` / `/tui on`，opt-in；默认是主屏 MainScreenLayout）
 *
 * 从 TUIAppInner 提取的布局结构，负责：
 * - 消息区域（上方）：MainContent（虚拟列表 + 有界视口）/ EmptyLogo
 * - 底部固定区域：与主屏布局共享 BottomRegion，本文件只往插槽里放全屏独有的提示
 *   （Copy Mode 警告、已暂停跟随输出）
 *
 * 参考 gemini-cli DefaultAppLayout.tsx
 */

import React, { useRef, useCallback, useEffect } from "react";
import { Box } from "../render-port/components.ts";
import { Text } from "../render-port/components.ts";
import type { DOMElement } from "../render-port/types.ts";
import { MainContent } from "./MainContent.tsx";
import { CopyModeWarning } from "./CopyModeWarning.tsx";
import { EmptyLogo } from "./EmptyLogo.tsx";
import { BottomRegion, type BottomRegionSharedProps } from "./BottomRegion.tsx";
import type { HistoryItem } from "../types.ts";
import { theme } from "../semantic-colors.ts";
import { PAUSED_MARK } from "../constants/figures.ts";
import { useFlickerDetector } from "../hooks/useFlickerDetector.ts";
import { useStreamingScroll } from "../hooks/useStreamingScroll.ts";

interface DefaultAppLayoutProps extends BottomRegionSharedProps {
  // 消息区域
  listData: HistoryItem[];
  streamingText: string;
  /** v2：流式思考内容（独立于 streamingText） */
  streamingThinking: string;
  /** v2：流式思考开始时间戳（ms），透传给 MainContent → ThinkingMessage */
  streamingThinkingStartMs?: number;
  /** v2：思考块折叠状态 */
  thinkCollapsed: boolean;
  isStreaming: boolean;
  rows: number;
  estimatedItemHeight: (index: number) => number;
  keyExtractor: (item: HistoryItem, index: number) => string;
  copyModeEnabled: boolean;
  /** 仍未完成首次配置（向导关掉后 EmptyLogo 常驻引导行） */
  needsOnboarding?: boolean;
}

/** 全屏高度固定（height=rows），帧不会因瞬态行消失而整帧重画，占位只浪费空间（见 hooks/useHeldRows.ts） */
const FULLSCREEN_HELD_ROWS = { enabled: false, epoch: 0 } as const;

export const DefaultAppLayout: React.FC<DefaultAppLayoutProps> = ({
  listData,
  streamingText,
  streamingThinking,
  streamingThinkingStartMs,
  thinkCollapsed,
  isStreaming,
  rows,
  estimatedItemHeight,
  keyExtractor,
  copyModeEnabled,
  needsOnboarding,
  ...bottom
}) => {
  const { isEmpty, termWidth, cwd, gitBranch, model, activeDialog } = bottom;
  const rootRef = useRef<DOMElement>(null);
  useFlickerDetector(rootRef, rows);

  // ST8：流式↔滚动协调。粘底状态来自 MainContent 的 VirtualizedList；
  // 流式期间用户滚离底部 → paused，显示「跟随已暂停」提示。
  const streamScroll = useStreamingScroll();
  const onStickyChange = useCallback(
    (sticky: boolean) => {
      if (sticky) streamScroll.onReachBottom();
      else streamScroll.onUserScrollUp();
    },
    [streamScroll],
  );
  // 流式结束 → 复位为跟随，下一轮重新粘底。
  useEffect(() => {
    if (!isStreaming) streamScroll.onStreamEnd();
  }, [isStreaming, streamScroll]);
  const showFollowPausedHint = isStreaming && streamScroll.paused;

  return (
    <Box
      ref={rootRef}
      flexDirection="column"
      width={termWidth}
      height={rows}
      paddingBottom={copyModeEnabled ? 0 : 1}
      flexShrink={0}
      flexGrow={0}
      overflow="hidden"
    >
      {/* 消息区域：直接作为根 Box 子元素，ScrollableList 自身 flexGrow=1 会填充剩余空间 */}
      {isEmpty ? (
        <Box
          flexGrow={1}
          flexDirection="column"
          justifyContent="center"
          alignItems="center"
          width={termWidth}
        >
          <EmptyLogo
            termWidth={termWidth}
            cwd={cwd}
            gitBranch={gitBranch}
            model={model}
            onboarding={
              activeDialog === "onboarding" ? "open" : needsOnboarding ? "pending" : undefined
            }
          />
        </Box>
      ) : (
        <MainContent
          listData={listData}
          streamingText={streamingText}
          streamingThinking={streamingThinking}
          streamingThinkingStartMs={streamingThinkingStartMs}
          isStreaming={isStreaming}
          termWidth={termWidth}
          hasFocus={true}
          estimatedItemHeight={estimatedItemHeight}
          keyExtractor={keyExtractor}
          copyModeEnabled={copyModeEnabled}
          thinkCollapsed={thinkCollapsed}
          onStickyChange={onStickyChange}
        />
      )}

      {/* 底部固定区域：与 gemini-cli mainControlsRef 对齐（两套布局共享，见 BottomRegion） */}
      <BottomRegion
        {...bottom}
        heldRows={FULLSCREEN_HELD_ROWS}
        leading={<CopyModeWarning enabled={copyModeEnabled} />}
        beforeStatus={
          // ST8：流式跟随已暂停提示（用户上滚阅读历史时）
          showFollowPausedHint ? (
            <Box paddingX={1}>
              <Text color={theme.status.warning}>
                {`${PAUSED_MARK} 已暂停跟随输出（滚动到底部恢复）`}
              </Text>
            </Box>
          ) : null
        }
      />
    </Box>
  );
};
