/**
 * HorizontalLine 组件
 *
 * 渲染水平分隔线
 */

import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { DEFAULT_TERM_WIDTH } from '../../markdown.ts';

export interface HorizontalLineProps {
  /**
   * 分隔线字符，默认为 '─'
   */
  character?: string;

  /**
   * 颜色
   */
  color?: string;

  /**
   * 是否使用 dimColor
   */
  dimColor?: boolean;
}

/**
 * 渲染水平分隔线
 */
export const HorizontalLine: React.FC<HorizontalLineProps> = ({
  character = '─',
  color,
  dimColor = true,
}) => {
  const { stdout } = useStdout();
  const width = stdout.columns || DEFAULT_TERM_WIDTH;

  return (
    <Box width={width}>
      <Text color={color} dimColor={dimColor}>
        {character.repeat(width)}
      </Text>
    </Box>
  );
};
