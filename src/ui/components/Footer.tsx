/**
 * Footer 组件（四区分组底部状态栏）
 *
 * 视觉语言对标 claude-code 的 statusline：不再把所有列用统一 ` · ` 平铺（等权重 =
 * 没有重点），而是按语义分四区，区间用留白隔断，区内才用 ` · ` 连接：
 *
 *   身份区(左)          旋钮区              计量区(右)                 权限角(最右)
 *   deepseek-v4-pro     ✻ max              ↑12k ↓3.4k · 45% · ⚡83%   default / ⚠ skip-perms
 *
 * - 身份区：model（+ debug 暗角标）。常驻。
 * - 旋钮区：thinking 字形 · effort 字形（先小后大：先开关后档位）。支持时显示。
 * - 计量区：tokens · context% · cache% · cost。有值才现（零值隐藏）。
 * - 权限角：权限模式统一独占最右一处（default/auto/skip-perms…）；危险态加 ⚠ 前缀点睛。
 *   此前非危险模式塞旋钮区、危险模式独占最右，两处位置迷惑用户，现统一到最右一处。
 *
 * 降噪(L4.C)：↑0 ↓0 / ≈$0 零值隐藏；DEBUG 从常驻 warning 黄降为暗角灰标 ·d；
 * effort/thinking 去掉 (auto) 文字后缀（字形自解释）。
 * 点睛(元原则③)：默认全灰，只有危险态 / 上下文超阈 / 费用超限 / max 档 才上色。
 *
 * 窄终端自适应(L4.D「终端窄时按优先级渐进隐藏」)：状态栏必须**单行**呈现，宽度不够时
 * 不能让任一区块的文本折行到第二行（会把 model 拆成 `ali-deepseek-v4-\nflash`、把
 * token 数字截半，视觉全乱）。这里用 stringWidth(L2.3) 实测各区块列宽，按优先级从低到
 * 高逐项丢弃：计量区先丢（且区内 scroll→savings→cache→cost→tokens→context 顺序丢），
 * 再丢旋钮区；身份区(model) 与权限角(尤其危险态 skip-perms 必须可见)永远保留。每个
 * <Text> 再加 wrap="truncate-end" 兜底——即便实测有偏差也只会单行截断，绝不折行。
 */

import React from "react";
import stringWidth from "string-width";
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
  /**
   * 终端列宽（响应式，随窗口 resize 变化）。用于窄终端下按优先级渐进隐藏区块，
   * 保证状态栏始终单行。缺省时回退到 stdout.columns，仍可工作只是不随 resize 精确联动。
   */
  termWidth?: number;
}

/** 区内分隔符宽度（" · " = 前后空格 + 点 = 3 列）。 */
const DOT_WIDTH = 3;
/** 区间留白宽度（身份→旋钮、计量→权限角均为 width={3} 空盒）。 */
const GAP_WIDTH = 3;
/** 弹性留白盒的最小宽度（flexGrow spacer 的 minWidth）。 */
const SPACER_MIN = 2;
/** 外层 paddingX={1} 占左右各 1 列。 */
const PADDING_X = 2;

/** 区内分隔符：仅在同一区内多项之间使用，区间靠留白不靠它。 */
const Dot: React.FC = () => <Text color={theme.ui.comment}> · </Text>;

/** 计量项描述：str 供实测列宽，node 供渲染，dropOrder 越大越先在窄屏被丢弃。 */
interface MetricItem {
  key: string;
  str: string;
  color: string | undefined;
  dropOrder: number;
}

/** 把一组带分隔符的项的字符串拼起来测总宽（n 项 → (n-1) 个 " · "）。 */
function joinedWidth(strs: string[]): number {
  if (strs.length === 0) return 0;
  const textW = strs.reduce((sum, s) => sum + stringWidth(s), 0);
  return textW + DOT_WIDTH * (strs.length - 1);
}

