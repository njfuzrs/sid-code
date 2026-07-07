/**
 * 状态栏数据聚合 Hook — LY1
 *
 * 此前 Footer.tsx 在渲染体内逐列即席计算（路径缩短、权限色、缓存命中率、费用色、
 * 上下文色、滚动百分比…），数据派生与 React 元素构建耦合在一起，难以单测且每次渲染
 * 重复重算。本 hook 把所有"纯数据派生"抽出：输入 props + context，输出结构化数据
 * （字符串 + 语义色 token + 是否显示），Footer 仅负责把数据映射为 <Text> 列。
 *
 * 对齐 claude-code 的 statusline 数据/渲染分离。所有派生集中一处，便于测试与复用。
 */

import { homedir } from "os";
import { useMemo } from "react";
import type { Usage } from "../../llm/types.ts";
import { normalizeCacheUsage } from "../../llm/types.ts";
import { SessionState } from "../../session/state.ts";
import { theme } from "../semantic-colors.ts";
import { useUIState } from "../contexts/UIStateContext.tsx";
import { useConfig } from "../contexts/ConfigContext.tsx";
import { useSettings } from "../contexts/SettingsContext.tsx";
import { formatLargeNumber } from "../utils/format-number.ts";
import { TOKEN_IN, TOKEN_OUT, EFFORT_GLYPHS, EFFORT_AUTO, THINKING_ON, THINKING_OFF } from "../constants/figures.ts";
import type { PricingModelEntry } from "../../api/cost-tracker.ts";

/** 缩短路径：~ 替换 home，超长时只保留最后两级。导出供测试与 Footer 复用。 */
export function shortenPath(p: string, maxLen = 25, home = homedir()): string {
  let display = p.startsWith(home) ? "~" + p.slice(home.length) : p;
  if (display.length > maxLen) {
    const parts = display.split("/");
    if (parts.length > 2) {
      display = "…/" + parts.slice(-2).join("/");
    }
  }
  return display;
}

/** 权限模式 → 显示文本 + 语义色。纯函数，可单测。 */
export function derivePermission(permissionMode: string): {
  display: string;
  color: string;
  isDanger: boolean;
} {
  const isDanger =
    permissionMode === "dangerously-skip-permissions" ||
    permissionMode === "deny-write";
  const color = (() => {
    switch (permissionMode) {
      case "plan":
        return theme.ui.active;
      case "deny-write":
        return theme.status.error;
      case "always-allow":
      case "dontAsk":
      case "dangerously-skip-permissions":
        return theme.status.warning;
      default:
        return theme.status.success;
    }
  })();
  const display =
    permissionMode === "dangerously-skip-permissions" ? "skip-perms" : permissionMode;
  return { display, color, isDanger };
}

/** 上下文百分比 → 语义色（≥90 红 / ≥70 黄 / 其余默认）。 */
export function deriveContextColor(contextPercent: number, defaultColor: string): string {
  if (contextPercent >= 90) return theme.status.error;
  if (contextPercent >= 70) return theme.status.warning;
  return defaultColor;
}

/** 费用 → 文本 + 语义色（≥95% 红 / ≥80% 黄）。DeepSeek 用 ≈$ 标注估算。 */
export function deriveCost(
  costUSD: number,
  costLimit: number,
  model: string,
): { text: string; color: string | undefined } {
  const isExchangeRateConverted = /deepseek/i.test(model);
  const prefix = isExchangeRateConverted ? "≈$" : "$";
  const text = costUSD > 0 ? `${prefix}${costUSD.toFixed(4)}` : `${prefix}0`;
  const color = (() => {
    if (costLimit <= 0 || costUSD <= 0) return undefined;
    const pct = (costUSD / costLimit) * 100;
    if (pct >= 95) return theme.status.error;
    if (pct >= 80) return theme.status.warning;
    return undefined;
  })();
  return { text, color };
}

/** 缓存命中率派生：命中 0 或无缓存字段时返回 null（不显示，避免对无缓存模型显示 0% 误导）。 */
export function deriveCacheMetrics(
  usage: Usage,
  model: string,
  availableModels?: PricingModelEntry[],
): { rate: number; text: string; color: string } | null {
  const n = normalizeCacheUsage(usage, SessionState.inferProvider(model, availableModels));
  if (n.cacheHitTokens > 0 && n.promptTotal > 0) {
    const rate = Math.round((n.cacheHitTokens / Math.max(1, n.promptTotal)) * 100);
    return {
      rate,
      text: `⚡${rate}%`,
      color: rate >= 50 ? theme.status.success : theme.ui.comment,
    };
  }
  return null;
}

