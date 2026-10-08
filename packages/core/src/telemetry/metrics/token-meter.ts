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
  /**
   * 本次调用的缓存节省。**调用方已有权威值时必须传**（主循环传 SessionState.calculateSavings
   * 的结果，与 span 属性、/cost 同一个数）。缺省时才由 TokenMeter 自算（子代理路径没有这个值）。
   *
   * 曾经恒由 TokenMeter 自算：实际成本取调用方传入的 costUSD（带 baseURL 端点价），
   * 全价假设却按不带 baseURL 的定价算 —— 减法两边口径不同，同一次调用 metric 与 span
   * 给出两个数（2026-10-08 实测 0.0858 vs 0.0661）。
   */
  cacheSavingsUSD?: number;
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
    const cacheSavingsUSD =
      params.cacheSavingsUSD ?? this.savingsFor(model, usage, provider, costUSD);

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
      //
      // 缺陷 33（口径澄清，不改值）：这些点按 OTLP `DELTA + monotonic` 上报（exporters/otlp.ts）。
      // input 点的单点值是「本次请求的完整输入」（含历史，对单次请求是 stock），
      // 所以后端按 DELTA 求和得到的是**累计计费 prompt**（flow）——与 traj 的
      // `total_cumulative_prompt_tokens` 同口径、与累计 cost 可比，**不是**「上下文多大」。
      // 想看上下文占用请用 `context_usage_peak_*`，别拿这个 sum 当它（那才是 N² 误读）。
      // 不改成 uncachedInputTokens：那会违反上面的规范要求，并让两族 input 口径重新分叉（#136 修过）。
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

  // 曾有 `calculateCacheSavings()` 供 loop.ts 预算 span 属性，2026-10-08 删除：它不带 baseURL，
  // 与 SessionState.calculateSavings（/cost 用的）是两套口径，主循环现直接用后者并透传给 record()。
  // 留着它就是第二个事实源 —— 下一个人会顺手再用它。

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
