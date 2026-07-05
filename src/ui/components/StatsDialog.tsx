/**
 * 会话统计面板（/stats 无参时打开）
 *
 * 纯展示面板（无列表导航），分区展示：Token 用量 / 成本 / 会话信息。
 * 数值右对齐成列，上下文占用用 ▰▱ 进度条，成本按预算接近度着色。
 * 只需 Esc 关闭。
 */

import React from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { theme } from "../semantic-colors.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";
import { PROGRESS_FILLED, PROGRESS_EMPTY } from "../constants/figures.ts";
import type { Usage } from "../../llm/types.ts";
import { SessionState } from "../../session/state.ts";

interface StatsDialogProps {
  onClose: () => void;
  usage: Usage;
  stockInputTokens: number;
  costUSD: number;
  cacheSavingsUSD?: number;
  costLimit: number;
  contextPercent: number;
  model: string;
  provider: string;
  sessionState?: SessionState;
}

/** 进度条渲染：filled/empty 方块（▰▱），width 格。 */
function renderProgressBar(percent: number, width = 12): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return PROGRESS_FILLED.repeat(filled) + PROGRESS_EMPTY.repeat(width - filled);
}

/** 千分位格式化。 */
function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

/** 一行「标签 …… 值」，标签固定宽度，值区可着色。labelWidth 用于对齐。 */
const StatRow: React.FC<{ label: string; children: React.ReactNode; labelWidth?: number }> = ({
  label,
  children,
  labelWidth = 14,
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

/** 分区标题。 */
const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Box marginTop={1}>
    <Text bold color={theme.text.primary}>
      {children}
    </Text>
  </Box>
);

export const StatsDialog: React.FC<StatsDialogProps> = ({
  onClose,
  usage,
  stockInputTokens,
  costUSD,
  cacheSavingsUSD,
  costLimit,
  contextPercent,
  model,
  provider,
  sessionState,
}) => {
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === "escape") {
      onClose();
      return true;
    }
    return false;
  });

  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;

  // 缓存命中率：stockInputTokens 为末次完整输入 tokens，作为缓存命中量近似
  const cacheHitRate = inputTokens > 0 ? Math.round((stockInputTokens / inputTokens) * 100) : 0;

  // 成本着色：超预算红、接近(≥80%)黄、否则默认
  const budgetRatio = costLimit > 0 ? costUSD / costLimit : 0;
  const costColor =
    budgetRatio >= 1
      ? theme.status.error
      : budgetRatio >= 0.8
        ? theme.status.warning
        : theme.text.primary;

  // 会话级数据（可选，无 sessionState 时省略对应行）
  // 注：对话轮次由 ctxMgr 维护，本面板不持有 ctxMgr，故只展示 API 请求次数（源自 modelUsage）。
  const requestCount = sessionState
    ? Object.values(sessionState.modelUsage).reduce((sum, m) => sum + m.requests, 0)
    : undefined;
  const durationText = sessionState
    ? SessionState.formatDuration(sessionState.getElapsedMs())
    : undefined;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
      <Text bold color={theme.ui.active}>会话统计</Text>

      <SectionTitle>Token 用量</SectionTitle>
      <StatRow label="输入 (input)">
        <Text color={theme.text.primary}>{fmtNum(inputTokens)} tokens</Text>
      </StatRow>
      <StatRow label="输出 (output)">
        <Text color={theme.text.primary}>{fmtNum(outputTokens)} tokens</Text>
      </StatRow>
      {stockInputTokens > 0 && (
        <StatRow label="缓存命中">
          <Text color={theme.text.primary}>{fmtNum(stockInputTokens)} tokens </Text>
          <Text color={theme.text.secondary}>({cacheHitRate}%)</Text>
        </StatRow>
      )}
      <StatRow label="上下文占用">
        <Text color={theme.ui.active}>{renderProgressBar(contextPercent)}</Text>
        <Text color={theme.text.secondary}> {contextPercent}%</Text>
      </StatRow>

      <SectionTitle>成本</SectionTitle>
      <StatRow label="本次会话">
        <Text color={costColor}>${costUSD.toFixed(4)}</Text>
      </StatRow>
      {typeof cacheSavingsUSD === "number" && cacheSavingsUSD > 0 && (
        <StatRow label="缓存节省">
          <Text color={theme.status.success}>${cacheSavingsUSD.toFixed(4)}</Text>
        </StatRow>
      )}
      {costLimit > 0 && (
        <StatRow label="预算">
          <Text color={theme.text.primary}>
            ${costUSD.toFixed(2)} / ${costLimit.toFixed(2)}
          </Text>
        </StatRow>
      )}

      <SectionTitle>会话信息</SectionTitle>
      {typeof requestCount === "number" && (
        <StatRow label="API 请求">
          <Text color={theme.text.primary}>{requestCount} 次</Text>
        </StatRow>
      )}
      {durationText && (
        <StatRow label="会话时长">
          <Text color={theme.text.primary}>{durationText}</Text>
        </StatRow>
      )}
      <StatRow label="模型">
        <Text color={theme.text.primary}>{model}</Text>
      </StatRow>
      <StatRow label="Provider">
        <Text color={theme.text.primary}>{provider}</Text>
      </StatRow>

      <Box marginTop={1}>
        <Text dimColor italic>Esc 关闭</Text>
      </Box>
    </Box>
  );
};