/**
 * 10.3：缓存节省金额展示派生。
 * 展示本次会话累计因缓存命中而节省的美元金额，比单纯命中率更直观有说服力。
 * 返回 null 表示节省为 0 或无数据（不显示）。
 */
export function deriveCacheSavings(
  cacheSavingsUSD: number,
): { text: string; color: string } | null {
  if (cacheSavingsUSD <= 0) return null;
  // 格式化：< $0.01 不显示（避免精度误导），>= $1 只保留 2 位小数
  if (cacheSavingsUSD < 0.01) return null;
  const formatted = cacheSavingsUSD >= 1
    ? `$${cacheSavingsUSD.toFixed(2)}`
    : `$${cacheSavingsUSD.toFixed(3)}`;
  return {
    text: `${formatted} saved`,
    color: theme.status.success,
  };
}

/**
 * 推理强度展示派生（effort 列）：档位 → 字形 + 文本 + 语义色。
 * - null（模型不支持档位）→ 返回 null，Footer 不渲染该列。
 * - auto 态 → 空心点 ◌ + 灰色，文本带 (auto) 后缀提示「跟随默认」。
 * - 显式档位 → 填充方块字形（▁▃▅█）+ 档位名；max 用品牌色点睛，其余用默认灰。
 */
export function deriveEffort(
  effortDisplay: { level: "low" | "medium" | "high" | "max"; isAuto: boolean } | null,
  defaultColor: string,
): { glyph: string; text: string; color: string } | null {
  if (!effortDisplay) return null;
  const { level, isAuto } = effortDisplay;
  if (isAuto) {
    // auto 态：空心点 ◌ 前缀 + 档位名。◌ 字形自解释「跟随默认」，不再写 (auto) 文字后缀（冗余）。
    return { glyph: EFFORT_AUTO, text: `${EFFORT_AUTO} ${level}`, color: defaultColor };
  }
  // max 档用品牌强调色点睛（最高强度值得一眼可辨），其余档位用默认灰，保持克制。
  const color = level === "max" ? theme.ui.active : defaultColor;
  return { glyph: EFFORT_GLYPHS[level], text: level, color };
}

/**
 * 思考开关展示派生（thinking 列）：开/关 → 字形 + 文本 + 语义色。
 * - null（模型不支持思考开关）→ 返回 null，Footer 不渲染该列。
 * - 开启 → 实心星 ✻ + 成功色（点睛）；关闭 → 空心星 ✧ + 灰色。
 * - auto 态在文本加 (auto) 后缀，颜色保持灰（不点睛，因非用户显式开启）。
 */
export function deriveThinking(
  thinkingDisplay: { on: boolean; isAuto: boolean } | null,
  defaultColor: string,
): { glyph: string; text: string; color: string } | null {
  if (!thinkingDisplay) return null;
  const { on, isAuto } = thinkingDisplay;
  // 去掉 (auto) 文字后缀：字形已自解释(✻ 开 / ✧ 关)，Footer 旋钮区只渲染 glyph。
  // 保留 text 供其它场景/测试使用，但不再堆 (auto) 冗余文字。
  const text = on ? "on" : "off";
  const glyph = on ? THINKING_ON : THINKING_OFF;
  const color = on && !isAuto ? theme.status.success : defaultColor;
  return { glyph, text, color };
}

/** /goal：目标进度派生。null = 无活跃目标。 */
function deriveGoal(
  goalDisplay: { turnsUsed: number; maxTurns: number; progress?: number; status: string } | null,
  defaultColor: string,
): { text: string; color: string } | null {
  if (!goalDisplay) return null;
  const { turnsUsed, maxTurns, progress, status } = goalDisplay;
  if (status !== "active" && status !== "paused") return null;
  const pct = progress ?? Math.round((turnsUsed / maxTurns) * 100);
  const text = status === "paused"
    ? `⏸ ${turnsUsed}/${maxTurns}`
    : `${turnsUsed}/${maxTurns} ~${pct}%`;
  const color = status === "paused"
    ? theme.status.warning
    : pct >= 80
      ? theme.status.warning
      : defaultColor;
  return { text, color };
}

