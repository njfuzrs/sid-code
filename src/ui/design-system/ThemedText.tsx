/**
 * ThemedText — 语义化颜色文本(P3-1)
 *
 * 用法:
 *   <ThemedText color="success">操作成功</ThemedText>
 *   <ThemedText color="error" bold>失败</ThemedText>
 *
 * 颜色由当前主题统一解析,切换主题自动适配。
 */

import React from "react";
import { Text } from "ink";
import { theme } from "../semantic-colors.ts";
import { resolveSemanticColor, type SemanticColorName } from "./colors.ts";

export interface ThemedTextProps {
  color?: SemanticColorName;
  bold?: boolean;
  italic?: boolean;
  dimColor?: boolean;
  underline?: boolean;
  wrap?: "wrap" | "truncate" | "truncate-start" | "truncate-middle" | "truncate-end";
  children: React.ReactNode;
}

export function ThemedText({
  color = "text",
  bold,
  italic,
  dimColor,
  underline,
  wrap,
  children,
}: ThemedTextProps) {
  const resolved = resolveSemanticColor(color, {
    text: theme.text,
    background: theme.background,
    border: theme.border,
    ui: theme.ui,
    status: theme.status,
  });

  return (
    <Text
      color={resolved}
      bold={bold}
      italic={italic}
      dimColor={dimColor}
      underline={underline}
      wrap={wrap}
    >
      {children}
    </Text>
  );
}
