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
import { sameEndpoint } from "../llm/endpoint-key.ts";
import { lookupGatewayPricing } from "../llm/gateway-pricing.ts";

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
  /**
   * 厂商真实模型 id（缺省 = name）。
   *
   * 计价本身**不用**它（`resolvePricing` 刻意按 (name, endpoint) 复合键算，两个渠道
   * 该有各自的价）；但按名做**启发式推断**的地方必须用它 —— 见 inferPricingProvider /
   * SessionState.inferProvider：别名带渠道前缀（gw-claude-sonnet-5）时 `/^claude/i`
   * 会判错 provider，缓存三段拆分（hit/write/未命中）随之算错。
   */
  modelId?: string;
  provider?: string;
  baseURL?: string;
  pricing?: ModelPricing;
}

/**
 * 解析模型定价 — 定价解析的**唯一入口**。
 *
 * 优先级（新增端点维度，向后兼容——不传 baseURL 时行为与旧版等价）：
 *   1. 用户手写「模型名 + 端点」精确复合键（权威，同名不同端点各自计价）
 *   2. 用户手写「仅模型名」（兼容旧配置：没配端点时命中第一条同名）
 *   3. 网关采集价（gateway-pricing.ts，按渠道名精确匹配，修正前缀剥离低估）
 *   4. model-registry.ts 统一注册表（精确/前缀/家族匹配；前缀剥离已降为末位兜底）
 *   5. null —— 未知模型，调用方自行走兜底价
 *
 * @param model 模型名
 * @param availableModels 用户配置的模型列表（可选，携带权威 pricing）
 * @param baseURL 本次请求实际走的端点（可选；用于「模型名 + 端点」精确匹配）
 */
export function resolvePricing(
  model: string,
  availableModels?: PricingModelEntry[],
  baseURL?: string,
): ModelPricing | null {
  // 1. 用户手写「模型名 + 端点」精确复合键：同名不同端点各自计价（最高权威）。
  //    仅当 baseURL 传入时启用；两端都过归一化，杜绝斜杠/大小写漏配。
  if (baseURL !== undefined) {
    const exact = availableModels?.find(
      (m) => m.name === model && sameEndpoint(m.baseURL, baseURL),
    );
    if (exact?.pricing && exact.pricing.input > 0) {
      return exact.pricing;
    }
  }

  // 2. 用户手写「仅模型名」：兼容旧配置（无端点维度时命中第一条同名）。
  const userModel = availableModels?.find((m) => m.name === model);
  if (userModel?.pricing && userModel.pricing.input > 0) {
    return userModel.pricing;
  }

  // 3. 网关采集价：按渠道名精确匹配（ali-/tx-/origin- 前缀天然区分渠道）。
  //    命中即返回，从而根本走不到步骤 4 注册表的前缀剥离——修正「渠道名被剥成官方名套官方价」的低估。
  const gateway = lookupGatewayPricing(model, baseURL);
  if (gateway) return gateway;

  // 4. 从统一注册表查找（前缀剥离在此仅作「查无此模型」的最后兜底）。
  //
  // ⚠ 只有**这一步**按真名查，步骤 1-3 一律按别名 —— 两者不矛盾，是分工：
  //   - 步骤 1/2（用户手写 pricing）与步骤 3（网关采集价）是「这条渠道的价」，
  //     必须按别名，否则两个渠道的差价被抹平（§2.1「计价留在别名侧」正是指这几步）；
  //   - 本步是「这到底是什么模型」的注册表兜底，按 §2.1 就该用真名。喂前缀式别名
  //     （gw-claude-sonnet-4-6）必然 miss → 返回 null → 调用方落 FALLBACK_PRICING，
  //     实测 1M in / 200K out 从 $6.00 算成 $4.00（0.67x），静默少算且不报错，
  //     直接污染「更省」方向的度量底座。
  // 别名与真名相同时 resolveWireModel 原样返回，行为不变。
  const { resolveWireModel } = require("../llm/wire-model.ts");
  const entry = lookupRegistry(resolveWireModel(model, availableModels));
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
export function inferPricingProvider(model: string, availableModels?: PricingModelEntry[]): string {
  const mc = availableModels?.find((m) => m.name === model);
  if (mc?.provider) return mc.provider;
  // 兜底启发式必须按**真名**判：别名带渠道前缀时（gw-claude-sonnet-5）`/^claude/i`
  // 判成 openai，normalizeCacheUsage 的三段拆分口径随之反了（Anthropic 的
  // inputTokens 是未命中余量，OpenAI 的含命中），成本静默算错、不报错。
  // 用户显式配了 provider 时上面已返回，走不到这里。
  const { resolveWireModel } = require("../llm/wire-model.ts");
  const wire: string = resolveWireModel(model, availableModels);
  return /^claude/i.test(wire) ? "anthropic" : "openai";
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
  baseURL?: string,
): number {
  const p = resolvePricing(model, availableModels, baseURL) ?? FALLBACK_PRICING;
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
  record(model: string, usage: Usage, durationMs = 0, provider?: string, baseURL?: string): number {
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

    const cost = calculateUSDCost(model, usage, this.availableModels, provider, baseURL);
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
        mu.cacheReadInputTokens > 0 ? ` (${formatTokens(mu.cacheReadInputTokens)} cache read)` : "";
      lines.push(
        `  ${model}: ${formatTokens(mu.inputTokens)} in, ${formatTokens(mu.outputTokens)} out${cacheInfo} (${mu.requestCount} 次请求)`,
      );
    }
    lines.push(`API 耗时: ${(this.totalAPIDurationMs / 1000).toFixed(1)}s`);
    return lines.join("\n");
  }
}
