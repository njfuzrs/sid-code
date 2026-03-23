/**
 * 状态栏组件
 * 从 App.tsx 提取，React.memo 避免不必要的重渲染
 */

import React from "react";
import { Box, Text } from "ink";
import type { Usage } from "../llm/types.ts";
import { theme } from "./semantic-colors.ts";
import { useUIState } from "./contexts/UIStateContext.tsx";

interface StatusBarProps {
  permissionMode: string;
  gitBranch: string;
  debug: boolean;
  usage: Usage;
  costUSD: number;
  costLimit: number;
  contextPercent: number;
  model: string;
  /** 滚动百分比（0-100），100 或 undefined 表示在底部 */
  scrollPercent?: number;
}

export const StatusBar = React.memo(function StatusBar(props: StatusBarProps) {
  const { permissionMode, gitBranch, debug, usage, costUSD, costLimit, contextPercent, model, scrollPercent } = props;
  const { renderMarkdown } = useUIState();

  const permColor = (() => {
    switch (permissionMode) {
      case "plan": return theme.ui.active;
      case "deny-write": return theme.status.error;
      case "always-allow": case "dontAsk": return theme.status.warning;
      default: return theme.status.success;
    }
  })();

  const costColor = (() => {
    if (costLimit <= 0 || costUSD <= 0) return undefined;
    const pct = (costUSD / costLimit) * 100;
    if (pct >= 95) return theme.status.error;
    if (pct >= 80) return theme.status.warning;
    return undefined;
  })();

  const costText = costUSD > 0 ? `$${costUSD.toFixed(4)}` : "$0";

  // 滚动位置指示（不在底部时显示）
  const showScroll = scrollPercent !== undefined && scrollPercent < 100;

  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text wrap="truncate">
        <Text bold color={theme.ui.active}>sid-code</Text>
        <Text dimColor> | </Text>
        <Text color={permColor}>{permissionMode}</Text>
        {gitBranch ? <><Text dimColor> | </Text><Text color={theme.ui.active}>{gitBranch}</Text></> : null}
        {debug ? <><Text dimColor> | </Text><Text color={theme.status.warning}>DEBUG</Text></> : null}
        {!renderMarkdown ? <><Text dimColor> | </Text><Text color={theme.status.warning}>RAW</Text></> : null}
        <Text dimColor> | </Text>
        <Text dimColor>{usage.inputTokens}↓ {usage.outputTokens}↑</Text>
        <Text dimColor> | </Text>
        <Text color={costColor} dimColor={!costColor}>{costText}</Text>
        <Text dimColor> | ctx {contextPercent}%</Text>
        {showScroll ? <><Text dimColor> | </Text><Text color={theme.status.warning}>↑ {scrollPercent}%</Text></> : null}
      </Text>
      <Text dimColor wrap="truncate">
        {model} | Alt+M 切换渲染 | Ctrl+C 退出
      </Text>
    </Box>
  );
});
