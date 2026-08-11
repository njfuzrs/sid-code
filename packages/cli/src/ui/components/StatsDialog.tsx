/**
 * 会话统计面板（/stats 无参时打开）
 *
 * 纯展示面板（无列表导航），分区展示：Token 用量 / 成本 / 会话信息。
 * 数值右对齐成列，上下文占用用 ▰▱ 进度条，成本按预算接近度着色。
 * 只需 Esc 关闭。
 */

import React from "react";
import Box from "@sid-code/tui-renderer/components/Box.tsx";
import Text from "@sid-code/tui-renderer/components/Text.tsx";
import { theme } from "../semantic-colors.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";
import { PROGRESS_FILLED, PROGRESS_EMPTY } from "../constants/figures.ts";
import type { Usage } from "@sid-code/core/llm/types.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import type { ModelPricing } from "@sid-code/core/api/cost-tracker.ts";
import { getGitOperationStats, type GitOperationKind } from "@sid-code/core/tool/git-operation-tracking.ts";

/** git 操作类型的中文标签（面板展示用）。 */
const GIT_KIND_LABELS: Record<string, string> = {
  commit: "提交",
  push: "推送",
  pr_created: "PR 创建",
  merge: "合并",
  rebase: "变基",
  checkout: "切换分支",
  reset: "重置",
  other: "其他",
};

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
  /** 当前模型定价（每百万 token，USD）。解析不到时为 undefined，"单价"分区整体省略。 */
  pricing?: ModelPricing;
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

/** 每百万 token 单价格式化：$X.XX/M（<1 保留更多小数以免归零）。 */
function fmtPrice(perMillion: number): string {
  if (perMillion === 0) return "免费";
  const decimals = perMillion >= 1 ? 2 : perMillion >= 0.01 ? 3 : 4;
  return `$${perMillion.toFixed(decimals)}/M`;
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
  pricing,
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

  // P2-3：git 操作度量。直接读模块级单例（与 /stats 文本模式同源），
  // 面板每次打开时取当时快照——不订阅变更（面板是一次性快照展示，非实时流）。
  const gitStats = React.useMemo(() => {
    const s = getGitOperationStats();
    return {
      total: s.total,
      rows: (Object.entries(s.byKind) as Array<[GitOperationKind, number]>).filter(([, n]) => n > 0),
    };
  }, []);

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

      {pricing && (
        <>
          <SectionTitle>单价（每百万 token）</SectionTitle>
          <StatRow label="输入">
            <Text color={theme.text.primary}>{fmtPrice(pricing.input)}</Text>
          </StatRow>
          <StatRow label="输出">
            <Text color={theme.text.primary}>{fmtPrice(pricing.output)}</Text>
          </StatRow>
          {typeof pricing.cacheRead === "number" && (
            <StatRow label="缓存读取">
              <Text color={theme.text.secondary}>{fmtPrice(pricing.cacheRead)}</Text>
            </StatRow>
          )}
          {typeof pricing.cacheWrite === "number" && pricing.cacheWrite > 0 && (
            <StatRow label="缓存写入">
              <Text color={theme.text.secondary}>{fmtPrice(pricing.cacheWrite)}</Text>
            </StatRow>
          )}
        </>
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

      {/* P2-3：git 操作度量。有计数才出现，零计数时整段省略（不给空分区添噪音）。 */}
      {gitStats.total > 0 && (
        <>
          <SectionTitle>Git 操作</SectionTitle>
          <StatRow label="总计">
            <Text color={theme.text.primary}>{gitStats.total} 次</Text>
          </StatRow>
          {gitStats.rows.map(([kind, count]) => (
            <StatRow key={kind} label={GIT_KIND_LABELS[kind] ?? kind}>
              <Text color={theme.text.primary}>{count} 次</Text>
            </StatRow>
          ))}
        </>
      )}

      <Box marginTop={1}>
        <Text italic>Esc 关闭</Text>
      </Box>
    </Box>
  );
};
