/**
 * Divider — 分隔线(P3-1)
 *
 * 替代散落的 HorizontalLine,统一分隔线样式与语义色。
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "../semantic-colors.ts";
import { resolveSemanticColor, type SemanticColorName } from "./colors.ts";

export interface DividerProps {
  /** 线宽(字符数);默认占满父容器 100% */
  width?: number | string;
  /** 语义色,默认 border */
  color?: SemanticColorName;
  /** 组成线的字符,默认 ─ */
  char?: string;
  dimColor?: boolean;
}

/** 生成定长分隔线字符串(纯函数,便于单测) */
export function dividerLine(width: number, char: string = "─"): string {
  if (width <= 0) return "";
  // char 可能是多字符;按需重复后截断到目标宽度
  return char.repeat(Math.ceil(width / char.length)).slice(0, width);
}

export function Divider({
  width = "100%",
  color = "border",
  char = "─",
  dimColor,
}: DividerProps) {
  const resolved = resolveSemanticColor(color, {
    text: theme.text,
    background: theme.background,
    border: theme.border,
    ui: theme.ui,
    status: theme.status,
  });

  // 数值宽度直接铺字符;百分比宽度交给 Box 布局 + 单字符填充
  if (typeof width === "number") {
    return (
      <Box>
        <Text color={resolved} dimColor={dimColor}>
          {dividerLine(width, char)}
        </Text>
      </Box>
    );
  }

  return (
    <Box width={width}>
      <Text color={resolved} dimColor={dimColor} wrap="truncate">
        {char.repeat(200)}
      </Text>
    </Box>
  );
}
