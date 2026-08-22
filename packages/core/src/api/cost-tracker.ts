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
import { lookupRegistryExact, lookupRegistryFuzzy } from "../llm/model-registry.ts";
import { sameEndpoint } from "../llm/endpoint-key.ts";
import { lookupGatewayPricing } from "../llm/gateway-pricing.ts";

/**
 * 模型定价（每百万 token，USD）。
 *
 * ## 三个补齐的维度（D1 / 方案 §4.2）
 *
 * 改造前这里是四个裸数字，于是三件事**在这张表里根本无法表达**：
 *
 * 1. **币种**（`currency` + `fxToUSD`）—— DeepSeek 官方定价单位是**人民币**，我们存 USD。
 *    中间那个汇率既没记下来也没有 as-of 日期，于是「汇率漂移」与「厂商涨价」
 *    在这张表里长得一模一样，**无法归因**。
 * 2. **时段**（`peakWindows` + `offPeakMultiplier`）—— 分时段政策（实测 DeepSeek 空闲价
 *    = 高峰价的一半）表达不出来，同一个会话按发起时刻可能差 2 倍。
 * 3. **as-of / source**（`asOf` + `source`）—— 没有任何字段能回答"这条价什么时候核过、
 *    从哪抄的"，于是**过期不可检测**。实测这张表的 DeepSeek 价停在 2026-08-11，
 *    厂商 08-16 涨价后一直没人发现，直到用户拿账单来对（差 4.56 倍）。
 *
 * 三个维度**全部可选**：不填时行为与改造前逐字节一致（USD、无时段、不可检测过期）。
 * 这是刻意的 —— 表里 100+ 条模型定价不可能一次全补齐 as-of，
 * 强制必填只会换来一批编造的日期，那比没有这个字段更糟。
 */
export interface ModelPricing {
  /** 未命中输入价（高峰价；有 `peakWindows` 时空闲价由 `offPeakMultiplier` 派生） */
  input: number;
  output: number;
  /** 缓存读取价（通常为 input 的 0.1），不填调用方按 input×0.1 近似 */
  cacheRead?: number;
  /** 缓存写入价（通常为 input 的 1.25），不填调用方按 input×1.25 近似 */
  cacheWrite?: number;

  /**
   * 上面四个数字的**计价币种**。缺省 `"USD"`（与改造前的隐含假设一致）。
   *
   * 存非 USD 时必须同时给 `fxToUSD` —— 否则计价拿不到换算率，只能当 USD 用，
   * 那正是这个字段要消灭的静默错算。
   */
  currency?: "USD" | "CNY";
  /**
   * `currency` → USD 的换算率（1 单位本币 = 多少 USD）。
   *
   * **必须与 `asOf` 成对出现才有意义**：汇率是会漂的，一个没有日期的汇率
   * 无法回答"这个价是旧汇率还是旧单价造成的"。
   */
  fxToUSD?: number;

  /**
   * 高峰时段窗口（UTC 小时区间，半开：`[startHour, endHour)`）。
   *
   * 为什么用 UTC 而不是北京时间：厂商公告用的是 UTC（实测 DeepSeek 的公告口径是
   * `01:00-04:00` 与 `06:00-10:00` UTC），转成本地时区存会在夏令时/时区变更时漂。
   * 存 UTC + 计价时按 UTC 取小时，全球任何机器算出同一个价。
   *
   * 不填 = 无分时段政策，`input`/`output`/`cacheRead` 就是唯一价（旧行为）。
   */
  peakWindows?: ReadonlyArray<{ readonly startHour: number; readonly endHour: number }>;
  /**
   * 空闲时段价 = 高峰价 × 本系数。仅在 `peakWindows` 非空时生效。
   *
   * 实测 DeepSeek 是 0.5（空闲价恰为高峰价的一半）。缺省 1（无折扣）——
   * 缺省值刻意取"不打折"而不是 0.5：猜低会系统性低估成本，
   * 而低估成本正是本次事故的形态，宁可高估触发预算守卫。
   */
  offPeakMultiplier?: number;

