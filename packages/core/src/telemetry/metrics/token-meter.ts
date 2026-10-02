/**
 * Token 计量器——记录每次 LLM 调用的 token 用量并发送 OTel metric
 * 复用 SessionState 的定价逻辑，不重复维护定价表
 */

import type { TelemetryBus } from "../bus.ts";
import type { Attributes } from "../types.ts";
import { normalizeCacheUsage, type Usage } from "../../llm/types.ts";

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

    // 发送 OTel metric —— OTel GenAI「Inference Token Metrics」：按方向拆成独立 Counter。
    //
    // 曾经是单个 `gen_ai.client.token.usage` + `gen_ai.token.type` 维度，规范已删除这对组合
    // （semantic-conventions-genai changelog.d/374.breaking.md）：把 input 和 output 放进同一个
    // instrument 再按维度拆，跨维度求和得出的「总 token」没有意义，后端却会默认这么做。
    if (this.bus?.isEnabled()) {
      const attrs: Attributes = {
        "gen_ai.request.model": model,
        "gen_ai.provider.name": provider,
      };
      if (sessionId) attrs["gen_ai.conversation.id"] = sessionId;
      // operation.name / token.modality 是这组 metric 的 Required 属性。
      // 各家 provider 都不按模态拆用量，按规范落 `unknown`，不猜 `text`。
      const tokenAttrs: Attributes = {
        ...attrs,
        "gen_ai.operation.name": "chat",
        "gen_ai.token.modality": "unknown",
      };
      // 规范：input_tokens SHOULD 含缓存命中与写入。Anthropic 的 input_tokens 是未命中余量、
      // OpenAI 族的 prompt_tokens 已含命中 —— 两族口径不同，统一走 normalizeCacheUsage 取 promptTotal。
      const norm = normalizeCacheUsage(usage, provider);
      const now = Date.now();
      const counters: Array<[string, number]> = [
        ["gen_ai.client.inference.usage.input_tokens", norm.promptTotal],
        ["gen_ai.client.inference.usage.output_tokens", usage.outputTokens],
        ["gen_ai.client.inference.usage.cache_read.input_tokens", norm.cacheHitTokens],
        ["gen_ai.client.inference.usage.cache_write.input_tokens", norm.cacheWriteTokens],
        ["gen_ai.client.inference.usage.reasoning.output_tokens", usage.reasoningTokens ?? 0],
      ];
      for (const [name, value] of counters) {
        // 0 值只对 input / output 落：缓存与推理是「本次没有这个维度」，落 0 会把
        // 「非思考模型」与「网关未透传」混成一个数
        if (
          value <= 0 &&
          !name.endsWith("usage.input_tokens") &&
          !name.endsWith("usage.output_tokens")
        ) {
          continue;
        }
        this.bus.recordMetric({
          name,
          value,
          unit: "{token}",
          timestamp: now,
          attributes: tokenAttrs,
          type: "counter",
        });
      }
      this.bus.recordMetric({
        name: "sidcode.cost.usd",
        value: costUSD,
        unit: "USD",
        timestamp: Date.now(),
        attributes: attrs,
        type: "counter",
      });
      if (cacheSavingsUSD > 0) {
        this.bus.recordMetric({
          name: "sidcode.cost.cache_savings_usd",
          value: cacheSavingsUSD,
          unit: "USD",
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
  calculateCacheSavings(
    model: string,
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
    },
  ): number {
    const noCacheUsage: Usage = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    };
    const fullCost = this.calculateCost(model, noCacheUsage);
    const actualCost = this.calculateCost(model, usage as Usage);
    return Math.max(0, fullCost - actualCost);
  }
}
