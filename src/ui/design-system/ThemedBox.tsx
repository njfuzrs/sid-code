/**
 * ThemedBox — 语义化颜色容器(P3-1)
 *
 * 包装 Ink Box,将 borderColor 接受语义颜色名并解析为主题色。
 * 其余 Box 属性透传。
 */

import React from "react";
import Box from "../../ink/components/Box.js";
import type { Props as BoxProps } from "../../ink/components/Box.js";
import { theme } from "../semantic-colors.ts";
import { resolveSemanticColor, type SemanticColorName } from "./colors.ts";

export interface ThemedBoxProps extends Omit<BoxProps, "borderColor"> {
  /** 语义边框色名;不传则不指定(沿用 Box 默认) */
  borderColor?: SemanticColorName;
  children?: React.ReactNode;
}

export function ThemedBox({ borderColor, children, ...rest }: ThemedBoxProps) {
  const resolved =
    borderColor !== undefined
      ? resolveSemanticColor(borderColor, {
          text: theme.text,
          background: theme.background,
          border: theme.border,
          ui: theme.ui,
          status: theme.status,
        })
      : undefined;

  return (
    <Box {...rest} borderColor={resolved}>
      {children}
    </Box>
  );
}
