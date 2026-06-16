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
import { TOKEN_IN, TOKEN_OUT } from "../constants/figures.ts";
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
} {
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
  return { display, color };
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

/** 状态栏聚合数据（纯数据，无 React 元素）。 */
export interface StatusLineData {
  itemColor: string;
  cwdDisplay: string;
  permission: { display: string; color: string };
  isPlanMode: boolean;
  gitBranch: string;
  isDebug: boolean;
  isRaw: boolean;
  isVim: boolean;
  tokenText: string;
  cache: { rate: number; text: string; color: string } | null;
  cost: { text: string; color: string | undefined };
  context: { text: string; color: string } | null;
  model: string;
  scroll: { text: string } | null;
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
      tokenText: `${TOKEN_IN} ${formatLargeNumber(stockInputTokens)}  ${TOKEN_OUT} ${formatLargeNumber(usage.outputTokens)}`,
      cache: deriveCacheMetrics(usage, model, config.availableModels),
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
    };
  }, [
    config.cwd,
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
  ]);
}