  /**
   * 这条价**最后一次人工核对**的日期（`YYYY-MM-DD`）。
   *
   * 用途不是展示，是**过期可检测**：有了它，"这张表多久没核过"才是一个可以
   * 立断言、可以进 CI 的数，而不是一句"应该还行吧"。
   *
   * 两处消费它：`bun scripts/pricing-reconcile.ts --check-asof`（只提示不硬拦，
   * 理由见该函数注释）与 `tests/llm/pricing-dimensions.test.ts` 的
   * 「asOf 陈旧可检测」一组（断言日期合法、不在未来、且必有 source）。
   */
  asOf?: string;
  /** 这条价抄自哪里（官方定价页 URL / 网关采集 / 用户配置）。归因用。 */
  source?: string;
}

/**
 * 计价时段。`"none"` = 该模型无分时段政策（绝大多数模型）。
 *
 * 存在 `"none"` 这一档而不是用 `undefined`：读侧要能区分
 * 「这条价没有分时段政策」与「这行是加字段之前写的存量数据」。
 */
export type PriceTier = "peak" | "offpeak" | "none";

/**
 * 判某时刻落在高峰还是空闲 —— 时段判定的**唯一实现**。
 *
 * 独立导出的理由（方案 §5.5）：分时段一旦生效，**成本就不再可复现** ——
 * `trace/cost-recompute.ts` 从 events 重算时用的是"重算时刻"的时段，
 * 而不是"请求发出时刻"的。所以发生侧必须把当时的时段**落成字段**，
 * 而落盘用的判据必须与计价用的判据是同一份代码。
 *
 * 顺带让「高峰占比」直接可查，从而能回答一个真实的省钱问题：
 * **把长任务挪到空闲时段能省多少。**
 */
export function priceTierAt(p: ModelPricing, at: Date = new Date()): PriceTier {
  if (!p.peakWindows || p.peakWindows.length === 0) return "none";
  const hour = at.getUTCHours();
  const isPeak = p.peakWindows.some((w) =>
    // 支持跨零点窗口（startHour > endHour，如 22-02）——不支持的话
    // 下一个补时段的人会踩到，而症状是静默算错价。
    w.startHour <= w.endHour
      ? hour >= w.startHour && hour < w.endHour
      : hour >= w.startHour || hour < w.endHour,
  );
  return isPeak ? "peak" : "offpeak";
}

/**
 * 按时刻求**生效价** —— 分时段政策的唯一解析入口。
 *
 * 两步：① 按 `peakWindows` 判当前是高峰还是空闲，空闲则整体乘 `offPeakMultiplier`；
 * ② 按 `currency`/`fxToUSD` 换算成 USD。
 *
 * 顺序不能反（先折扣后换汇 vs 先换汇后折扣结果相同，因为两者都是乘法），
 * 但**两步都必须做**：只做①会把人民币当美元算（低估 7 倍），
 * 只做②会在空闲时段收高峰价（高估 2 倍）。
 *
 * @param at 计价时刻。缺省 `new Date()`。
 *   显式可传是为了让**测试与重算**能复现历史时刻的价 —— `cost-recompute.ts`
 *   重算历史会话时必须用**那次请求发生的时刻**，用"现在"会算出另一个价。
 */
