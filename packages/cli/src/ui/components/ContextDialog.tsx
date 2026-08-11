/**
 * 上下文用量面板（/context 打开）
 *
 * 把上下文窗口按类别（系统提示词/工具定义/用户消息/助手回复/工具调用/工具结果/结构开销）
 * 拆分，用彩色块网格直观展示各占多少 token，并汇总"已用/上限/剩余/距自动压缩阈值"。
 *
 * 样式遵循 src/ui/CLAUDE.md 铁律：无彩色 emoji；色块用 PROGRESS_FILLED 单色字形，
 * 颜色一律走 theme.* 语义色；排版靠对齐留白，不加边框盒子（仅外层单框）。
 * 只需 Esc 关闭。
 */

import React from "react";
import Box from "@sid-code/tui-renderer/components/Box.tsx";
import Text from "@sid-code/tui-renderer/components/Text.tsx";
import { theme } from "../semantic-colors.ts";
import type { Color } from "@sid-code/tui-renderer/styles.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";
import { PROGRESS_FILLED, PROGRESS_EMPTY } from "../constants/figures.ts";
import type { ContextTokenBreakdown } from "@sid-code/core/context/manager.ts";

interface ContextDialogProps {
  onClose: () => void;
  getBreakdown: () => ContextTokenBreakdown;
}

