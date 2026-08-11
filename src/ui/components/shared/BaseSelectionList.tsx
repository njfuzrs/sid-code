/**
 * 基础选择列表组件
 * 提供通用的选择列表 UI 结构和键盘导航逻辑
 */

import React, { useState } from 'react';
import Box from "../../../ink/components/Box.tsx";
import Text from "../../../ink/components/Text.tsx";
import { theme } from '../../semantic-colors.ts';
import type { Color } from '../../../ink/styles.ts';
import { useKeypress, KeypressPriority, type Key } from '../../contexts/KeypressContext.tsx';
import { BULLET } from '../../constants/figures.ts';

export interface SelectionListItem<T> {
  value: T;
  key: string;
  disabled?: boolean;
}

export interface RenderItemContext {
  isSelected: boolean;
  titleColor: Color;
  numberColor: Color;
}

export interface BaseSelectionListProps<
  T,
  TItem extends SelectionListItem<T> = SelectionListItem<T>,
> {
  items: TItem[];
  initialIndex?: number;
  onSelect: (value: T) => void;
  onHighlight?: (value: T) => void;
  isFocused?: boolean;
  showNumbers?: boolean;
  showScrollArrows?: boolean;
  maxItemsToShow?: number;
  wrapAround?: boolean;
  selectedIndicator?: string;
  renderItem: (item: TItem, context: RenderItemContext) => React.ReactNode;
}

export function BaseSelectionList<
  T,
  TItem extends SelectionListItem<T> = SelectionListItem<T>,
>({
  items,
  initialIndex = 0,
  onSelect,
  onHighlight,
  isFocused = true,
  showNumbers = true,
  showScrollArrows = false,
  maxItemsToShow = 10,
  wrapAround = true,
  selectedIndicator = BULLET,
  renderItem,
}: BaseSelectionListProps<T, TItem>): React.JSX.Element {
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const [scrollOffset, setScrollOffset] = useState(0);

  // 导航逻辑
  const moveUp = () => {
    let newIndex = activeIndex - 1;
    if (newIndex < 0) {
      newIndex = wrapAround ? items.length - 1 : 0;
    }
    setActiveIndex(newIndex);
    onHighlight?.(items[newIndex].value);
  };

  const moveDown = () => {
    let newIndex = activeIndex + 1;
    if (newIndex >= items.length) {
      newIndex = wrapAround ? 0 : items.length - 1;
    }
    setActiveIndex(newIndex);
    onHighlight?.(items[newIndex].value);
  };

  // 键盘事件处理
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (!isFocused) return false;

    // 上下导航
    if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
      moveUp();
      return true;
    }
    if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
      moveDown();
      return true;
    }

    // 回车选择
    if (key.name === 'enter' || key.name === 'return') {
      const item = items[activeIndex];
      if (!item.disabled) {
        onSelect(item.value);
      }
      return true;
    }

    // 数字快捷键
    if (showNumbers && key.insertable && /^[0-9]$/.test(key.sequence)) {
      const num = parseInt(key.sequence, 10);
      if (num > 0 && num <= items.length) {
        const item = items[num - 1];
        if (!item.disabled) {
          setActiveIndex(num - 1);
          onSelect(item.value);
        }
        return true;
      }
    }

    return false;
  });

  // 计算滚动偏移
  let effectiveScrollOffset = scrollOffset;
  if (activeIndex < effectiveScrollOffset) {
    effectiveScrollOffset = activeIndex;
  } else if (activeIndex >= effectiveScrollOffset + maxItemsToShow) {
    effectiveScrollOffset = Math.max(
      0,
      Math.min(activeIndex - maxItemsToShow + 1, items.length - maxItemsToShow),
    );
  }

  if (effectiveScrollOffset !== scrollOffset) {
    setScrollOffset(effectiveScrollOffset);
  }

  const visibleItems = items.slice(
    effectiveScrollOffset,
    effectiveScrollOffset + maxItemsToShow,
  );
  const numberColumnWidth = String(items.length).length;

  return (
    <Box flexDirection="column">
      {showScrollArrows && items.length > maxItemsToShow && (
        <Text
          color={
            effectiveScrollOffset > 0
              ? theme.text.primary
              : theme.text.secondary
          }
        >
          ▲
        </Text>
      )}

      {visibleItems.map((item, index) => {
        const itemIndex = effectiveScrollOffset + index;
        const isSelected = activeIndex === itemIndex;

        let titleColor = theme.text.primary;
        let numberColor = theme.text.primary;

        if (isSelected) {
          titleColor = theme.ui.focus;
          numberColor = theme.ui.focus;
        } else if (item.disabled) {
          titleColor = theme.text.secondary;
          numberColor = theme.text.secondary;
        }

        if (!isFocused && !item.disabled) {
          numberColor = theme.text.secondary;
        }

        if (!showNumbers) {
          numberColor = theme.text.secondary;
        }

        const itemNumberText = `${String(itemIndex + 1).padStart(
          numberColumnWidth,
          ' ',
        )}. `;

        return (
          <Box key={item.key} flexDirection="row">
            <Box width={2} flexShrink={0}>
              <Text color={isSelected ? theme.ui.focus : theme.text.secondary}>
                {isSelected ? selectedIndicator : ' '}
              </Text>
            </Box>
            {showNumbers && (
              <Box flexShrink={0}>
                <Text color={numberColor}>{itemNumberText}</Text>
              </Box>
            )}
            <Box flexGrow={1}>
              {renderItem(item, { isSelected, titleColor, numberColor })}
            </Box>
          </Box>
        );
      })}

      {showScrollArrows && items.length > maxItemsToShow && (
        <Text
          color={
            effectiveScrollOffset + maxItemsToShow < items.length
              ? theme.text.primary
              : theme.text.secondary
          }
        >
          ▼
        </Text>
      )}
    </Box>
  );
}
