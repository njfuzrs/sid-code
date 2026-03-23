/**
 * 单选按钮选择组件
 * 基于 BaseSelectionList 的单选列表
 */

import React from 'react';
import { Text } from 'ink';
import { theme } from '../../semantic-colors.ts';
import {
  BaseSelectionList,
  type RenderItemContext,
  type SelectionListItem,
} from './BaseSelectionList.tsx';

export interface RadioSelectItem<T> extends SelectionListItem<T> {
  label: string;
  sublabel?: string;
  description?: string;
}

export interface RadioButtonSelectProps<T> {
  items: Array<RadioSelectItem<T>>;
  initialIndex?: number;
  onSelect: (value: T) => void;
  onHighlight?: (value: T) => void;
  isFocused?: boolean;
  showScrollArrows?: boolean;
  maxItemsToShow?: number;
  showNumbers?: boolean;
  renderItem?: (
    item: RadioSelectItem<T>,
    context: RenderItemContext,
  ) => React.ReactNode;
}

export function RadioButtonSelect<T>({
  items,
  initialIndex = 0,
  onSelect,
  onHighlight,
  isFocused = true,
  showScrollArrows = false,
  maxItemsToShow = 10,
  showNumbers = true,
  renderItem,
}: RadioButtonSelectProps<T>): React.JSX.Element {
  return (
    <BaseSelectionList<T, RadioSelectItem<T>>
      items={items}
      initialIndex={initialIndex}
      onSelect={onSelect}
      onHighlight={onHighlight}
      isFocused={isFocused}
      showNumbers={showNumbers}
      showScrollArrows={showScrollArrows}
      maxItemsToShow={maxItemsToShow}
      renderItem={
        renderItem ||
        ((item, { titleColor }) => (
          <Text color={titleColor} wrap="truncate" key={item.key}>
            {item.label}
            {item.sublabel && (
              <Text color={theme.text.secondary}> {item.sublabel}</Text>
            )}
          </Text>
        ))
      }
    />
  );
}
