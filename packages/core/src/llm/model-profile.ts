/**
 * 模型画像：把一条 availableModels 条目所需的**展示级**事实聚合成一个对象。
 *
 * 存在的理由是消灭一类重复：`/model pricing`、`/model list`、`/model` 弹窗、状态栏
 * 都要回答同一组问题（这个模型多大窗口 / 多少钱 / 支持哪些档位 / 这些数字是哪来的），
 * 而这些问题的答案分散在四个模块里（token-estimator 的窗口链、cost-tracker 的五级价格链、
 * gateway-pricing 的按次价、effort.ts 的档位集合）。谁要展示就自己拼一遍的结果是
 * **同一个模型在两个界面显示不同的数**——本仓已经出现过一次（`/model pricing` 记得过
 * `effectivePricing`，`DialogSwitch` 传给 StatsDialog 的那份没过，人民币被当美元显示）。
 *
 * 三条职责边界，越过就是把这里变成第二个数据源：
 *
 * 1. **本模块不查任何新数据源**，只调既有的解析入口（`resolveContextLimit` /
 *    `resolvePricing` / `resolveEffortCapability` / `getAllGatewayEntries`）。
 *    新数据源要加，加到它该在的那一层，本模块跟着拿。
 * 2. **本模块只服务展示，不参与计价**。计价走 `calculateUSDCost`（它需要传历史时刻 `at`
 *    才能复算旧会话），把计价改成读这里会把「可复现的历史成本」变成「按当前时刻算的数」。
 * 3. **未知就是 undefined/null，绝不编数字**。窗口那一档唯一的例外是兜底常量，
 *    但它带着 `source: "fallback"` 一起返回，展示层必须据此标注不确定性 ——
 *    见 {@link ModelMetaSource}。
 *
 * 价格单位一律 **USD / 每百万 token**（已过 `effectivePricing`：分时段折扣与币种换算都已折平），
 * 所以拿到的数字可以直接跨模型比较、直接印给用户。
 */

import {
  resolvePricing,
  effectivePricing,
  priceTierAt,
  type ModelPricing,
  type PricingModelEntry,
} from "../api/cost-tracker.ts";
import { lookupGatewayPricing, getAllGatewayEntries } from "./gateway-pricing.ts";
import { lookupRegistry } from "./model-registry.ts";
import { sameEndpoint } from "./endpoint-key.ts";
import { TokenEstimator, type ModelMetaSource } from "./token-estimator.ts";
import {
  resolveEffortCapability,
  getSelectableEfforts,
  isEffortGatedByThinking,
  type EffortLevel,
} from "./effort.ts";
import { resolveWireModel } from "./wire-model.ts";

/**
 * 价格来自哪一层。与 `resolvePricing` 的五级优先级链一一对应（前四级 + 未命中）。
 *
 * 与 {@link ModelMetaSource} 刻意分成两个类型：价格链与能力链的档位**不一样**
 * （价格有「网关采集」这一档、没有「模糊借用」这一档；能力反之），
 * 合成一个联合类型只会让两边都出现对方不可能取到的值。
 */
export type PricingSource =
  /** 用户在 settings.json 里手写的 pricing（含「模型名+端点」复合键与仅模型名两种命中） */
  | "user"
  /** 从网关 `/api/pricing` 实采的渠道价（按端点分桶） */
  | "gateway"
  /** 内置注册表（官方公开价，人工核对，带 asOf） */
  | "registry"
  /** 四级全 miss —— 计价会走 FALLBACK_PRICING，展示时必须说明这是估的 */
  | "unknown";

/** 一个可展示的数值 + 它的来源档位。 */
export interface SourcedValue<S> {
  value: number;
  source: S;
}

