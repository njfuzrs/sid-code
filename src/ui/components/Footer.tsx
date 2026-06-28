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
import type { Usage } from "../../llm/types.ts";
import { theme } from "../semantic-colors.ts";
import { stringWidth } from "../../ink/stringWidth.js";
import { useStatusLineData } from "../hooks/useStatusLineData.ts";

/** 缩短路径：~ 替换 home，超长时只保留最后两级 */
// LY1：shortenPath 等数据派生已移到 useStatusLineData，渲染层不再内联计算。

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
  stockInputTokens: number;
  costUSD: number;
  costLimit: number;
  contextPercent: number;
  model: string;
  scrollPercent?: number;
  /** 10.3：会话累计缓存节省金额（美元） */
  cacheSavingsUSD?: number;
}

export const Footer = React.memo(function Footer(props: FooterProps) {
  // LY1：所有数据派生集中在 useStatusLineData，本组件只负责把数据映射为列。
  const data = useStatusLineData(props);
  const { itemColor } = data;

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

  // 推理强度档位（effort）。替代原 CWD 列：目录信息在标题栏已有，状态栏改露更高频切换的旋钮。
  // null = 当前模型不支持档位切换，不渲染该列。
  if (data.effort) {
    const effortLabel = `${data.effort.glyph} ${data.effort.text}`;
    addCol("effort", "强度", <Text color={data.effort.color}>{effortLabel}</Text>, stringWidth(effortLabel));
  }

  // 权限模式
  addCol("mode", "模式", <Text color={data.permission.color}>{data.permission.display}</Text>, stringWidth(data.permission.display));

  // Plan Mode 标签
  if (data.isPlanMode) {
    addCol("plan", "", <Text bold color={theme.ui.active}>[PLAN]</Text>, 6);
  }

  // 思考开关（thinking）。替代原 Git 分支列：分支信息低频，状态栏改露思考开关。
  // null = 当前模型不支持思考开关，不渲染该列。
  if (data.thinking) {
    const thinkingLabel = `${data.thinking.glyph} ${data.thinking.text}`;
    addCol("thinking", "思考", <Text color={data.thinking.color}>{thinkingLabel}</Text>, stringWidth(thinkingLabel));
  }

  // Debug 模式
  if (data.isDebug) {
    addCol("debug", "", <Text color={theme.status.warning}>DEBUG</Text>, 5, true);
  }

  // RAW 模式
  if (data.isRaw) {
    addCol("raw", "", <Text color={theme.status.warning}>RAW</Text>, 3, true);
  }

  // Vim 模式
  if (data.isVim) {
    addCol("vim", "", <Text color={theme.text.accent}>VIM</Text>, 3, true);
  }

  // Token 统计
  addCol("tokens", "Tokens", <Text color={itemColor}>{data.tokenText}</Text>, stringWidth(data.tokenText));

  // 缓存命中率：命中 0 或无缓存字段时由 hook 返回 null，不显示该列。
  if (data.cache) {
    addCol(
      "cache",
      "缓存",
      <Text color={data.cache.color}>{data.cache.text}</Text>,
      stringWidth(data.cache.text),
    );
  }

  // 费用
  addCol("cost", "费用", <Text color={data.cost.color ?? itemColor}>{data.cost.text}</Text>, stringWidth(data.cost.text));

  // 10.3：缓存节省金额（节省 < $0.01 时由 hook 返回 null，不显示该列）
  if (data.cacheSavings) {
    addCol(
      "savings",
      "节省",
      <Text color={data.cacheSavings.color}>{data.cacheSavings.text}</Text>,
      stringWidth(data.cacheSavings.text),
    );
  }

  // 上下文（没有任何用户交互时隐藏，避免系统开销造成虚假百分比）
  if (data.context) {
    addCol("context", "上下文", <Text color={data.context.color}>{data.context.text}</Text>, stringWidth(data.context.text));
  }

  // 模型
  addCol("model", "模型", <Text color={itemColor}>{data.model}</Text>, stringWidth(data.model));

  // 滚动位置
  if (data.scroll) {
    addCol("scroll", "", <Text color={theme.status.warning}>{data.scroll.text}</Text>, stringWidth(data.scroll.text), true);
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
