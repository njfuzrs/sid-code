/**
 * Footer 组件（两行分层 + 各行单侧对齐 + 两色层次 底部状态栏）
 *
 * 信息变多后单行放不下。此前试过「两端锚定」（左右各一簇、中间大留白），但两簇隔太远
 * 反而显得零散不成整体。这版改为**每行单侧对齐、按语义把相关信息聚成一条连续流**，
 * 视觉语言仍对标 claude-code 的 statusline（区内 ` · ` 连接、克制点睛）：
 *
 *   行1(会话/运行 · 左对齐)  glm-5.2 · ✻ · max · 4% · ↑30.9k ↓116 · $0.0343 · ⚡47%
 *   行2(环境/上下文 · 右对齐)                              sid-code ⎇ master · ⏸ Manual
 *
 * ① 分两行（纵向分层）：
 *    - 行1｜会话运行态（每轮在变、需要盯的）：model · thinking · effort · [PLAN] ·
 *      context% · tokens(↑in ↓out) · cost · cache% · savings · scroll。**整行左对齐**，
 *      从最左视线起点一条流读下来。
 *    - 行2｜环境上下文（很少变、次要的）：repo ⎇ branch · ⑂worktree · 权限模式。
 *      **整行右对齐**，退到右下角，与行1错开，主次分明。
 * ② 一行内所有项用统一 ` · ` 连接成一条连续流（不再用大留白把信息撕成两半），读感整体。
 * ③ 「两色层次」：同一项内部拆「单位/符号(暗)」+「数值(亮)」两色——方向箭头 ↑↓、⚡、⎇、
 *    $ 符号、分隔点一律暗色(theme.ui.comment)后退；真正的数值(token 数、分支名、model)
 *    用亮色(theme.text.primary)前进。即便全程无告警也有「标签→数值」层次，不再一片灰。
 *    语义告警(上下文超阈红/黄、缓存命中绿、费用超限红/黄、max 档蓝、危险权限红)再点睛。
 *
 * 不折行兜底：两行各 flexWrap="nowrap" + overflow="hidden" + 每个 <Text> wrap="truncate-end"；
 * 行1 极窄时按 dropOrder 从低价值到高价值逐项丢计量项（scroll→savings→cache→cost→tokens→
 * context），model / 旋钮永远保留；行2 极窄时先丢 git 段，权限模式永远保留。
 */

import React from "react";
import stringWidth from "string-width";
import Box from "@sid-code/tui-renderer/components/Box.tsx";
import Text from "@sid-code/tui-renderer/components/Text.tsx";
import type { Usage } from "@sid-code/core/llm/types.ts";
import { theme } from "../semantic-colors.ts";
import { WARNING_MARK, GIT_BRANCH, WORKTREE_MARK, TOKEN_IN, TOKEN_OUT } from "../constants/figures.ts";
import { useStatusLineData, deriveWorktree } from "../hooks/useStatusLineData.ts";
import { useConfig } from "../contexts/ConfigContext.tsx";
import { useCustomStatusLine } from "../statusline/useCustomStatusLine.ts";
import { normalizeCacheUsage } from "@sid-code/core/llm/types.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import { formatLargeNumber } from "../utils/format-number.ts";

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
  /** P1-2：压缩触发点百分比（显示为「17%/82%」）；≤0 或省略则只显示 contextPercent */
  contextTriggerPercent?: number;
  /** P1-5：真实压缩档位，变色据此（与 getCompactionLevel 同源） */
  contextLevel?: "none" | "soft" | "hard" | "emergency";
  model: string;
  scrollPercent?: number;
  /** 10.3：会话累计缓存节省金额（美元） */
  cacheSavingsUSD?: number;
  /**
   * 终端列宽（响应式，随窗口 resize 变化）。用于窄终端下按优先级渐进隐藏区块，
   * 保证状态栏每行不折行。缺省时回退到 stdout.columns，仍可工作只是不随 resize 精确联动。
   */
  termWidth?: number;
}

/** 区内分隔符宽度（" · " = 前后空格 + 点 = 3 列）。 */
const DOT_WIDTH = 3;
/** 外层 paddingX={1} 占左右各 1 列。 */
const PADDING_X = 2;

/** 区内分隔符：同一行项之间统一用它连接成连续流。 */
const Dot: React.FC = () => <Text color={theme.ui.comment}> · </Text>;

