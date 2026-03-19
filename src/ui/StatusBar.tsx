/**
 * 状态栏组件
 * 从 App.tsx 提取，React.memo 避免不必要的重渲染
 */

import React from "react";
import { Box, Text } from "ink";
import type { Usage } from "../llm/types.ts";

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

  const permColor = (() => {
    switch (permissionMode) {
      case "plan": return "cyan";
      case "deny-write": return "red";
      case "always-allow": case "dontAsk": return "yellow";
      default: return "green";
    }
  })();

  const costColor = (() => {
    if (costLimit <= 0 || costUSD <= 0) return undefined;
    const pct = (costUSD / costLimit) * 100;
    if (pct >= 95) return "red" as const;
    if (pct >= 80) return "yellow" as const;
    return undefined;
  })();

  const costText = costUSD > 0 ? `$${costUSD.toFixed(4)}` : "$0";

  // 滚动位置指示（不在底部时显示）
  const showScroll = scrollPercent !== undefined && scrollPercent < 100;

  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text wrap="truncate">
        <Text bold color="blue">sid-code</Text>
        <Text dimColor> | </Text>
        <Text color={permColor}>{permissionMode}</Text>
        {gitBranch ? <><Text dimColor> | </Text><Text color="cyan">{gitBranch}</Text></> : null}
        {debug ? <><Text dimColor> | </Text><Text color="yellow">DEBUG</Text></> : null}
        <Text dimColor> | </Text>
        <Text dimColor>{usage.inputTokens}↓ {usage.outputTokens}↑</Text>
        <Text dimColor> | </Text>
        <Text color={costColor} dimColor={!costColor}>{costText}</Text>
        <Text dimColor> | ctx {contextPercent}%</Text>
        {showScroll ? <><Text dimColor> | </Text><Text color="yellow">↑ {scrollPercent}%</Text></> : null}
      </Text>
      <Text dimColor wrap="truncate">
        {model} | Ctrl+C 退出
      </Text>
    </Box>
  );
});