export function effectivePricing(p: ModelPricing, at: Date = new Date()): ModelPricing {
  let factor = 1;

  // ① 时段折扣。判据取自 `priceTierAt` —— **不在这里重写一遍**：
  //    落盘的 `price_tier` 与实际计价用的时段必须由同一个函数决定，
  //    两份实现会漂移成"账本说 offpeak、成本却按 peak 算"，那比不落这个字段更糟。
  if (p.peakWindows && p.peakWindows.length > 0) {
    if (priceTierAt(p, at) === "offpeak") factor *= p.offPeakMultiplier ?? 1;
  }

  // ② 币种换算。缺 fxToUSD 时**不猜汇率**：保持原数并留给上层告警，
  //    猜一个汇率等于用一个编造的数覆盖掉"我不知道"这个事实。
  if (p.currency && p.currency !== "USD" && typeof p.fxToUSD === "number" && p.fxToUSD > 0) {
    factor *= p.fxToUSD;
  }

  if (factor === 1) return p;
  return {
    ...p,
    input: p.input * factor,
    output: p.output * factor,
    ...(p.cacheRead !== undefined ? { cacheRead: p.cacheRead * factor } : {}),
    ...(p.cacheWrite !== undefined ? { cacheWrite: p.cacheWrite * factor } : {}),
    // 已折算完毕，清掉这两个维度防止**二次折算**（下游若再调一次 effectivePricing
    // 就会把折扣/汇率乘两遍 —— 这类重复应用是计价代码最常见的静默错算）。
    currency: "USD",
    fxToUSD: undefined,
    peakWindows: undefined,
  };
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
 * `resolvePricing` + `effectivePricing` 的组合便捷式 —— **需要可比 USD 数字时用这个**。
 *
 * 存在的理由是让"安全的写法"成为"顺手的写法"：`resolvePricing` 返回的是**原样**存储值，
 * 可能是人民币、可能是高峰价。任何要拿它做**跨模型比较**或**展示给用户**的地方
 * 都必须先折算，而"记得再调一次 effectivePricing"正是本仓反复吃亏的形态
 * （见 llm/billing-sink.ts 文件头那条判据）。
 *
 * 计价路径**不**用它（`calculateUSDCost` / `SessionState.calculateCost` 内部自己折算，
 * 因为它们需要传入历史时刻 `at`）。
 */
export function resolvePricingUSD(
  model: string,
  availableModels?: PricingModelEntry[],
  baseURL?: string,
  at?: Date,
): ModelPricing | null {
  const raw = resolvePricing(model, availableModels, baseURL);
  return raw ? effectivePricing(raw, at) : null;
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
  // ⚠ 这一步**刻意只拆 exact/fuzzy，不在中间插采集缓存的价格层** —— 与
  // token-estimator / config.ts 那两条链路的关键区别，别照着它们"补齐"：
  //   - **能力**（窗口 / 输出上限）是模型固有属性，跨端点复用安全 → 采集缓存按模型名单键；
  //   - **价格**随渠道变，同名不同价 → 必须按「模型名 + 端点」，这是步骤 3 网关采集价的职责。
  // 实测：models.dev 镜像里 glm-5.3 有 4 条不同的价（1.4 / 1.4 / 0 / 0，后两个是订阅制），
  // 而我们网关实采价是 1.0959 —— 网关价才是对的，把 catalog 价接进来只会引入错算。
  // catalog 的 cost 字段可以采集入库供 /model list 展示，但优先级必须低于注册表兜底。
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
  const wire = resolveWireModel(model, availableModels);
  return (lookupRegistryExact(wire) ?? lookupRegistryFuzzy(wire))?.pricing ?? null;
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
  /**
   * D1：计价时刻 —— 分时段定价的输入。缺省"现在"。
   *
   * 显式可传是为了让 `cost-recompute.ts` 重算历史会话时能用**那次请求发生的时刻**
   * 取价。用"现在"重算一个跑在空闲时段的历史会话，会得到高峰价（差 2 倍），
   * 而那个错数看起来完全正常 —— 没有任何东西会报红。
   */
  at?: Date,
): number {
  // D1：先按时刻求生效价（时段折扣 + 币种换算），再计价。
  // 不做这一步的后果是双向的：人民币价当美元算（低估 7 倍）、空闲时段收高峰价（高估 2 倍）。
  const p = effectivePricing(
    resolvePricing(model, availableModels, baseURL) ?? FALLBACK_PRICING,
    at,
  );
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
