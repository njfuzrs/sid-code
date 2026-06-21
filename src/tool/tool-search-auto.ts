/**
 * ToolSearch auto 模式 —— 阈值判定纯函数
 *
 * 对标 claude-code `utils/toolSearch.ts` 的 getToolSearchMode / checkAutoThreshold。
 *
 * config.toolSearch 支持三种形态：
 *   - boolean：true = 恒开（tst），false/undefined = 恒关（standard）
 *   - "auto"：按延迟工具 token 占上下文窗口比例自动判定（默认阈值 10%）
 *   - number：自定义百分比阈值（0 = 恒开，100 = 恒关，1-99 = 按比例判定）
 *
 * 判定时机：每会话首轮前计算一次，结果缓存为局部变量供整个 queryLoop 使用。
 * 避免会话中途从"全量"切到"延迟"导致模型上下文中工具突然消失（幻觉/重试 churn）。
 */

import { TokenEstimator } from "../llm/token-estimator.ts";
import type { ToolDefinition } from "../llm/types.ts";

/** 默认 auto 阈值百分比（对标 claude-code DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE = 10） */
const DEFAULT_AUTO_PERCENTAGE = 10;

/** toolSearch 配置联合类型 */
export type ToolSearchConfigValue = boolean | "auto" | number | undefined;

/** 解析后的模式 */
export interface ToolSearchParsedMode {
  mode: "on" | "off" | "auto";
  /** auto 模式的百分比阈值（仅 mode=auto 时有意义） */
  percentage: number;
}

/**
 * 解析 toolSearch 配置值为结构化模式。
 *
 * 映射规则（对标 claude-code getToolSearchMode）：
 *   undefined / false        → off（standard）
 *   true                     → on（tst，恒开）
 *   "auto"                   → auto，percentage=10
 *   number ≤ 0              → on（阈值 0% = 总是启用）
 *   number ≥ 100            → off（阈值 100% = 永远达不到）
 *   number 1-99             → auto，percentage=该数字
 */
export function parseToolSearchConfig(value: ToolSearchConfigValue): ToolSearchParsedMode {
  if (value === undefined || value === false) return { mode: "off", percentage: 0 };
  if (value === true) return { mode: "on", percentage: 0 };
  if (value === "auto") return { mode: "auto", percentage: DEFAULT_AUTO_PERCENTAGE };
  if (typeof value === "number") {
    if (value <= 0) return { mode: "on", percentage: 0 };
    if (value >= 100) return { mode: "off", percentage: 0 };
    return { mode: "auto", percentage: Math.max(0, Math.min(100, value)) };
  }
  return { mode: "off", percentage: 0 };
}

/** auto 阈值判定的输入 */
export interface AutoThresholdInput {
  /** 当前主模型名（用于查上下文窗口大小） */
  model: string;
  /** 用户配置的模型列表（可能声明 contextWindow，权威来源） */
  availableModels?: Array<{ name?: string; contextWindow?: number }>;
  /** 延迟工具的定义列表（用于估算 token 总数） */
  deferredDefinitions: ToolDefinition[];
}

/**
 * auto 模式阈值判定：延迟工具 token 总数 >= 上下文窗口 × 阈值% 即启用延迟。
 *
 * 使用已有的 TokenEstimator（estimateTools + getContextLimit），不引入新依赖。
 * 只在工具定义确实"撑爆"上下文时才开延迟——少量 MCP 工具时全量更方便。
 */
export function checkAutoThreshold(
  input: AutoThresholdInput,
  percentage: number,
): boolean {
  const estimator = new TokenEstimator();
  const deferredTokens = estimator.estimateTools(input.deferredDefinitions);
  const contextWindow = estimator.getContextLimit(input.model, input.availableModels);
  const threshold = Math.floor((contextWindow * percentage) / 100);
  return deferredTokens >= threshold;
}

/**
 * 一站式判定：config.toolSearch 配置 + 当前工具集 → 本会话是否启用延迟加载。
 *
 * queryLoop 首轮前调用一次，结果缓存到局部变量。
 *
 * @returns true = 启用延迟加载（用 activeDefinitions + <available-deferred-tools> 注入）
 */
export function resolveToolSearchEnabled(
  configValue: ToolSearchConfigValue,
  input: AutoThresholdInput,
): boolean {
  const parsed = parseToolSearchConfig(configValue);
  switch (parsed.mode) {
    case "on":
      return true;
    case "off":
      return false;
    case "auto":
      return checkAutoThreshold(input, parsed.percentage);
  }
}

/**
 * 解析环境变量 SID_CODE_TOOL_SEARCH 为 ToolSearchConfigValue。
 *
 * 支持格式（对标 claude-code ENABLE_TOOL_SEARCH）：
 *   "true"            → true（恒开）
 *   "false"           → false（恒关）
 *   "auto"            → "auto"
 *   "auto:N"          → N（百分比）
 *   纯数字字符串     → 对应数字
 *   其它             → undefined（不覆盖）
 */
export function parseToolSearchEnv(raw: string | undefined): ToolSearchConfigValue {
  if (!raw || raw === "") return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "auto") return "auto";
  if (raw.startsWith("auto:")) {
    const pct = parseInt(raw.slice(5), 10);
    return isNaN(pct) ? "auto" : pct;
  }
  const n = parseInt(raw, 10);
  if (!isNaN(n)) return n;
  return undefined;
}
