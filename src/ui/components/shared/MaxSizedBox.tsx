/**
 * MaxSizedBox 组件
 *
 * 使用 ResizeObserver 动态测量内容高度，提供内容感知的截断
 * 参考 gemini-cli/packages/cli/src/ui/components/shared/MaxSizedBox.tsx
 */

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Box, Text, ResizeObserver, type DOMElement } from 'ink';
import { theme } from '../../semantic-colors.ts';
import { useOverflowActions } from '../../contexts/OverflowContext.tsx';

/**
 * MaxSizedBox 组件的最小高度
 * 确保至少有一行内容和截断消息的空间
 */
export const MINIMUM_MAX_HEIGHT = 2;

export interface MaxSizedBoxProps {
  children?: React.ReactNode;
  maxWidth?: number;
  maxHeight?: number;
  overflowDirection?: 'top' | 'bottom';
  additionalHiddenLinesCount?: number;
}

/**
 * React 组件，约束子元素大小，当内容超过 maxHeight 时提供内容感知的截断
 */
export const MaxSizedBox: React.FC<MaxSizedBoxProps> = ({
  children,
  maxWidth,
  maxHeight,
  overflowDirection = 'top',
  additionalHiddenLinesCount = 0,
}) => {
  const id = useId();
  const { addOverflowingId, removeOverflowingId } = useOverflowActions() || {};
  const observerRef = useRef<ResizeObserver | null>(null);
  const [contentHeight, setContentHeight] = useState(0);

  const onRefChange = useCallback(
    (node: DOMElement | null) => {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }

      if (node && maxHeight !== undefined) {
        const observer = new ResizeObserver((entries) => {
          const entry = entries[0];
          if (entry) {
            setContentHeight(Math.round(entry.contentRect.height));
          }
        });
        observer.observe(node);
        observerRef.current = observer;
      }
    },
    [maxHeight],
  );

  const effectiveMaxHeight =
    maxHeight !== undefined
      ? Math.max(Math.round(maxHeight), MINIMUM_MAX_HEIGHT)
      : undefined;

  const isOverflowing =
    (effectiveMaxHeight !== undefined && contentHeight > effectiveMaxHeight) ||
    additionalHiddenLinesCount > 0;

  // 如果溢出，需要隐藏至少 1 行用于显示消息
  const visibleContentHeight =
    isOverflowing && effectiveMaxHeight !== undefined
      ? effectiveMaxHeight - 1
      : effectiveMaxHeight;

  const hiddenLinesCount =
    visibleContentHeight !== undefined
      ? Math.max(0, contentHeight - visibleContentHeight)
      : 0;

  const totalHiddenLines = hiddenLinesCount + additionalHiddenLinesCount;

  useEffect(() => {
    if (totalHiddenLines > 0) {
      addOverflowingId?.(id);
    } else {
      removeOverflowingId?.(id);
    }
  }, [id, totalHiddenLines, addOverflowingId, removeOverflowingId]);

  useEffect(
    () => () => {
      removeOverflowingId?.(id);
    },
    [id, removeOverflowingId],
  );

  if (effectiveMaxHeight === undefined) {
    return (
      <Box flexDirection="column" width={maxWidth}>
        {children}
      </Box>
    );
  }

  const offset =
    hiddenLinesCount > 0 && overflowDirection === 'top' ? -hiddenLinesCount : 0;

  return (
    <Box
      flexDirection="column"
      width={maxWidth}
      maxHeight={effectiveMaxHeight}
      flexShrink={0}
    >
      {totalHiddenLines > 0 && overflowDirection === 'top' && (
        <Text color={theme.text.secondary} wrap="truncate">
          {`... ${totalHiddenLines} 行已隐藏 (Ctrl+O 显示更多) ...`}
        </Text>
      )}
      <Box
        flexDirection="column"
        overflow="hidden"
        flexGrow={0}
        maxHeight={isOverflowing ? visibleContentHeight : undefined}
      >
        <Box
          flexDirection="column"
          ref={onRefChange}
          flexShrink={0}
          marginTop={offset}
        >
          {children}
        </Box>
      </Box>
      {totalHiddenLines > 0 && overflowDirection === 'bottom' && (
        <Text color={theme.text.secondary} wrap="truncate">
          {`... ${totalHiddenLines} 行已隐藏 (Ctrl+O 显示更多) ...`}
        </Text>
      )}
    </Box>
  );
};