/** 模型画像：一条 availableModels 条目的全部展示级事实。 */
export interface ModelProfile {
  /** 本地别名（availableModels[].name），也是 `/model <name>` 的键 */
  name: string;
  /** 厂商真名（modelId，缺省 = name）。与 name 不同时值得展示——用户才知道实际发的是什么 */
  wireModel: string;
  /** 上下文窗口（tokens）。永远有值，但 source 可能是 fuzzy/fallback（即猜的） */
  contextWindow: SourcedValue<ModelMetaSource>;
  /** 单次响应输出上限（tokens）。**可能为 null**（全 miss 时不编数字） */
  maxOutputTokens: SourcedValue<ModelMetaSource> | null;
  /**
   * 每百万 token 单价（USD，已折平分时段与币种）。null = 四级全 miss。
   *
   * 按次计费模型（网关 quota_type=1）这里也是 null —— token 价对它不适用，
   * 单价看 {@link perCallUSD }。两者互斥，展示层择一。
   */
  pricing: ModelPricing | null;
  pricingSource: PricingSource;
  /** 按次计费单价（USD/次）。仅网关 quota_type=1 的模型有值（如视频类） */
  perCallUSD?: number;
  /**
   * 这条价原本存的币种（`"CNY"` 表示注册表里存的是人民币，已按 fxToUSD 折算成上面的 USD）。
   * 展示它是为了让「这个数是折算来的」可见——汇率是快照不是实时值。
   */
  originalCurrency?: "USD" | "CNY";
  /** 这条价最后一次人工核对的日期（YYYY-MM-DD），仅注册表价有 */
  pricingAsOf?: string;
  /** 当前时刻是否落在高峰时段（仅分时段模型有意义，其余为 undefined） */
  isPeakNow?: boolean;
  /** 该模型可选的 effort 档位。空数组 = 不支持档位切换 */
  efforts: EffortLevel[];
  /** effort 是否被 thinking 门控（GLM/DeepSeek：/think off 后档位不下发） */
  effortGatedByThinking: boolean;
  /** 是否支持思考开关 */
  supportsThinkingToggle: boolean;
}

/** 从 availableModels 条目里取本模块需要的字段（比 ModelConfig 窄，便于测试与跨层传递）。 */
export interface ProfileModelEntry extends PricingModelEntry {
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsThinking?: boolean;
}

/**
 * 判定价格来自哪一层 —— 判据与 `resolvePricing` 的优先级链**逐级对齐**。
 *
 * ⚠ 这是一份必然要跟着 `resolvePricing` 改的复制品，改那边必须改这边。为什么不能让
 * `resolvePricing` 自己返回来源：它在计价热路径上被反复调用（每轮 usage 都要算钱），
 * 而来源只有展示时才要；更重要的是它已经有 6 个调用点，改签名的波及面远大于收益。
 * 防漂移靠 `tests/llm/model-profile.test.ts` 里逐级构造命中的那组断言。
 *
 * 原实现在 `packages/cli/src/command/commands/model/model.ts` 的 `detectPricingSource`，
 * 已改为委托到这里（那份是本函数的来源，两份并存必然分叉）。
 */
export function detectPricingSource(
  name: string,
  availableModels: ProfileModelEntry[] | undefined,
  baseURL?: string,
): PricingSource {
  // 1. 用户手写「模型名 + 端点」复合键
  const exact = availableModels?.find((m) => m.name === name && sameEndpoint(m.baseURL, baseURL));
  if (exact?.pricing && exact.pricing.input > 0) return "user";
  // 2. 用户手写「仅模型名」
  const byName = availableModels?.find((m) => m.name === name);
  if (byName?.pricing && byName.pricing.input > 0) return "user";
  // 3. 网关实采价（按端点分桶）
  if (lookupGatewayPricing(name, baseURL)) return "gateway";
  // 3b. 按次计费（quota_type=1）：`lookupGatewayPricing` 对它**刻意返回 null**
  //     （按次价无法表达成 per-token，见该函数注释），于是光看第 3 步会一路落到注册表。
  //     但按次单价本身确实是**网关实采的** —— 不补这一档，展示出来就是
  //     「$18.00/次（注册表）」：数字来自网关、标签却说注册表，自相矛盾。
  //     实测 gpt-5.4 / claude-opus-4-8 等 4 个企业网关模型命中此分支。
  if (getPerCallUSD(name, baseURL) !== undefined) return "gateway";
  // 4. 内置注册表（含模糊兜底；按真名查，与 resolvePricing 第 4 步同源）
  if (lookupRegistry(resolveWireModel(name, availableModels))?.pricing) return "registry";
  return "unknown";
}

