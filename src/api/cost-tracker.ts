/**
 * 成本追踪
 *
 * 职责（对标 Claude Code 的 usage.ts）：
 * - 按模型累加 token 用量
 * - 计算 USD 成本（区分 input / output / cache read / cache write 计价）
 * - 格式化会话成本摘要（供 /cost 命令和会话结束显示）
 *
 * 与 session/state.ts 的关系：SessionState 已做按模型成本累加（含缓存计价），
 * 本模块提供一个独立、可注入、纯函数式的成本计算器，便于 api 层与子代理单独计费，
 * 并补齐 SessionState 缺的"USD 成本格式化摘要"能力。
 */

import type { Usage } from "../llm/types.ts";

/** 模型定价（每百万 token，USD） */
export interface ModelPricing {
  input: number;
  output: number;
  /** 缓存读取价（通常为 input 的 0.1） */
  cacheRead: number;
  /** 缓存写入价（通常为 input 的 1.25） */
  cacheWrite: number;
}

/** 内置模型定价表 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-20250514": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-4-20250514": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-20250514": { input: 0.25, output: 1.25, cacheRead: 0.025, cacheWrite: 0.3125 },
  "claude-3-5-sonnet-20241022": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  "claude-3-opus-20240229": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
};

/** 未知模型的保守兜底价（USD/M）。
 *  不绑定任何特定模型品牌，取中位偏高值（input $2 / output $10 / 缓存读 $0.2 / 写 $2.5），
 *  介于低价模型（DeepSeek ~$0.14/$0.28）与高价模型（Claude Opus ~$15/$75）之间。
 *  原则：宁可高估触发预算守卫，也不归零放任烧钱。 */
const FALLBACK_PRICING: ModelPricing = {
  input: 2,
  output: 10,
  cacheRead: 0.2,
  cacheWrite: 2.5,
};

/** 解析模型定价（精确匹配 + 正向最长前缀匹配） */
export function resolvePricing(model: string): ModelPricing {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  // P1-5：只保留正向 model.startsWith(key) 并取最长前缀。
  // 去掉危险的反向 key.startsWith(model)——它会把短/截断模型名（如 "deepseek-v4"）
  // 错配到表中先定义的更贵表项（"deepseek-v4-pro"），且依赖键顺序、非确定。
  // 与 session/state.ts:getPricing 口径保持一致（主题 A：消灭多套实现的修复不同步）。
  let best: ModelPricing = FALLBACK_PRICING;
  let bestLen = 0;
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(key) && key.length > bestLen) {
      best = pricing;
      bestLen = key.length;
    }
  }
  return best;
}

/**
 * 计算单次请求的 USD 成本。
 *
 * 注意：usage.inputTokens 通常已含 cacheRead + cacheCreation（Anthropic 语义），
 * 因此普通 input = inputTokens - cacheRead - cacheCreation，避免重复计价。
 */
export function calculateUSDCost(model: string, usage: Usage): number {
  const p = resolvePricing(model);
  const M = 1_000_000;
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cacheWrite = usage.cacheCreationInputTokens ?? 0;
  const regularInput = Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
  return (
    (regularInput * p.input) / M +
    (usage.outputTokens * p.output) / M +
    (cacheRead * p.cacheRead) / M +
    (cacheWrite * p.cacheWrite) / M
  );
}

/** 单模型用量统计 */
export interface ModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  requestCount: number;
  costUSD: number;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** 成本追踪器 */
export class CostTracker {
  totalCostUSD = 0;
  totalAPIDurationMs = 0;
  readonly modelUsage: Record<string, ModelUsageEntry> = {};

  /** 累加一次 API 调用的用量与成本 */
  record(model: string, usage: Usage, durationMs = 0): number {
    if (!this.modelUsage[model]) {
      this.modelUsage[model] = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        requestCount: 0,
        costUSD: 0,
      };
    }
    const mu = this.modelUsage[model];
    // input 取最后一次（已含全部历史，累加会 N² 过计数，与 SessionState 一致）
    mu.inputTokens = usage.inputTokens;
    mu.outputTokens += usage.outputTokens;
    mu.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
    mu.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0;
    mu.requestCount++;

    const cost = calculateUSDCost(model, usage);
    mu.costUSD += cost;
    this.totalCostUSD += cost;
    this.totalAPIDurationMs += durationMs;
    return cost;
  }

  reset(): void {
    this.totalCostUSD = 0;
    this.totalAPIDurationMs = 0;
    for (const k of Object.keys(this.modelUsage)) delete this.modelUsage[k];
  }

  /** 格式化会话成本摘要 */
  formatSummary(): string {
    const lines: string[] = [`总成本: $${this.totalCostUSD.toFixed(4)}`];
    for (const [model, mu] of Object.entries(this.modelUsage)) {
      const cacheInfo =
        mu.cacheReadInputTokens > 0
          ? ` (${formatTokens(mu.cacheReadInputTokens)} cache read)`
          : "";
      lines.push(
        `  ${model}: ${formatTokens(mu.inputTokens)} in, ${formatTokens(mu.outputTokens)} out${cacheInfo} (${mu.requestCount} 次请求)`,
      );
    }
    lines.push(`API 耗时: ${(this.totalAPIDurationMs / 1000).toFixed(1)}s`);
    return lines.join("\n");
  }
}
