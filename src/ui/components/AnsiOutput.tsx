/**
 * AnsiOutput 组件
 *
 * 安全渲染 ANSI 转义码，支持虚拟化和颜色映射
 * 参考 gemini-cli/packages/cli/src/ui/components/AnsiOutput.tsx
 */

import React from 'react';
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import type { AnsiLine, AnsiOutput, AnsiToken } from '../types/ansi.ts';

const DEFAULT_HEIGHT = 24;

interface AnsiOutputProps {
  data: AnsiOutput;
  availableTerminalHeight?: number;
  width: number;
  maxLines?: number;
  disableTruncation?: boolean;
}

export const AnsiOutputText: React.FC<AnsiOutputProps> = ({
  data,
  availableTerminalHeight,
  width,
  maxLines,
  disableTruncation,
}) => {
  const availableHeightLimit =
    availableTerminalHeight && availableTerminalHeight > 0
      ? availableTerminalHeight
      : undefined;

  const numLinesRetained =
    availableHeightLimit !== undefined && maxLines !== undefined
      ? Math.min(availableHeightLimit, maxLines)
      : (availableHeightLimit ?? maxLines ?? DEFAULT_HEIGHT);

  const lastLines = disableTruncation
    ? data
    : numLinesRetained === 0
      ? []
      : data.slice(-numLinesRetained);

  return (
    <Box flexDirection="column" width={width} flexShrink={0} overflow="hidden">
      {lastLines.map((line: AnsiLine, lineIndex: number) => (
        <Box key={lineIndex} height={1} overflow="hidden">
          <AnsiLineText line={line} />
        </Box>
      ))}
    </Box>
  );
};

export const AnsiLineText: React.FC<{ line: AnsiLine }> = ({ line }) => (
  <Text>
    {line.length > 0
      ? line.map((token: AnsiToken, tokenIndex: number) => {
          // ink Text 的 bold/dim 互斥（同一术语见 src/ink/components/Text.tsx 的
          // WeightProps），不能像 AnsiToken 这样各自独立的布尔值一样同时传。
          // ANSI 序列里 bold+dim 同时置位是罕见的病态输入，取 bold 优先
          // （视觉权重更高，丢 dim 比丢 bold 更不显眼）。
          const weight = token.bold
            ? { bold: true as const }
            : token.dim
              ? { dim: true as const }
              : {};
          return (
            <Text
              key={tokenIndex}
              color={token.fg}
              backgroundColor={token.bg}
              inverse={token.inverse}
              italic={token.italic}
              underline={token.underline}
              {...weight}
            >
              {token.text}
            </Text>
          );
        })
      : null}
  </Text>
);
