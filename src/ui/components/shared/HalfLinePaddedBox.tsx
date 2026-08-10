/**
 * 半行填充盒子组件
 *
 * 在终端中实现半行高度的背景色圆角效果，使用 Unicode block character (▄/▀)。
 * 参考 gemini-cli/packages/cli/src/ui/components/shared/HalfLinePaddedBox.tsx
 */

import React, { useMemo } from "react";
import Box from "../../../ink/components/Box.js";
import Text from "../../../ink/components/Text.js";
import { theme } from "../../semantic-colors.ts";
import {
  interpolateColor,
  resolveColor,
  getSafeLowColorBackground,
} from "../../themes/color-utils.ts";
import { isLowColorDepth, isITerm2 } from "../../utils/terminalUtils.ts";
import type { Color } from "../../../ink/styles.js";
import useStdout from "../../../ink/_vendor/use-stdout.js";
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
  // 兜底用 'ansi:black' 而不是裸 "black"：terminalBg 会直接进 <Text color=…>（下方
  // 半行块字符用它当前景色），而 ink 的 colorize() 只认 `#hex` / `rgb()` / `ansi256()` /
  // `ansi:*` 四种形态，裸 "black" 会走到函数末尾 `return str` —— 静默不上色。
  // （theme.background.primary 的类型已是 Color 非空，这个 || 分支实际是防空串兜底。）
  const terminalBg: Color = theme.background.primary || "ansi:black";

  const isLowColor = isLowColorDepth();

  const backgroundColor = useMemo((): Color | undefined => {
    // 插值背景色在 256 色终端中通常效果不佳
    if (isLowColor) {
      return getSafeLowColorBackground(terminalBg);
    }

    const resolvedBase =
      resolveColor(backgroundBaseColor) || backgroundBaseColor;
    const resolvedTerminalBg = resolveColor(terminalBg) || terminalBg;

    // interpolateColor 的返回类型是宽 string（它同时服务于 ColorsTheme 的构造，那边
    // 字段就是 string），但两个输入都已过 resolveColor 规范化，tinygradient 的输出是
    // `#rrggbb`。唯一的非 Color 返回路径是「任一入参为空 → 返回 ""」，而空串被下面的
    // `if (!backgroundColor)` 挡住（该分支直接渲染 children，不带背景），所以这里
    // 断言成 Color 是安全的。
    return interpolateColor(
      resolvedTerminalBg,
      resolvedBase,
      backgroundOpacity,
    ) as Color;
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