/** 状态栏聚合数据（纯数据，无 React 元素）。 */
export interface StatusLineData {
  itemColor: string;
  cwdDisplay: string;
  permission: { display: string; color: string; isDanger: boolean };
  isPlanMode: boolean;
  gitBranch: string;
  isDebug: boolean;
  isRaw: boolean;
  isVim: boolean;
  /** token 计量（null = 会话尚无输入/输出，隐藏该列，避免 ↑0 ↓0 噪音） */
  tokens: { text: string } | null;
  cache: { rate: number; text: string; color: string } | null;
  /** 10.3：缓存节省金额（null = 节省为 0 或不足阈值，不渲染该列） */
  cacheSavings: { text: string; color: string } | null;
  cost: { text: string; color: string | undefined };
  context: { text: string; color: string } | null;
  model: string;
  scroll: { text: string } | null;
  /** effort 列派生（null = 模型不支持档位，不渲染该列） */
  effort: { glyph: string; text: string; color: string } | null;
  /** thinking 列派生（null = 模型不支持思考开关，不渲染该列） */
  thinking: { glyph: string; text: string; color: string } | null;
  /** /goal 列派生（null = 无活跃目标，不渲染该列） */
  goal: { text: string; color: string } | null;
}

export interface StatusLineInput {
  permissionMode: string;
  isPlanMode: boolean;
  gitBranch: string;
  debug: boolean;
  usage: Usage;
  /** 末次输入 token（stock 口径），用于状态栏展示当前上下文大小 */
  stockInputTokens: number;
  costUSD: number;
  costLimit: number;
  contextPercent: number;
  model: string;
  scrollPercent?: number;
  /** 10.3：会话累计缓存节省金额（美元） */
  cacheSavingsUSD?: number;
}

/**
 * 聚合状态栏所需的全部派生数据。
 * 从 props 取会话/用量数据，从 context 取 UI/config/settings 标志。
 */
export function useStatusLineData(input: StatusLineInput): StatusLineData {
  const { renderMarkdown } = useUIState();
  const config = useConfig();
  const settings = useSettings();

  const {
    permissionMode,
    isPlanMode,
    gitBranch,
    debug,
    usage,
    stockInputTokens,
    costUSD,
    costLimit,
    contextPercent,
    model,
    scrollPercent,
    cacheSavingsUSD,
  } = input;

  return useMemo<StatusLineData>(() => {
    const itemColor = theme.ui.comment;
    const showScroll = scrollPercent !== undefined && scrollPercent < 100;
    return {
      itemColor,
      cwdDisplay: shortenPath(config.cwd),
      permission: derivePermission(permissionMode),
      isPlanMode,
      gitBranch,
      isDebug: debug,
      isRaw: !renderMarkdown,
      isVim: !!settings.vimMode,
      // 零值隐藏：会话尚无输入/输出时不显示 ↑0 ↓0（纯噪音），与 context 隐藏条件一致。
      tokens:
        stockInputTokens === 0 && usage.outputTokens === 0
          ? null
          : {
              text: `${TOKEN_IN} ${formatLargeNumber(stockInputTokens)}  ${TOKEN_OUT} ${formatLargeNumber(usage.outputTokens)}`,
            },
      cache: deriveCacheMetrics(usage, model, config.availableModels),
      cacheSavings: deriveCacheSavings(cacheSavingsUSD ?? 0),
      cost: deriveCost(costUSD, costLimit, model),
      // 没有任何用户交互（API 调用）时不显示上下文占用，避免系统开销造成虚假百分比
      context:
        usage.inputTokens === 0 && usage.outputTokens === 0
          ? null
          : {
              text: `${contextPercent}%`,
              color: deriveContextColor(contextPercent, itemColor),
            },
      model,
      scroll: showScroll ? { text: `↑${scrollPercent}%` } : null,
      effort: deriveEffort(config.effortDisplay, itemColor),
      thinking: deriveThinking(config.thinkingDisplay, itemColor),
      goal: deriveGoal(config.goalDisplay, itemColor),
    };
  }, [
    config.cwd,
    config.effortDisplay,
    config.thinkingDisplay,
    config.goalDisplay,
    permissionMode,
    isPlanMode,
    gitBranch,
    debug,
    renderMarkdown,
    settings.vimMode,
    usage,
    stockInputTokens,
    costUSD,
    costLimit,
    contextPercent,
    model,
    scrollPercent,
    cacheSavingsUSD,
  ]);
}
