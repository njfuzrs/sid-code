/**
 * Footer 组件（四区分组底部状态栏）
 *
 * 视觉语言对标 claude-code 的 statusline：不再把所有列用统一 ` · ` 平铺（等权重 =
 * 没有重点），而是按语义分四区，区间用留白隔断，区内才用 ` · ` 连接：
 *
 *   身份区(左)          旋钮区              计量区(右)                 危险角(最右)
 *   deepseek-v4-pro     max ✻              ↑12k ↓3.4k · 45% · ⚡83%   ⚠ skip-perms
 *
 * - 身份区：model（+ debug 暗角标）。常驻。
 * - 旋钮区：effort 字形 · thinking 字形 · 非常规权限模式。支持时显示。
 * - 计量区：tokens · context% · cache% · cost。有值才现（零值隐藏）。
 * - 危险角：skip-perms / deny-write。仅危险态，独占最右 + ⚠ 前缀点睛。
 *
 * 降噪(L4.C)：↑0 ↓0 / ≈$0 零值隐藏；DEBUG 从常驻 warning 黄降为暗角灰标 ·d；
 * effort/thinking 去掉 (auto) 文字后缀（字形自解释）。
 * 点睛(元原则③)：默认全灰，只有危险态 / 上下文超阈 / 费用超限 / max 档 才上色。
 */

import React from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import type { Usage } from "../../llm/types.ts";
import { theme } from "../semantic-colors.ts";
import { WARNING_MARK } from "../constants/figures.ts";
import { useStatusLineData } from "../hooks/useStatusLineData.ts";

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

/** 区内分隔符：仅在同一区内多项之间使用，区间靠留白不靠它。 */
const Dot: React.FC = () => <Text color={theme.ui.comment}> · </Text>;

export const Footer = React.memo(function Footer(props: FooterProps) {
  const data = useStatusLineData(props);
  const { itemColor } = data;

  // ── 身份区：model（+ debug 暗角标）──
  const identity: React.ReactNode[] = [
    <Text key="model" color={itemColor}>{data.model}</Text>,
  ];
  if (data.isRaw) identity.push(<Text key="raw" color={theme.ui.comment}> ·r</Text>);
  if (data.isVim) identity.push(<Text key="vim" color={theme.ui.comment}> ·v</Text>);
  // DEBUG 不在状态栏展示：debug 是开发者自己开的开关，不必常驻占位（一个 ·d 字母角标既丑又无信息量）。

  // ── 旋钮区：effort · thinking · 非常规权限模式 ──
  const knobs: React.ReactNode[] = [];
  const pushKnob = (node: React.ReactNode) => {
    if (knobs.length > 0) knobs.push(<Dot key={`kd-${knobs.length}`} />);
    knobs.push(node);
  };
  if (data.effort) {
    pushKnob(<Text key="effort" color={data.effort.color}>{data.effort.text}</Text>);
  }
  if (data.thinking) {
    // 旋钮区只渲染字形（✻/✧），去掉 on/off 文字——字形自解释开关态。
    pushKnob(<Text key="thinking" color={data.thinking.color}>{data.thinking.glyph}</Text>);
  }
  // 非危险的常规权限模式常驻旋钮区，让用户随时知道处于什么模式；危险态移到最右角。
  // default 用暗灰（theme.ui.comment）降噪——常驻但不喧宾夺主（L2.1 克制点睛），
  // 非 default 常规态才用 derivePermission 的语义色。
  if (!data.permission.isDanger) {
    const modeColor =
      data.permission.display === "default" ? theme.ui.comment : data.permission.color;
    pushKnob(<Text key="mode" color={modeColor}>{data.permission.display}</Text>);
  }
  if (data.isPlanMode) {
    pushKnob(<Text key="plan" bold color={theme.ui.active}>[PLAN]</Text>);
  }

  // ── 计量区：tokens · context · cache · cost（零值项由 hook / 下方判定隐藏）──
  const metrics: React.ReactNode[] = [];
  const pushMetric = (node: React.ReactNode) => {
    if (metrics.length > 0) metrics.push(<Dot key={`md-${metrics.length}`} />);
    metrics.push(node);
  };
  if (data.tokens) {
    pushMetric(<Text key="tokens" color={itemColor}>{data.tokens.text}</Text>);
  }
  if (data.context) {
    pushMetric(<Text key="context" color={data.context.color}>{data.context.text}</Text>);
  }
  if (data.cache) {
    pushMetric(<Text key="cache" color={data.cache.color}>{data.cache.text}</Text>);
  }
  // 费用零值隐藏：costUSD<=0 时不显示 ≈$0 / $0（纯噪音）。
  if (props.costUSD > 0) {
    pushMetric(<Text key="cost" color={data.cost.color ?? itemColor}>{data.cost.text}</Text>);
  }
  if (data.cacheSavings) {
    pushMetric(<Text key="savings" color={data.cacheSavings.color}>{data.cacheSavings.text}</Text>);
  }
  if (data.scroll) {
    pushMetric(<Text key="scroll" color={theme.status.warning}>{data.scroll.text}</Text>);
  }

  // ── 危险角：skip-perms / deny-write，独占最右 + ⚠ 前缀点睛 ──
  const danger: React.ReactNode | null = data.permission.isDanger ? (
    <Text color={data.permission.color}>
      {WARNING_MARK} {data.permission.display}
    </Text>
  ) : null;

  // ── 四区布局：区间用 flexGrow 空盒撑开留白，不插 ` · `（L2.2 留白 > 分隔线）──
  return (
    <Box paddingX={1} width="100%" flexWrap="nowrap" overflow="hidden">
      {/* 身份区 */}
      <Box flexShrink={1}>{identity}</Box>

      {/* 身份 → 旋钮：小留白 */}
      {knobs.length > 0 && <Box width={3} />}
      <Box flexShrink={1}>{knobs}</Box>

      {/* 弹性留白，把计量区/危险角推到右侧 */}
      <Box flexGrow={1} minWidth={2} />

      {/* 计量区（右对齐） */}
      <Box flexShrink={1} justifyContent="flex-end">{metrics}</Box>

      {/* 计量 → 危险角：小留白 */}
      {danger && <Box width={3} />}
      {danger && <Box flexShrink={0}>{danger}</Box>}
    </Box>
  );
});
