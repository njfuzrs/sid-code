/**
 * 成本追踪
 *
 * 职责（对标 Claude Code 的 usage.ts）：
 * - 按模型累加 token 用量
 * - 计算 USD 成本（区分 input / output / cache read / cache write 计价）
 * - 格式化会话成本摘要（供 /cost 命令和会话结束显示）
 *
 * 与 session/state.ts 的关系：本模块是定价的**唯一真相源**。SessionState 的
 * 成本计算复用 resolvePricing()，不再维护独立定价表。
 *
 * 数据来源：定价数据统一在 model-registry.ts 中维护，本文件仅查询。
 */

import type { Usage } from "../llm/types.ts";
import { normalizeCacheUsage } from "../llm/types.ts";
import { lookupRegistry } from "../llm/model-registry.ts";

/** 模型定价（每百万 token，USD） */
export interface ModelPricing {
  input: number;
  output: number;
  /** 缓存读取价（通常为 input 的 0.1），不填调用方按 input×0.1 近似 */
  cacheRead?: number;
  /** 缓存写入价（通常为 input 的 1.25），不填调用方按 input×1.25 近似 */
  cacheWrite?: number;
}

/** @deprecated 旧导出别名，新代码勿用。定价数据已统一到 model-registry.ts */
export const MODEL_PRICING: Record<string, ModelPricing> = {};

/** 未知模型的保守兜底价（USD/M）。
 *  不绑定任何特定模型品牌，取中位偏高值（input $2 / output $10），
 *  介于低价模型（DeepSeek ~$0.14/$0.28）与高价模型（Claude Opus ~$15/$75）之间。
 *  原则：宁可高估触发预算守卫，也不归零放任烧钱。 */
const FALLBACK_PRICING: ModelPricing = {
  input: 2,
  output: 10,
  cacheRead: 0.2,
  cacheWrite: 2.5,
};

/** availableModels 中一项的简化类型（仅 resolvePricing / inferProvider 需要的字段） */
export interface PricingModelEntry {
  name?: string;
  provider?: string;
  pricing?: ModelPricing;
}

/**
 * 解析模型定价 — 定价解析的**唯一入口**。
 *
 * 优先级：
 *   1. availableModels[].pricing —— 用户配置优先（权威）
 *   2. model-registry.ts 统一注册表（精确/前缀/家族匹配）
 *   3. null —— 未知模型，调用方自行走兜底价
 *
 * @param model 模型名
 * @param availableModels 用户配置的模型列表（可选，携带权威 pricing）
 */
export function resolvePricing(
  model: string,
  availableModels?: PricingModelEntry[],
): ModelPricing | null {
  // 1. 用户配置优先：availableModels 里同名模型声明的 pricing 是权威值
  const userModel = availableModels?.find(m => m.name === model);
  if (userModel?.pricing && userModel.pricing.input > 0) {
    return userModel.pricing;
  }

  // 2. 从统一注册表查找
  const entry = lookupRegistry(model);
  return entry?.pricing ?? null;
}

/**
 * 按模型名推断 provider（成本计算口径区分用）。
 *
 * normalizeCacheUsage 的三段拆分依赖 provider：Anthropic 的 inputTokens 是未命中余量，
 * OpenAI/DeepSeek 的 inputTokens 含命中。与 SessionState.inferProvider 保持同源启发式，
 * 避免两处口径漂移（此处不反向 import SessionState 以防循环依赖）。
 *
 * 优先级：availableModels[].provider（用户配置，权威） > 启发式（claude* → anthropic，其余 → openai）。
 */
export function inferPricingProvider(
  model: string,
  availableModels?: PricingModelEntry[],
): string {
  const mc = availableModels?.find(m => m.name === model);
  if (mc?.provider) return mc.provider;
  return /^claude/i.test(model) ? "anthropic" : "openai";
}

/**
 * 计算单次请求的 USD 成本（方案 §2.3 口径统一）。
 *
 * **修复后**：统一经 {@link normalizeCacheUsage} 按 provider 归一化为互斥三段
 * （hit / write / uncached）后分别计价，不再手工做减法，与 session/state.ts 同口径。
 */
export function calculateUSDCost(
  model: string,
  usage: Usage,
  availableModels?: PricingModelEntry[],
  provider?: string,
): number {
  const p = resolvePricing(model, availableModels) ?? FALLBACK_PRICING;
  const M = 1_000_000;
  const prov = provider ?? inferPricingProvider(model, availableModels);
  const n = normalizeCacheUsage(usage, prov);
  return (
    (n.uncachedInputTokens * p.input) / M +
    (n.outputTokens * p.output) / M +
    (n.cacheHitTokens * (p.cacheRead ?? p.input * 0.1)) / M +
    (n.cacheWriteTokens * (p.cacheWrite ?? p.input * 1.25)) / M
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
  private availableModels: PricingModelEntry[] = [];

  /** 设置用户配置的模型列表（带定价信息），供成本计算时优先使用 */
  setAvailableModels(models: PricingModelEntry[]): void {
    this.availableModels = models;
  }

  /** 累加一次 API 调用的用量与成本 */
  record(model: string, usage: Usage, durationMs = 0, provider?: string): number {
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
    mu.inputTokens = usage.inputTokens;
    mu.outputTokens += usage.outputTokens;
    mu.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
    mu.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0;
    mu.requestCount++;

    const cost = calculateUSDCost(model, usage, this.availableModels, provider);
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
