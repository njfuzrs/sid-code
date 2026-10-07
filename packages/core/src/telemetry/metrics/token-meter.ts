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
  /**
   * 本次调用实际成本。**缺省（undefined）时由 TokenMeter 按 model 定价计算** ——
   * 子代理载荷没有 cost 字段，曾传 0 进来，成本 metric 恒 0 而 savings 等于全价（缺陷 32）。
   * 不要再传 0 表示「不知道」：0 会被当成真实成本。
   */
  costUSD?: number;
  sessionId?: string;
}

/**
 * 成本计算函数签名（复用 SessionState.calculateCost）。
 * provider 必须透传：两族 usage 口径不同，按 model 名推断在网关别名下会猜错。
 */
export type CostCalculator = (model: string, usage: Usage, provider?: string) => number;

export class TokenMeter {
  private usages: TokenUsageRecord[] = [];

  constructor(
    private bus: TelemetryBus | null,
    private calculateCost: CostCalculator,
  ) {}

  /** 记录一次 LLM 调用的 token 用量，返回 { costUSD, cacheSavingsUSD } */
  record(params: TokenRecordParams): { costUSD: number; cacheSavingsUSD: number } {
    const { model, provider, usage, sessionId } = params;
    const costUSD = params.costUSD ?? this.calculateCost(model, usage, provider);
    const cacheSavingsUSD = this.savingsFor(model, usage, provider, costUSD);

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
    provider?: string,
  ): number {
    const actualCost = this.calculateCost(model, usage as Usage, provider);
    return this.savingsFor(model, usage as Usage, provider, actualCost);
  }

  /**
   * 缓存节省 = 全价假设 − 实际成本。全价假设 = **promptTotal** 全按未命中输入计价。
   *
   * 缺陷 12（P0，20260927 可观测性审计）：曾用「去掉缓存字段的同一份 usage」当全价假设。
   * Anthropic 族的 inputTokens 本就是未命中余量（不含 hit/write），去掉缓存字段并不构造
   * 「全价」，只构造「少发了 H+W 个 token」⇒ 差值必负、被 max(0,…) 钳成 0 ——
   * 唯一真正靠显式缓存省钱的那一族，省钱 metric 恒为 0。口径与 SessionState.calculateSavings 一致。
   * provider 缺省时按 model 名推断（claude* → anthropic），与 SessionState.inferProvider 的兜底同规则。
   */
  private savingsFor(
    model: string,
    usage: Usage,
    provider: string | undefined,
    actualCost: number,
  ): number {
    const prov = provider ?? (/claude/i.test(model) ? "anthropic" : "openai");
    const norm = normalizeCacheUsage(usage, prov);
    const fullCost = this.calculateCost(
      model,
      { inputTokens: norm.promptTotal, outputTokens: norm.outputTokens },
      prov,
    );
    return Math.max(0, fullCost - actualCost);
  }
}
