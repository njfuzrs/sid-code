/**
 * SectionHeader 组件
 *
 * 渲染分节标题
 */

import React from 'react';
import { Box, Text } from 'ink';

export interface SectionHeaderProps {
  /**
   * 标题文本
   */
  title: string;

  /**
   * 颜色
   */
  color?: string;

  /**
   * 是否加粗
   */
  bold?: boolean;

  /**
   * 左侧 padding
   */
  paddingLeft?: number;
}

/**
 * 渲染分节标题
 */
export const SectionHeader: React.FC<SectionHeaderProps> = ({
  title,
  color,
  bold = true,
  paddingLeft = 0,
}) => {
  return (
    <Box paddingLeft={paddingLeft}>
      <Text color={color} bold={bold}>
        {title}
      </Text>
    </Box>
  );
};
