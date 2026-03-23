/**
 * 半行填充盒子组件
 *
 * 在终端中实现半行高度的背景色圆角效果，使用 Unicode block character (▄/▀)。
 * 参考 gemini-cli/packages/cli/src/ui/components/shared/HalfLinePaddedBox.tsx
 */

import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { theme } from "../../semantic-colors.ts";
import {
  interpolateColor,
  resolveColor,
  getSafeLowColorBackground,
} from "../../themes/color-utils.ts";
import { isLowColorDepth, isITerm2 } from "../../utils/terminalUtils.ts";
import { useStdout } from "ink";
import { DEFAULT_TERM_WIDTH } from "../../markdown.ts";

export interface HalfLinePaddedBoxProps {
  /**
   * 要与终端背景混合的基础颜色
   */
  backgroundBaseColor: string;

  /**
   * 混合不透明度 (0-1)
   */
  backgroundOpacity: number;

  /**
   * 是否渲染实心背景色
   */
  useBackgroundColor?: boolean;

  children: React.ReactNode;
}

/**
 * 容器组件，使用半行填充（▀/▄）渲染实心背景
 */
export const HalfLinePaddedBox: React.FC<HalfLinePaddedBoxProps> = (props) => {
  // 如果禁用背景色，直接渲染子元素
  if (props.useBackgroundColor === false) {
    return <>{props.children}</>;
  }

  return <HalfLinePaddedBoxInternal {...props} />;
};

const HalfLinePaddedBoxInternal: React.FC<HalfLinePaddedBoxProps> = ({
  backgroundBaseColor,
  backgroundOpacity,
  children,
}) => {
  const { stdout } = useStdout();
  const terminalWidth = stdout.columns || DEFAULT_TERM_WIDTH;
  const terminalBg = theme.background.primary || "black";

  const isLowColor = isLowColorDepth();

  const backgroundColor = useMemo(() => {
    // 插值背景色在 256 色终端中通常效果不佳
    if (isLowColor) {
      return getSafeLowColorBackground(terminalBg);
    }

    const resolvedBase =
      resolveColor(backgroundBaseColor) || backgroundBaseColor;
    const resolvedTerminalBg = resolveColor(terminalBg) || terminalBg;

    return interpolateColor(
      resolvedTerminalBg,
      resolvedBase,
      backgroundOpacity,
    );
  }, [backgroundBaseColor, backgroundOpacity, terminalBg, isLowColor]);

  if (!backgroundColor) {
    return <>{children}</>;
  }

  const isITerm = isITerm2();

  if (isITerm) {
    // iTerm2 特殊处理：使用 rectangle fill
    return (
      <Box
        width={terminalWidth}
        flexDirection="column"
        alignItems="stretch"
        minHeight={1}
        flexShrink={0}
      >
        <Box width={terminalWidth} flexDirection="row">
          <Text color={backgroundColor}>{"▄".repeat(terminalWidth)}</Text>
        </Box>
        <Box
          width={terminalWidth}
          flexDirection="column"
          alignItems="stretch"
          backgroundColor={backgroundColor}
        >
          {children}
        </Box>
        <Box width={terminalWidth} flexDirection="row">
          <Text color={backgroundColor}>{"▀".repeat(terminalWidth)}</Text>
        </Box>
      </Box>
    );
  }

  // 标准终端：使用 block characters 混合颜色
  return (
    <Box
      width={terminalWidth}
      flexDirection="column"
      alignItems="stretch"
      minHeight={1}
      flexShrink={0}
      backgroundColor={backgroundColor}
    >
      <Box width={terminalWidth} flexDirection="row">
        <Text backgroundColor={backgroundColor} color={terminalBg}>
          {"▀".repeat(terminalWidth)}
        </Text>
      </Box>
      {children}
      <Box width={terminalWidth} flexDirection="row">
        <Text color={terminalBg} backgroundColor={backgroundColor}>
          {"▄".repeat(terminalWidth)}
        </Text>
      </Box>
    </Box>
  );
};