/** 千分位格式化。 */
function fmtNum(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/**
 * 每个分类分配一个 theme 语义色（循环取用）。
 * 全部取自 theme.*，跟随主题切换，绝不硬编码 hex。
 */
function categoryColor(key: string): Color {
  const map: Record<string, Color> = {
    systemPrompt: theme.ui.active,
    toolSchemas: theme.text.accent,
    // §12 P0-1 完整版新增细分类：沿用既有语义色池，不引入新色相（L1 元原则「克制点睛」）
    mcpToolSchemas: theme.text.link,
    agentDefs: theme.status.warning,
    memoryFiles: theme.status.success,
    userText: theme.status.success,
    assistantText: theme.text.link,
    toolUse: theme.status.warning,
    toolResult: theme.ui.comment,
    overhead: theme.text.secondary,
  };
  return map[key] ?? theme.text.primary;
}

/** 一行「标签 …… 值」，标签固定宽度对齐。 */
const Row: React.FC<{ label: string; labelWidth?: number; children: React.ReactNode }> = ({
  label,
  labelWidth = 12,
  children,
}) => {
  const pad = " ".repeat(Math.max(1, labelWidth - label.length));
  return (
    <Box paddingLeft={2}>
      <Text color={theme.text.secondary}>
        {label}
        {pad}
      </Text>
      <Text>{children}</Text>
    </Box>
  );
};

export const ContextDialog: React.FC<ContextDialogProps> = ({ onClose, getBreakdown }) => {
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === "escape") {
      onClose();
      return true;
    }
    return false;
  });

  const bd = getBreakdown();
  const { categories, total, maxTokens, compactThresholdTokens, completionBuffer, calibrated } = bd;

  // 整体网格宽度（格数），按 maxTokens 归一化——每格代表 maxTokens/GRID_WIDTH 个 token。
  const GRID_WIDTH = 40;
  const usedCells = maxTokens > 0 ? Math.min(GRID_WIDTH, Math.round((total / maxTokens) * GRID_WIDTH)) : 0;

  // 各分类在"已用格数"里按占比分配格子（保证总和 = usedCells，用最大余数法避免丢格）。
  const withCells = allocateCells(categories, usedCells);

  const usedPct = maxTokens > 0 ? Math.round((total / maxTokens) * 100) : 0;
  const remaining = Math.max(0, maxTokens - total);
  const toCompact = Math.max(0, compactThresholdTokens - total);
  const compactPct = maxTokens > 0 ? Math.round((compactThresholdTokens / maxTokens) * 100) : 0;

  // P3-2：完成缓冲区（输出预留 + 摘要预留）在网格里单独占格——它不是"已用"也不是"可用"，
  // 而是被预留掉的空间。对齐 CC /context 的 Autocompact buffer 方块。
  const bufferCells =
    maxTokens > 0 && completionBuffer > 0
      ? Math.min(
          Math.max(0, GRID_WIDTH - usedCells),
          Math.round((completionBuffer / maxTokens) * GRID_WIDTH),
        )
      : 0;

  // 拼接彩色网格：分类格 → 缓冲区格 → 空闲格，三段合计恒为 GRID_WIDTH。
  const emptyCells = Math.max(0, GRID_WIDTH - usedCells - bufferCells);
  // 真正可用于对话的空闲空间（扣掉完成缓冲区），比裸 remaining 更诚实
  const freeSpace = Math.max(0, remaining - completionBuffer);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
      <Text bold color={theme.ui.active}>上下文用量</Text>

      {/* 彩色网格 */}
      <Box paddingLeft={2} marginTop={1} flexWrap="wrap">
        {withCells.map((c) =>
          c.cells > 0 ? (
            <Text key={c.key} color={categoryColor(c.key)}>
              {PROGRESS_FILLED.repeat(c.cells)}
            </Text>
          ) : null,
        )}
        {/* P3-2：完成缓冲区——已填充字形（表示"不可用"）但用弱化色，区别于分类的语义色 */}
        {bufferCells > 0 ? (
          <Text color={theme.ui.comment}>{PROGRESS_FILLED.repeat(bufferCells)}</Text>
        ) : null}
        {emptyCells > 0 ? (
          <Text color={theme.ui.dark}>{PROGRESS_EMPTY.repeat(emptyCells)}</Text>
        ) : null}
      </Box>

      {/* 分类明细：色块 + 标签 + token + 占比 */}
      <Box flexDirection="column" marginTop={1}>
        {categories.map((c) => {
          const pct = total > 0 ? Math.round((c.tokens / total) * 100) : 0;
          return (
            <Box key={c.key} paddingLeft={2}>
              <Text color={categoryColor(c.key)}>{PROGRESS_FILLED} </Text>
              <Text color={theme.text.secondary}>{c.label.padEnd(6, "　")}</Text>
              <Text color={theme.text.primary}> {fmtNum(c.tokens)}</Text>
              <Text color={theme.text.secondary}> ({pct}%)</Text>
            </Box>
          );
        })}
      </Box>

      {/* 汇总 */}
      <Box flexDirection="column" marginTop={1}>
        <Row label="已用">
          <Text color={theme.text.primary}>{fmtNum(total)}</Text>
          <Text color={theme.text.secondary}> / {fmtNum(maxTokens)} tokens（{usedPct}%）</Text>
        </Row>
        {/* P3-2：完成缓冲区单独成行——它占着窗口但不可用于对话，混进"剩余"会让用户高估余量 */}
        {completionBuffer > 0 ? (
          <Row label="完成预留">
            <Text color={theme.ui.comment}>{fmtNum(completionBuffer)} tokens</Text>
            <Text color={theme.text.secondary}>（当前回复输出 + 一次摘要）</Text>
          </Row>
        ) : null}
        <Row label={completionBuffer > 0 ? "可用空闲" : "剩余"}>
          <Text color={theme.text.primary}>{fmtNum(completionBuffer > 0 ? freeSpace : remaining)} tokens</Text>
        </Row>
        <Row label="压缩阈值">
          <Text color={theme.status.warning}>{fmtNum(compactThresholdTokens)} tokens（{compactPct}%）</Text>
          <Text color={theme.text.secondary}>
            {toCompact > 0 ? `，距触发还剩 ~${fmtNum(toCompact)}` : "，已达阈值"}
          </Text>
        </Row>
      </Box>

      <Box marginTop={1} paddingLeft={2}>
        <Text color={theme.text.secondary}>
          {calibrated ? "（已按真实用量校准）" : "（启发式估算，未校准）"}  Esc 关闭
        </Text>
      </Box>
    </Box>
  );
};

/**
 * 把 usedCells 个格子按 token 占比分配给各分类，最大余数法保证总和精确等于 usedCells。
 */
function allocateCells(
  categories: Array<{ key: string; tokens: number }>,
  usedCells: number,
): Array<{ key: string; cells: number }> {
  const totalTokens = categories.reduce((s, c) => s + c.tokens, 0);
  if (totalTokens <= 0 || usedCells <= 0) {
    return categories.map((c) => ({ key: c.key, cells: 0 }));
  }
  const raw = categories.map((c) => ({
    key: c.key,
    exact: (c.tokens / totalTokens) * usedCells,
  }));
  const floored = raw.map((r) => ({ key: r.key, cells: Math.floor(r.exact), frac: r.exact - Math.floor(r.exact) }));
  let assigned = floored.reduce((s, r) => s + r.cells, 0);
  // 剩余格子按小数部分从大到小补齐
  const order = [...floored].sort((a, b) => b.frac - a.frac);
  let i = 0;
  while (assigned < usedCells && order.length > 0) {
    order[i % order.length].cells += 1;
    assigned += 1;
    i += 1;
  }
  return floored.map((r) => ({ key: r.key, cells: r.cells }));
}
