/**
 * Token 计量器——记录每次 LLM 调用的 token 用量并发送 OTel metric
 * 复用 SessionState 的定价逻辑，不重复维护定价表
 */

import type { TelemetryBus } from "../bus.ts";
import type { Attributes } from "../types.ts";
import type { Usage } from "../../llm/types.ts";

/** 单次 LLM 调用的 token 用量记录 */
export interface TokenUsageRecord {
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUSD: number;
  cacheSavingsUSD: number;
  timestamp: number;
  sessionId?: string;
}

/** TokenMeter 记录参数 */
export interface TokenRecordParams {
  model: string;
  provider: string;
  usage: Usage;
  costUSD: number;
  sessionId?: string;
}

/** 成本计算函数签名（复用 SessionState.calculateCost） */
export type CostCalculator = (model: string, usage: Usage) => number;

export class TokenMeter {
  private usages: TokenUsageRecord[] = [];

  constructor(
    private bus: TelemetryBus | null,
    private calculateCost: CostCalculator,
  ) {}

  /** 记录一次 LLM 调用的 token 用量，返回 { costUSD, cacheSavingsUSD } */
  record(params: TokenRecordParams): { costUSD: number; cacheSavingsUSD: number } {
    const { model, provider, usage, costUSD, sessionId } = params;

    // 计算缓存节省：假设所有 cacheRead token 都按正常 input 价格计费时的差额
    const noCacheUsage: Usage = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      // 不传缓存字段，让 calculateCost 按全价计算
    };
    const noCacheCost = this.calculateCost(model, noCacheUsage);
    const cacheSavingsUSD = Math.max(0, noCacheCost - costUSD);

    const record: TokenUsageRecord = {
      model,
      provider,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadInputTokens ?? 0,
      cacheCreationTokens: usage.cacheCreationInputTokens ?? 0,
      costUSD,
      cacheSavingsUSD,
      timestamp: Date.now(),
      sessionId,
    };
    this.usages.push(record);

    // 发送 OTel metric
    if (this.bus?.isEnabled()) {
      const attrs: Attributes = {
        "gen_ai.request.model": model,
        "gen_ai.provider.name": provider,
      };
      if (sessionId) attrs["gen_ai.conversation.id"] = sessionId;

      this.bus.recordMetric({
        name: "gen_ai.client.token.usage",
        value: usage.inputTokens,
        timestamp: Date.now(),
        attributes: { ...attrs, "gen_ai.token.type": "input" },
        type: "counter",
      });
      this.bus.recordMetric({
        name: "gen_ai.client.token.usage",
        value: usage.outputTokens,
        timestamp: Date.now(),
        attributes: { ...attrs, "gen_ai.token.type": "output" },
        type: "counter",
      });
      if (record.cacheReadTokens > 0) {
        this.bus.recordMetric({
          name: "gen_ai.client.token.usage",
          value: record.cacheReadTokens,
          timestamp: Date.now(),
          attributes: { ...attrs, "gen_ai.token.type": "cache_read" },
          type: "counter",
        });
      }
      this.bus.recordMetric({
        name: "sidcode.cost.usd",
        value: costUSD,
        timestamp: Date.now(),
        attributes: attrs,
        type: "counter",
      });
      if (cacheSavingsUSD > 0) {
        this.bus.recordMetric({
          name: "sidcode.cost.cache_savings_usd",
          value: cacheSavingsUSD,
          timestamp: Date.now(),
          attributes: attrs,
          type: "counter",
        });
      }
    }

    return { costUSD, cacheSavingsUSD };
  }

  /** 按模型聚合成本 */
  getCostByModel(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const u of this.usages) {
      result[u.model] = (result[u.model] ?? 0) + u.costUSD;
    }
    return result;
  }

  /** 获取总成本 */
  getTotalCost(): number {
    return this.usages.reduce((sum, u) => sum + u.costUSD, 0);
  }

  /** 获取总缓存节省 */
  getTotalCacheSavings(): number {
    return this.usages.reduce((sum, u) => sum + u.cacheSavingsUSD, 0);
  }

  /** 获取所有用量记录 */
  getUsages(): readonly TokenUsageRecord[] {
    return this.usages;
  }

  /** 获取调用次数 */
  getCallCount(): number {
    return this.usages.length;
  }

  /**
   * 纯计算缓存节省金额，不记录数据
   * 供 loop.ts 在 fireAfterModelEvent 前调用（Step 5 清理时使用）
   */
  calculateCacheSavings(model: string, usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  }): number {
    const noCacheUsage: Usage = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    };
    const fullCost = this.calculateCost(model, noCacheUsage);
    const actualCost = this.calculateCost(model, usage as Usage);
    return Math.max(0, fullCost - actualCost);
  }
}