export const Footer = React.memo(function Footer(props: FooterProps) {
  const data = useStatusLineData(props);
  const { itemColor } = data;

  const termWidth =
    props.termWidth ?? (typeof process !== "undefined" ? process.stdout?.columns : undefined) ?? 80;

  // ── 身份区：model（+ raw/vim 暗角标）。常驻，永不丢弃。──
  let identityStr = data.model;
  if (data.isRaw) identityStr += " ·r";
  if (data.isVim) identityStr += " ·v";
  const identity: React.ReactNode[] = [
    <Text key="model" color={itemColor} wrap="truncate-end">{data.model}</Text>,
  ];
  if (data.isRaw) identity.push(<Text key="raw" color={theme.ui.comment}> ·r</Text>);
  if (data.isVim) identity.push(<Text key="vim" color={theme.ui.comment}> ·v</Text>);
  // DEBUG 不在状态栏展示：debug 是开发者自己开的开关，不必常驻占位。

  // ── 旋钮区：thinking · effort · [PLAN]（先小后大：先开关字形，再档位大小）──
  // 收集字符串（供测宽）与渲染项（供输出），保持索引对应，窄屏时整区一起丢。
  const knobStrs: string[] = [];
  const knobNodes: React.ReactNode[] = [];
  if (data.thinking) {
    // 旋钮区只渲染字形（✻/✧），去掉 on/off 文字——字形自解释开关态。
    knobStrs.push(data.thinking.glyph);
    knobNodes.push(<Text key="thinking" color={data.thinking.color}>{data.thinking.glyph}</Text>);
  }
  if (data.effort) {
    knobStrs.push(data.effort.text);
    knobNodes.push(<Text key="effort" color={data.effort.color}>{data.effort.text}</Text>);
  }
  if (data.isPlanMode) {
    knobStrs.push("[PLAN]");
    knobNodes.push(<Text key="plan" bold color={theme.ui.active}>[PLAN]</Text>);
  }

  // ── 计量区：tokens · context · cache · cost（零值项由 hook / 下方判定隐藏）──
  // dropOrder 越大越先被丢：context(1) / tokens(2) 最有价值，最后才丢；
  // scroll(6) / savings(5) 信息量最低，最先丢。
  const metricItems: MetricItem[] = [];
  if (data.tokens) {
    metricItems.push({ key: "tokens", str: data.tokens.text, color: itemColor, dropOrder: 2 });
  }
  if (data.context) {
    metricItems.push({ key: "context", str: data.context.text, color: data.context.color, dropOrder: 1 });
  }
  if (data.cache) {
    metricItems.push({ key: "cache", str: data.cache.text, color: data.cache.color, dropOrder: 4 });
  }
  // 费用零值隐藏：costUSD<=0 时不显示 ≈$0 / $0（纯噪音）。
  if (props.costUSD > 0) {
    metricItems.push({ key: "cost", str: data.cost.text, color: data.cost.color ?? itemColor, dropOrder: 3 });
  }
  if (data.cacheSavings) {
    metricItems.push({ key: "savings", str: data.cacheSavings.text, color: data.cacheSavings.color, dropOrder: 5 });
  }
  if (data.scroll) {
    metricItems.push({ key: "scroll", str: data.scroll.text, color: theme.status.warning, dropOrder: 6 });
  }

  // ── 权限角：权限模式统一独占最右一处（default/auto/skip-perms…）。常驻，永不丢弃。──
  // default 用暗灰降噪（常驻但不喧宾夺主，L2.1 克制点睛）；危险态加 ⚠ 前缀 + 语义色点睛，
  // 其余非危险常规态用 derivePermission 的语义色。
  const permColor = data.permission.isDanger
    ? data.permission.color
    : data.permission.display === "default"
      ? theme.ui.comment
      : data.permission.color;
  const permStr = (data.permission.isDanger ? `${WARNING_MARK} ` : "") + data.permission.display;

  // ── 窄终端渐进隐藏：按优先级从低到高逐项丢，直到单行放得下（L4.D）──
  // 固定占用（永不丢）：身份区 + 弹性留白 + 计量→权限角留白 + 权限角 + 左右 padding。
  const budget = termWidth - PADDING_X;
  const fixedWidth = stringWidth(identityStr) + SPACER_MIN + GAP_WIDTH + stringWidth(permStr);

  // 先算「旋钮 + 全部计量」都显示时的可变宽度。
  let keptMetrics = [...metricItems];
  let showKnobs = knobStrs.length > 0;

  const variableWidth = () => {
    let w = 0;
    if (showKnobs) w += GAP_WIDTH + joinedWidth(knobStrs); // 身份→旋钮留白 + 旋钮
    w += joinedWidth(keptMetrics.map((m) => m.str)); // 计量区
    return w;
  };

  // 1) 计量区从 dropOrder 最大的开始丢。
  const overflows = () => fixedWidth + variableWidth() > budget;
  while (overflows() && keptMetrics.length > 0) {
    let worstIdx = 0;
    for (let i = 1; i < keptMetrics.length; i++) {
      if (keptMetrics[i]!.dropOrder > keptMetrics[worstIdx]!.dropOrder) worstIdx = i;
    }
    keptMetrics.splice(worstIdx, 1);
  }
  // 2) 计量区丢空仍放不下 → 丢整个旋钮区。
  if (overflows() && showKnobs) showKnobs = false;

  // ── 渲染：把留下的计量项按 dropOrder 顺序重新插回 " · "，保持视觉排序稳定 ──
  const metrics: React.ReactNode[] = [];
  keptMetrics
    .sort((a, b) => a.dropOrder - b.dropOrder)
    .forEach((m, i) => {
      if (i > 0) metrics.push(<Dot key={`md-${m.key}`} />);
      metrics.push(<Text key={m.key} color={m.color} wrap="truncate-end">{m.str}</Text>);
    });

  const knobs: React.ReactNode[] = [];
  if (showKnobs) {
    knobNodes.forEach((node, i) => {
      if (i > 0) knobs.push(<Dot key={`kd-${i}`} />);
      knobs.push(node);
    });
  }

  const permMode: React.ReactNode = (
    <Text color={permColor} wrap="truncate-end">{permStr}</Text>
  );

  // ── 四区布局：区间用 flexGrow 空盒撑开留白，不插 ` · `（L2.2 留白 > 分隔线）──
  // flexWrap="nowrap" + overflow="hidden" + 各 Text 的 truncate-end 三重保证单行。
  return (
    <Box paddingX={1} width="100%" flexWrap="nowrap" overflow="hidden">
      {/* 身份区（可截断但永不丢） */}
      <Box flexShrink={1}>{identity}</Box>

      {/* 身份 → 旋钮：小留白 */}
      {knobs.length > 0 && <Box width={GAP_WIDTH} />}
      <Box flexShrink={0}>{knobs}</Box>

      {/* 弹性留白，把计量区/权限角推到右侧 */}
      <Box flexGrow={1} minWidth={SPACER_MIN} />

      {/* 计量区（右对齐） */}
      <Box flexShrink={0} justifyContent="flex-end">{metrics}</Box>

      {/* 计量 → 权限角：小留白，权限模式统一独占最右一处 */}
      <Box width={GAP_WIDTH} />
      <Box flexShrink={0}>{permMode}</Box>
    </Box>
  );
});
