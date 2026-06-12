/**
 * Footer 组件（可配置列底部状态栏）
 *
 * 参考 gemini-cli Footer.tsx，实现 FooterRow 可配置列布局。
 * 每列有 header + element，支持宽度自适应裁剪。
 *
 * 替代原 StatusBar 组件。
 */

import React from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { homedir } from "os";
import type { Usage } from "../../llm/types.ts";
import { normalizeCacheUsage } from "../../llm/types.ts";
import { SessionState } from "../../session/state.ts";
import { theme } from "../semantic-colors.ts";
import { useUIState } from "../contexts/UIStateContext.tsx";
import { useConfig } from "../contexts/ConfigContext.tsx";
import { useSettings } from "../contexts/SettingsContext.tsx";

/** 缩短路径：~ 替换 home，超长时只保留最后两级 */
function shortenPath(p: string, maxLen = 25): string {
  const home = homedir();
  let display = p.startsWith(home) ? "~" + p.slice(home.length) : p;
  if (display.length > maxLen) {
    const parts = display.split("/");
    if (parts.length > 2) {
      display = "…/" + parts.slice(-2).join("/");
    }
  }
  return display;
}

// ── FooterRow 通用组件 ──

export interface FooterRowItem {
  key: string;
  header: string;
  element: React.ReactNode;
  flexGrow?: number;
  flexShrink?: number;
  alignItems?: "flex-start" | "center" | "flex-end";
}

const COLUMN_GAP = 3;

export const FooterRow: React.FC<{
  items: FooterRowItem[];
  showLabels: boolean;
}> = ({ items, showLabels }) => {
  const elements: React.ReactNode[] = [];

  items.forEach((item, idx) => {
    if (idx > 0) {
      elements.push(
        <Box
          key={`sep-${item.key}`}
          flexGrow={1}
          flexShrink={1}
          minWidth={showLabels ? COLUMN_GAP : 3}
          justifyContent="center"
          alignItems="center"
        >
          {!showLabels && <Text color={theme.ui.comment}> · </Text>}
        </Box>,
      );
    }

    elements.push(
      <Box
        key={item.key}
        flexDirection="column"
        flexGrow={item.flexGrow ?? 0}
        flexShrink={item.flexShrink ?? 1}
        alignItems={item.alignItems}
      >
        {showLabels && (
          <Box height={1}>
            <Text color={theme.ui.comment}>{item.header}</Text>
          </Box>
        )}
        <Box height={1}>{item.element}</Box>
      </Box>,
    );
  });

  return (
    <Box flexDirection="row" flexWrap="nowrap" width="100%">
      {elements}
    </Box>
  );
};

// ── Footer 列定义 ──

interface FooterColumn {
  id: string;
  header: string;
  element: React.ReactNode;
  width: number;
  isHighPriority: boolean;
}

// ── Footer 主组件 ──

interface FooterProps {
  permissionMode: string;
  isPlanMode: boolean;
  gitBranch: string;
  debug: boolean;
  usage: Usage;
  costUSD: number;
  costLimit: number;
  contextPercent: number;
  model: string;
  scrollPercent?: number;
}