/**
 * 查网关采集缓存里的按次单价（quota_type=1）。
 *
 * 端点桶优先、未命中回退合并视图：用户配置的端点串与采集时归一化后的键可能不完全一致
 * （多一个 `/v1`、大小写不同），只查精确桶会让明明采到的价显示成「未知」。
 */
export function getPerCallUSD(name: string, baseURL?: string): number | undefined {
  const entry = getAllGatewayEntries(baseURL)[name] ?? getAllGatewayEntries()[name];
  if (entry && entry.quotaType === 1 && typeof entry.perCallUSD === "number") {
    return entry.perCallUSD;
  }
  return undefined;
}

/** 复用一个 estimator 实例：它无状态，每次 new 只是白付对象分配。 */
const estimator = new TokenEstimator();

/**
 * 聚合一条模型的展示级画像。
 *
 * @param entry            这条模型的配置（name / baseURL / provider / 用户声明的窗口价格等）
 * @param availableModels  完整的 availableModels（解析链的多处都要按名在全表里找）
 * @param fallbackProvider 条目没写 provider 时的兜底（顶层 config.provider）
 * @param at               计价时刻，仅用于分时段折算。缺省 = 现在。传它是为了让测试可复现
 */
export function buildModelProfile(
  entry: ProfileModelEntry,
  availableModels: ProfileModelEntry[],
  fallbackProvider = "",
  at?: Date,
): ModelProfile {
  const name = entry.name;
  const baseURL = entry.baseURL;
  const wireModel = resolveWireModel(name, availableModels);

  const contextWindow = estimator.resolveContextLimit(name, availableModels);
  const maxOutputTokens = estimator.resolveMaxOutputTokens(name, availableModels);

  // 价格：先拿原样存储值（可能是人民币 / 高峰价），再一次性折平成可比 USD。
  // 不能跳过 effectivePricing —— 那正是「in $9/M 把人民币当美元印给用户」的成因。
  const rawPricing = resolvePricing(name, availableModels, baseURL);
  const pricing = rawPricing ? effectivePricing(rawPricing, at) : null;
  const pricingSource = detectPricingSource(name, availableModels, baseURL);
  const perCallUSD = getPerCallUSD(name, baseURL);

  // effort 能力按**真名**解析协议族、按**别名**查 compat 声明 —— 与 app.ts 的
  // resolveEffortCap 同口径。两边口径不一致会出现「面板说支持、请求里没发」的分裂。
  const capability = resolveEffortCapability({
    model: wireModel,
    provider: entry.provider || fallbackProvider,
    baseURL,
    modelConfig:
      entry.supportsThinking === undefined
        ? undefined
        : { supportsThinking: entry.supportsThinking },
    alias: name,
  });

  return {
    name,
    wireModel,
    contextWindow,
    maxOutputTokens,
    pricing,
    pricingSource,
    perCallUSD,
    // 折算前的币种/核对日期取自**原样值**：折算后的对象里这些字段已被 effectivePricing
    // 刻意清掉（防二次折算），所以必须从 rawPricing 读。
    originalCurrency: rawPricing?.currency,
    pricingAsOf: rawPricing?.asOf,
    // 分时段判定走 priceTierAt（时段判定的唯一实现），不在这里自己算 UTC 小时。
    isPeakNow:
      rawPricing?.peakWindows && rawPricing.peakWindows.length > 0
        ? priceTierAt(rawPricing, at ?? new Date()) === "peak"
        : undefined,
    efforts: capability.supportsEffort ? getSelectableEfforts(capability) : [],
    effortGatedByThinking: isEffortGatedByThinking(capability),
    supportsThinkingToggle: capability.supportsThinkingToggle,
  };
}
