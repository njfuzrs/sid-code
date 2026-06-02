/**
 * StatusIcon — 状态图标(P3-1)
 *
 * 统一成功/失败/进行中/警告的视觉符号 + 语义颜色。
 * 纯展示;符号选择逻辑(statusSymbol)抽为纯函数可单测。
 */

import React from "react";
import { ThemedText } from "./ThemedText.tsx";
import type { SemanticColorName } from "./colors.ts";

export type StatusKind = "success" | "error" | "pending" | "warning" | "info";

interface SymbolSpec {
  symbol: string;
  color: SemanticColorName;
}

/** 状态 → 符号 + 语义色。纯函数,便于单测保证一致性。 */
export function statusSymbol(kind: StatusKind): SymbolSpec {
  switch (kind) {
    case "success":
      return { symbol: "✔", color: "success" };
    case "error":
      return { symbol: "✘", color: "error" };
    case "warning":
      return { symbol: "⚠", color: "warning" };
    case "pending":
      return { symbol: "●", color: "accent" };
    case "info":
      return { symbol: "ℹ", color: "link" };
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return { symbol: "•", color: "text" };
    }
  }
}

export interface StatusIconProps {
  kind: StatusKind;
}

export function StatusIcon({ kind }: StatusIconProps) {
  const { symbol, color } = statusSymbol(kind);
  return <ThemedText color={color}>{symbol}</ThemedText>;
}