export const Footer = React.memo(function Footer(props: FooterProps) {
  const {
    permissionMode,
    isPlanMode,
    gitBranch,
    debug,
    usage,
    costUSD,
    costLimit,
    contextPercent,
    model,
    scrollPercent,
  } = props;
  const { renderMarkdown } = useUIState();
  const config = useConfig();
  const settings = useSettings();

  const itemColor = theme.ui.comment;

  // 构建列
  const potentialColumns: FooterColumn[] = [];

  const addCol = (
    id: string,
    header: string,
    element: React.ReactNode,
    dataWidth: number,
    isHighPriority = false,
  ) => {
    potentialColumns.push({ id, header, element, width: dataWidth, isHighPriority });
  };

  // 品牌
  addCol("brand", "", <Text bold color={theme.ui.active}>sid-code</Text>, 8, true);

  // CWD（缩短路径：~ 替换 home，只显示最后两级）
  const cwdDisplay = shortenPath(config.cwd);
  addCol("cwd", "目录", <Text color={itemColor}>{cwdDisplay}</Text>, cwdDisplay.length);

  // 权限模式
  const permColor = (() => {
    switch (permissionMode) {
      case "plan": return theme.ui.active;
      case "deny-write": return theme.status.error;
      case "always-allow": case "dontAsk": case "dangerously-skip-permissions": return theme.status.warning;
      default: return theme.status.success;
    }
  })();
  const permDisplay = permissionMode === "dangerously-skip-permissions" ? "skip-perms" : permissionMode;
  addCol("mode", "模式", <Text color={permColor}>{permDisplay}</Text>, permDisplay.length);

  // Plan Mode 标签
  if (isPlanMode) {
    addCol("plan", "", <Text bold color={theme.ui.active}>[PLAN]</Text>, 6);
  }

  // Git 分支
  if (gitBranch) {
    addCol("git", "分支", <Text color={itemColor}>{gitBranch}</Text>, gitBranch.length);
  }

  // Debug 模式
  if (debug) {
    addCol("debug", "", <Text color={theme.status.warning}>DEBUG</Text>, 5, true);
  }

  // RAW 模式
  if (!renderMarkdown) {
    addCol("raw", "", <Text color={theme.status.warning}>RAW</Text>, 3, true);
  }

  // Vim 模式
  if (settings.vimMode) {
    addCol("vim", "", <Text color={theme.text.accent}>VIM</Text>, 3, true);
  }

  // Token 统计
  const tokenStr = `${usage.inputTokens}↓ ${usage.outputTokens}↑`;
  addCol("tokens", "Tokens", <Text color={itemColor}>{tokenStr}</Text>, tokenStr.length);

  // 缓存命中率（模块 B）：经归一化单一事实源派生，命中率 0 或无缓存字段时不显示该列
  // （避免对 Ollama / 无缓存模型显示 0% 误导）。≥50% 绿、<50% 默认色。
  {
    const n = normalizeCacheUsage(usage, SessionState.inferProvider(model));
    if (n.cacheHitTokens > 0 && n.promptTotal > 0) {
      const rate = Math.round((n.cacheHitTokens / Math.max(1, n.promptTotal)) * 100);
      const cacheStr = `⚡${rate}%`;
      addCol(
        "cache",
        "缓存",
        <Text color={rate >= 50 ? theme.status.success : itemColor}>{cacheStr}</Text>,
        cacheStr.length,
      );
    }
  }

  // 费用
  const costText = costUSD > 0 ? `$${costUSD.toFixed(4)}` : "$0";
  const costColor = (() => {
    if (costLimit <= 0 || costUSD <= 0) return undefined;
    const pct = (costUSD / costLimit) * 100;
    if (pct >= 95) return theme.status.error;
    if (pct >= 80) return theme.status.warning;
    return undefined;
  })();
  addCol("cost", "费用", <Text color={costColor ?? itemColor}>{costText}</Text>, costText.length);

  // 上下文
  const ctxStr = `${contextPercent}%`;
  let ctxColor = itemColor;
  if (contextPercent >= 90) ctxColor = theme.status.error;
  else if (contextPercent >= 70) ctxColor = theme.status.warning;
  addCol("context", "上下文", <Text color={ctxColor}>{ctxStr}</Text>, ctxStr.length);

  // 模型
  addCol("model", "模型", <Text color={itemColor}>{model}</Text>, model.length);

  // 滚动位置
  const showScroll = scrollPercent !== undefined && scrollPercent < 100;
  if (showScroll) {
    const scrollStr = `↑${scrollPercent}%`;
    addCol("scroll", "", <Text color={theme.status.warning}>{scrollStr}</Text>, scrollStr.length, true);
  }

  // ── 宽度裁剪逻辑 ──
  // 简化版：不做复杂裁剪，直接用 FooterRow 的 flexShrink 处理溢出
  const rowItems: FooterRowItem[] = potentialColumns.map((col, index) => ({
    key: col.id,
    header: col.header,
    element: col.element,
    flexGrow: 0,
    flexShrink: 1,
    alignItems: index === potentialColumns.length - 1 ? "flex-end" as const : "flex-start" as const,
  }));

  return (
    <Box paddingX={1} overflow="hidden" flexWrap="nowrap">
      <FooterRow items={rowItems} showLabels={false} />
    </Box>
  );
});