/** 一行内的一个「段」：str 供实测列宽，nodes 供渲染（已按两色层次拆好），dropOrder 越大越先丢。 */
interface Segment {
  key: string;
  str: string;
  nodes: React.ReactNode;
  dropOrder: number;
}

/** 把若干段的字符串按 " · " 连接测总宽（n 段 → (n-1) 个 " · "）。 */
function joinedWidth(strs: string[]): number {
  if (strs.length === 0) return 0;
  const textW = strs.reduce((sum, s) => sum + stringWidth(s), 0);
  return textW + DOT_WIDTH * (strs.length - 1);
}

/** 把段数组渲染成「段 · 段 · 段」的连续流。 */
function renderFlow(segs: Segment[]): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  segs.forEach((s, i) => {
    if (i > 0) out.push(<Dot key={`dot-${s.key}`} />);
    out.push(<React.Fragment key={s.key}>{s.nodes}</React.Fragment>);
  });
  return out;
}

export const Footer = React.memo(function Footer(props: FooterProps) {
  const data = useStatusLineData(props);
  const config = useConfig();

  const termWidth =
    props.termWidth ?? (typeof process !== "undefined" ? process.stdout?.columns : undefined) ?? 80;

  // ── 两色层次的两个基线色：暗(单位/符号，后退) + 亮(数值，前进) ──
  const dim = theme.ui.comment;
  const val = theme.text.primary;

  // P1-5 自定义状态栏：配了 statusLine.command 就跑用户脚本，stdout 作状态栏（原样透传 ANSI）。
  const cacheNorm = normalizeCacheUsage(props.usage, SessionState.inferProvider(props.model, config.availableModels));
  const cacheHitRate = cacheNorm.cacheHitTokens > 0 && cacheNorm.promptTotal > 0
    ? Math.round((cacheNorm.cacheHitTokens / Math.max(1, cacheNorm.promptTotal)) * 100)
    : 0;
  const customStatusLine = useCustomStatusLine({
    config: config.statusLine,
    data: {
      cwd: config.cwd,
      gitBranch: props.gitBranch,
      worktree: deriveWorktree(config.cwd),
      permissionMode: props.permissionMode,
      model: props.model,
      inputTokens: props.stockInputTokens,
      outputTokens: props.usage.outputTokens,
      contextPercent: props.contextPercent,
      costUSD: props.costUSD,
      cacheHitRate,
      effort: config.effortDisplay ? (config.effortDisplay.isAuto ? "auto" : config.effortDisplay.level) : "",
      thinking: !!config.thinkingDisplay?.on,
    },
  });

  // ════════════════════════════════════════════════════════════════════════
  // 行1（会话/运行态，左对齐）：model · 旋钮 · 计量
  // ════════════════════════════════════════════════════════════════════════

  // 固定段（永不丢弃）：model（亮+粗，视线锚点）+ raw/vim 暗角标 + 旋钮。
  const fixedSegs: Segment[] = [];
  {
    const idNodes: React.ReactNode[] = [
      <Text key="model" bold color={val} wrap="truncate-end">{data.model}</Text>,
    ];
    if (data.isRaw) idNodes.push(<Text key="raw" color={dim}> ·r</Text>);
    if (data.isVim) idNodes.push(<Text key="vim" color={dim}> ·v</Text>);
    let idStr = data.model + (data.isRaw ? " ·r" : "") + (data.isVim ? " ·v" : "");
    fixedSegs.push({ key: "model", str: idStr, dropOrder: -1, nodes: <>{idNodes}</> });
  }
  if (data.goal) {
    fixedSegs.push({
      key: "goal", str: data.goal.text, dropOrder: -1,
      nodes: <Text color={data.goal.color} wrap="truncate-end">{data.goal.text}</Text>,
    });
  }
  if (data.thinking) {
    // 旋钮区只渲染字形（✻/✧），字形自解释开关态。
    fixedSegs.push({
      key: "thinking", str: data.thinking.glyph, dropOrder: -1,
      nodes: <Text color={data.thinking.color}>{data.thinking.glyph}</Text>,
    });
  }
  if (data.effort) {
    fixedSegs.push({
      key: "effort", str: data.effort.text, dropOrder: -1,
      nodes: <Text color={data.effort.color}>{data.effort.text}</Text>,
    });
  }
  if (data.isPlanMode) {
    fixedSegs.push({
      key: "plan", str: "[PLAN]", dropOrder: -1,
      nodes: <Text bold color={theme.ui.active}>[PLAN]</Text>,
    });
  }

  // 计量段（窄屏可丢，dropOrder 越大越先丢）：context / tokens / cost / cache / savings / scroll。
  const metricSegs: Segment[] = [];

  // context%：默认亮值(有层次)，超阈时由 deriveContextColor 转黄/红点睛。
  if (data.context) {
    const elevated = data.context.color !== theme.ui.comment;
    metricSegs.push({
      key: "context", str: data.context.text, dropOrder: 1,
      nodes: <Text color={elevated ? data.context.color : val}>{data.context.text}</Text>,
    });
  }
  // tokens：↑/↓ 箭头(暗) + 数值(亮)。
  if (data.tokens) {
    const inStr = formatLargeNumber(props.stockInputTokens);
    const outStr = formatLargeNumber(props.usage.outputTokens);
    metricSegs.push({
      key: "tokens", str: `${TOKEN_IN}${inStr} ${TOKEN_OUT}${outStr}`, dropOrder: 2,
      nodes: (
        <>
          <Text color={dim}>{TOKEN_IN}</Text>
          <Text color={val}>{inStr}</Text>
          <Text color={dim}> {TOKEN_OUT}</Text>
          <Text color={val}>{outStr}</Text>
        </>
      ),
    });
  }
  // cost：$/≈$ 符号(暗) + 数值(超限红/黄，否则亮)。
  if (props.costUSD > 0) {
    const m = data.cost.text.match(/^([^\d.]*)(.*)$/);
    const prefix = m?.[1] ?? "$";
    const num = m?.[2] ?? data.cost.text;
    metricSegs.push({
      key: "cost", str: data.cost.text, dropOrder: 3,
      nodes: (
        <>
          <Text color={dim}>{prefix}</Text>
          <Text color={data.cost.color ?? val}>{num}</Text>
        </>
      ),
    });
  }
  // cache：⚡符号(暗) + 命中率(≥50% 绿点睛，否则亮)。
  if (data.cache) {
    const rateColor = data.cache.rate >= 50 ? theme.status.success : val;
    metricSegs.push({
      key: "cache", str: data.cache.text, dropOrder: 4,
      nodes: (
        <>
          <Text color={dim}>⚡</Text>
          <Text color={rateColor}>{data.cache.rate}%</Text>
        </>
      ),
    });
  }
  // savings：金额(绿) + " saved" 后缀(暗)。
  if (data.cacheSavings) {
    const amount = data.cacheSavings.text.replace(/\s*saved\s*$/, "");
    metricSegs.push({
      key: "savings", str: data.cacheSavings.text, dropOrder: 5,
      nodes: (
        <>
          <Text color={theme.status.success}>{amount}</Text>
          <Text color={dim}> saved</Text>
        </>
      ),
    });
  }
  // scroll：↑符号(暗) + 百分比(黄)。
  if (data.scroll) {
    const pct = data.scroll.text.replace(/^↑/, "");
    metricSegs.push({
      key: "scroll", str: data.scroll.text, dropOrder: 6,
      nodes: (
        <>
          <Text color={dim}>↑</Text>
          <Text color={theme.status.warning}>{pct}</Text>
        </>
      ),
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // 行2（环境/上下文，右对齐）：repo ⎇ branch · ⑂worktree · 权限模式
  // ════════════════════════════════════════════════════════════════════════

  const row2Segs: Segment[] = [];
  // git 段（窄屏可丢）：仓库名/分支名/worktree名(亮) + ⎇/⑂ 符号(暗)。
  if (data.repoName || data.gitBranch) {
    const gitNodes: React.ReactNode[] = [];
    const gitStrParts: string[] = [];
    if (data.repoName) {
      gitNodes.push(<Text key="repo" color={val} wrap="truncate-end">{data.repoName}</Text>);
      gitStrParts.push(data.repoName);
    }
    if (data.gitBranch) {
      gitNodes.push(<Text key="gb" color={dim}> {GIT_BRANCH} </Text>);
      gitNodes.push(<Text key="branch" color={val} wrap="truncate-end">{data.gitBranch}</Text>);
      gitStrParts.push(`${GIT_BRANCH} ${data.gitBranch}`);
    }
    if (data.worktree) {
      gitNodes.push(<Text key="wt" color={dim}> {WORKTREE_MARK} </Text>);
      gitNodes.push(<Text key="wtname" color={val} wrap="truncate-end">{data.worktree}</Text>);
      gitStrParts.push(`${WORKTREE_MARK} ${data.worktree}`);
    }
    row2Segs.push({ key: "git", str: gitStrParts.join(" "), dropOrder: 1, nodes: <>{gitNodes}</> });
  }
  // 权限模式（永不丢弃）：default→暗灰降噪；危险态 ⚠ 前缀 + 语义色 + 粗体点睛。
  const permColor = data.permission.isDanger
    ? data.permission.color
    : data.permission.display === "default"
      ? dim
      : data.permission.color;
  const permStr = (data.permission.isDanger ? `${WARNING_MARK} ` : "") + data.permission.display;
  row2Segs.push({
    key: "perm", str: permStr, dropOrder: -1,
    nodes: <Text bold={data.permission.isDanger} color={permColor} wrap="truncate-end">{permStr}</Text>,
  });

  // ── 窄终端渐进隐藏：各行独立按 dropOrder 从大到小丢，直到该行放得下（L4.D）──
  const budget = termWidth - PADDING_X;
  const fitRow = (segs: Segment[]): Segment[] => {
    const kept = [...segs];
    while (kept.length > 0 && joinedWidth(kept.map((s) => s.str)) > budget) {
      // 找可丢项（dropOrder 最大且 >= 0）；没有可丢项则停（固定段 dropOrder<0 永不丢）。
      let worstIdx = -1;
      for (let i = 0; i < kept.length; i++) {
        if (kept[i]!.dropOrder < 0) continue;
        if (worstIdx < 0 || kept[i]!.dropOrder > kept[worstIdx]!.dropOrder) worstIdx = i;
      }
      if (worstIdx < 0) break;
      kept.splice(worstIdx, 1);
    }
    return kept;
  };

  const row1Segs = fitRow([...fixedSegs, ...metricSegs]);
  const row2Kept = fitRow(row2Segs);

  const row1Nodes = renderFlow(row1Segs);
  const row2Nodes = renderFlow(row2Kept);

  // P1-5：配了自定义状态栏且脚本有输出 → 原样渲染脚本 stdout（透传 ANSI），不走内置布局。
  if (customStatusLine !== null) {
    const padLeft = Math.max(0, config.statusLine?.padding ?? 0);
    return (
      <Box paddingX={1} width="100%" flexWrap="nowrap" overflow="hidden">
        {padLeft > 0 && <Box width={padLeft} />}
        <Text wrap="truncate-end">{customStatusLine}</Text>
      </Box>
    );
  }

  // ── 两行布局：行1 左对齐、行2 右对齐（justifyContent 定位）。 ──
  // 关键坑（此前反复截断的真根因）：内层行**不能再写 width="100%"**。外层已 paddingX={1}，
  // 内层的 100% 会按含 padding 的宽度解析、比实际内容区宽 2 列，整行右移溢出右 padding，
  // 最右一个字符被 setCellAt 的边界检查丢弃 → 权限模式恒被截成「skip-perm」（少末字符），
  // 加上 ⚠ 是 ambiguous-width（string-width 记 2 列、ink 渲染按 1 列）时更明显。去掉内层
  // width 后行宽由 flex 父容器（已扣 padding 的内容区）自然决定，右对齐贴齐右 padding 内缘。
  // 内容盒 flexShrink={0}：fitRow 已按实测宽度保证放得下，不允许 Yoga 再压缩误触截断。
  return (
    <Box flexDirection="column" paddingX={1} width="100%">
      {/* 行1·会话/运行态（左对齐） */}
      <Box flexWrap="nowrap" overflow="hidden" justifyContent="flex-start">
        <Box flexShrink={0}>{row1Nodes}</Box>
      </Box>

      {/* 行2·环境/上下文（右对齐） */}
      <Box flexWrap="nowrap" overflow="hidden" justifyContent="flex-end">
        <Box flexShrink={0}>{row2Nodes}</Box>
      </Box>
    </Box>
  );
});
