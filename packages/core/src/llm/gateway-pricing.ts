/**
 * 网关定价自动采集 — 从 new-api 类网关（企业自建的 LLM 中转站常用这类实现）的
 * `/api/pricing` 接口采集**价格**，与官方注册表（model-registry.ts）的**能力字段**互补。
 *
 * 职责边界（严格）—— 2026-08-21 显式修订，见下方「边界为什么从『只采价格』改口」：
 * - **采端点自报的一切事实**：价格 + 该端点支持的协议类型（`supported_endpoint_types`）。
 * - **不采模型固有能力**：contextWindow / maxOutputTokens / supportsThinking
 *   永远以官方注册表 + `model-capabilities.ts` 的采集为准，本模块绝不触碰。
 * - 采集结果按「模型名」做键（网关渠道名天然带前缀 ali-/tx-/origin- 区分渠道，
 *   同名不同渠道价格不同——这正是计费复合键要解决的问题）。
 * - 在 resolvePricing（cost-tracker.ts）中的优先级：用户手写 > **网关采集** > 内置注册表 > FALLBACK。
 *   命中网关精确渠道价后根本走不到注册表的前缀剥离，从而修正「ali-deepseek-v4-pro 被剥成
 *   deepseek-v4-pro 套官方价、低估 3.7 倍」的错算。
 *
 * 多端点分桶（修复多端点互相覆盖 bug）：
 * - 缓存文件按**归一化端点**（normalizeBaseURL）分桶：`{ endpoints: { [endpointKey]: {...} } }`。
 *   此前是单端点扁平结构，`/model discover --pricing` 遍历多个 baseURL 逐个写**同一份**缓存，
 *   后一个端点直接覆盖前一个，多渠道场景只保留最后一个端点的价格。
 * - lookupGatewayPricing 端点感知：先查请求端点对应的桶（精确渠道价），未命中再跨桶按模型名兜底
 *   （兼容「没传 baseURL」「端点桶里没这个冷门模型」的旧行为）。
 *
 * 计价公式（已用 claude-opus-4-8 / gpt-5.4 / claude-sonnet-5 三个官方价模型核对无误）：
 *   input  $/1M = model_ratio × 2          （×2 是 new-api 基准单位）
 *   output $/1M = input × completion_ratio
 *   cacheRead   = input × cache_ratio
 *   cacheWrite  = input × create_cache_ratio
 *   quota_type=0 → 按上面 token 公式。
 *   quota_type=1 → 网关**自己**按次计费（model_price USD/次）。⚠ 但这**不代表它没有 token 价**：
 *                  实测企业网关（code.ppchat.vip）14 条 quota_type=1 全部同时带 model_ratio +
 *                  completion_ratio，按上面公式换算出来正是官方价（claude-opus-5 → $5/$25、
 *                  claude-sonnet-4-6 → $3/$15）。所以两者都存下来：**token 价进计费**
 *                  （我们的账本本来就按 token 算），**按次价仅供展示**。
 *                  只有真正没有 token 价的条目（model_ratio 缺失/为 0，如 doubao-seedream 图片类）
 *                  才是纯按次模型，此时 input=0 → 计价退回注册表兜底。
 *
 * 容错：第三方 HTTP 属**不可信数据**——严格数值校验（有限、非负），非法条目丢弃；网络/解析失败
 * 静默保留旧缓存 + 回退注册表，绝不阻塞启动或计费。
 *
 * ── 边界为什么从「只采价格」改口（2026-08-21）────────────────────────────
 *
 * 旧边界写的是「只采价格，protocolKind 等能力字段永远以官方注册表为准，本模块绝不触碰」。
 * 按那句话采 `supported_endpoint_types` 是违规的，所以这里显式改口而不是偷偷加字段。
 *
 * 新切分的判据是**「谁自报的」而不是「叫什么名字」**：
 * - 端点自报的事实（价格、该端点支持的协议类型）→ 归本模块，天然按端点分桶；
 * - 模型固有属性（窗口、输出上限）→ 归 model-registry / model-capabilities，按模型名单键。
 *
 * 这个切分比「只采价格」更准确：`supported_endpoint_types` 确实属于 protocolKind 范畴，
 * 但它是**这个端点上**的事实（同一模型在另一个网关上支持的协议可能不同），
 * 没有任何官方注册表能回答它 —— 硬把它排除在外，等于让一个只有端点知道的事实无处安放。
 *
 * ⚠ **否定性结论（写在这里避免下一个人重复探索）**：这个网关（new-api 类实现）的
 * `/v1/models` 与 `/api/pricing` **两个接口都不提供 contextWindow**。实测
 * `/v1/models` 76 条，全部条目的键并集只有 `created / id / object / owned_by /
 * supported_endpoint_types`，context/token/limit/window/length/max 一类字段**一个都没有**；
 * `/api/pricing` 的字段并集里同样没有。
 *
 * 所以「问端点自己拿窗口」这条路在当前企业网关上**走不通**，本模块不能当作
 * 「新模型窗口低估」的替代方案 —— 那件事只能靠外部目录（models.dev / litellm / OpenRouter）。
 * 这是个否定性结论，但它把「为什么必须依赖外部目录」从设计选择变成了客观约束。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { sidPaths } from "../config/paths.ts";
import { normalizeBaseURL } from "./endpoint-key.ts";
import { resolveSideCallTimeouts } from "../config/network-profile.ts";
import type { ModelPricing } from "../api/cost-tracker.ts";
import { lookupRegistryExact } from "./model-registry.ts";
import { getLogger } from "../debug/logger.ts";

/**
 * ⚠ 必须**每次调用时**取 logger，不能写成模块级 `const log = getLogger()`。
 * 本模块处在 cli.ts → config.ts → cost-tracker.ts → 本模块 这条**静态导入链**上，
 * 求值时机早于 cli.ts 的 initLogger()。模块级捕获会把 enabled=false 的兜底实例
 * 永久冻进闭包，其 WARN 走 logger.log() 的 stderr 兜底分支直接泄漏到用户终端
 * （污染 TUI）且不写入 audit.log。见 logger.ts 的 initLogger/reconfigure 注释。
 */
const log = () => getLogger();

/** new-api /api/pricing 单条原始返回（仅声明我们消费的字段）。 */
interface RawPricingEntry {
  model_name?: string;
  quota_type?: number; // 0=按 token，1=按次
  model_ratio?: number;
  model_price?: number; // quota_type=1 时的按次单价（USD/次）；与 model_ratio 并存，不互斥
  completion_ratio?: number;
  cache_ratio?: number;
  create_cache_ratio?: number;
  /** 该端点上这个模型支持的协议类型，如 `["openai"]` / `["openai","openai-response"]`。
   *  类型故意宽成 unknown：第三方 HTTP 不可信，校验在 sanitizeEndpointTypes 里做。 */
  supported_endpoint_types?: unknown;
}

/** 换算后的网关定价条目（缓存与内存态）。 */
export interface GatewayPricingEntry extends ModelPricing {
  /**
   * 网关自报的计费口径：0=按 token；1=网关按次计费。
   *
   * ⚠ **它不是「哪个价有效」的判据** —— quotaType=1 的条目照样可能有完整 token 价
   * （实测 14/14 都有）。判「有没有 token 价」一律看 `input > 0`，判「有没有按次价」
   * 一律看 `perCallUSD !== undefined`。把 quotaType 当二选一的开关，就是
   * 「$60.00/次 而账本按 $2/$10 记」那个口径矛盾的成因。
   */
  quotaType: number;
  /** 按次单价（USD/次），仅 quotaType=1 有值。与 input/output **可以并存** */
  perCallUSD?: number;
  /**
   * 该端点自报的、这个模型支持的协议类型（原样保留网关词汇，不翻译成我们的 protocolKind）。
   *
   * 实测形态（2026-08-21，企业网关 68 条，7 种取值）：`["openai"]` ×44、
   * `["openai","openai-response"]` ×7、`["anthropic","openai"]` ×4、
   * `["gemini","openai"]` ×3，另有 `embeddings` / `image-generation` / `jina-rerank`。
   * 每条都有这个字段，且都是字符串数组。
   *
   * ⚠ **当前只采集、不消费**。协议族判定仍走 `classify.ts` 的正则 —— 把判定切到这个字段是
   * 另一件事（要处理「网关词汇 → protocolKind」的映射、缓存过期时的降级、以及与
   * `protocol-sentinel.ts` 的关系），不在本次范围内。先把已经拿到手却被丢掉的权威事实存下来，
   * 是为那件事准备依据，不是替它下结论。
   *
   * 为什么它属于本模块而不是 model-capabilities.ts：这是「**这个端点上**的事实」
   * （同一模型在另一个网关上可能支持的协议不同），天然按端点分桶，与价格同构；
   * 而窗口/输出上限是模型固有属性，按模型名单键。见头部职责边界。
   */
  supportedEndpointTypes?: string[];
}

/** 单个端点桶：该端点采集到的全部模型价 + 元信息。 */
interface EndpointBucket {
  source_url: string;
  fetched_at: number;
  /** 聚合哈希，用于版本比对（内容不变则不写盘） */
  pricing_version: string;
  models: Record<string, GatewayPricingEntry>;
  /**
   * 最近一次采集**失败**的时间戳（负缓存）。0/缺失 = 没有未恢复的失败。
   * 与 fetched_at 独立：失败不该冒充「采过了」去满足 TTL，也不该抹掉上次成功的价格。
   */
  failed_at?: number;
  /** 连续失败次数，驱动指数退避；成功一次即清零。 */
  fail_count?: number;
}

/**
 * 缓存文件结构（~/.sid-code/gateway-pricing.json）—— 按归一化端点分桶。
 * `endpoints[""]` 表示官方默认端点（无 baseURL）。
 */
interface GatewayCacheFile {
  /**
   * 缓存结构版本（区别于内容 pricing_version），便于将来迁移。
   *
   * v3（2026-09-08）：`convertRawEntry` 修好「按次条目丢掉 token 价」之前写下的缓存，
   * 其 `quotaType=1` 条目 `input` 一律是 0 —— 与新语义下「纯按次模型」**字节上无法区分**，
   * 无法就地修复，只能重采。见 parseCacheFile 里的过期标记处理。
   */
  schema_version: 3;
  endpoints: Record<string, EndpointBucket>;
}

/** 旧版单端点扁平结构（schema v1），用于读取时迁移。 */
interface LegacyCacheFileV1 {
  source_url?: string;
  fetched_at?: number;
  pricing_version?: string;
  models?: Record<string, GatewayPricingEntry>;
}

/** new-api 基准单位换算系数：model_ratio × 2 = input $/1M。 */
const RATIO_TO_USD_PER_M = 2;

/** 默认采集 TTL：24h。缓存超此时长则后台静默刷新。 */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 失败负缓存（failure backoff）—— 修复「端点长期不可达仍每次启动重试」。
 *
 * 此前只有**成功**才写 fetched_at，失败什么都不记；于是不可达端点每次启动都重来一次：
 * 团队默认配置有 3 个不同端点 → 每次启动 3 个并发请求各白烧一个 15s socket，且永不退避。
 * 定价采集是纯优化项（失败仅退回注册表估价），完全不值得这种开销。
 *
 * 策略：把失败也记进端点桶（failed_at + fail_count），按失败次数指数退避，封顶 24h。
 * 首次失败等 5min（网关重启/短时抖动这类瞬时故障能较快恢复），持续失败迅速拉长到天级。
 * 成功一次即清零（见 syncGatewayPricing 写盘处不带 failed_at/fail_count）。
 */
const FAILURE_BACKOFF_BASE_MS = 5 * 60 * 1000;
const FAILURE_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

/** 依据失败次数算下次允许重试的间隔（指数退避，封顶 24h）。 */
export function computeFailureBackoffMs(failCount: number): number {
  if (failCount <= 0) return 0;
  const exp = FAILURE_BACKOFF_BASE_MS * Math.pow(2, failCount - 1);
  return Math.min(exp, FAILURE_BACKOFF_MAX_MS);
}

/**
 * 内存态：归一化端点 key → 该端点的模型价映射。启动时由 loadGatewayCache 载入。
 * key="" 表示官方默认端点。
 */
let memBuckets: Record<string, Record<string, GatewayPricingEntry>> = {};
/**
 * 各端点桶的连续失败次数（与 memBuckets 同步载入）。
 *
 * 为什么内存里也要留一份：`lookupGatewayPricing` 是计费**热路径**，不能每次去读盘查
 * fail_count。而"这个桶的价格新鲜不新鲜"恰恰是**跨桶兜底**该不该借用它的判据——
 * 失败中的端点，其价格是上一次成功时的快照，借给**别的**端点用属于双重不确定。
 * 注意只约束跨桶兜底：桶自己被精确命中时仍照用（失败不该抹掉已采到的价格，
 * 见「失败不抹掉上次成功采到的价格」回归测试）。
 */
let memBucketFailCount: Record<string, number> = {};
let memLoaded = false;

/**
 * 采集可观测观察者（阶段 2.5）。由 app.ts 在 collector 就绪后注入，
 * 把采集成功/失败/命中版本/覆盖模型数记为一条 trace 事件。
 * 未注入（如无头/未启用 trace）时静默 no-op，绝不阻塞采集。
 */
export interface GatewayPricingObservation {
  endpoint: string;
  url: string;
  outcome: "updated" | "unchanged" | "failed";
  count: number;
  version: string;
  dropped: number;
  reason: string;
}
let observer: ((obs: GatewayPricingObservation) => void) | null = null;
export function setGatewayPricingObserver(
  fn: ((obs: GatewayPricingObservation) => void) | null,
): void {
  observer = fn;
}
function emit(obs: GatewayPricingObservation): void {
  try {
    observer?.(obs);
  } catch {
    /* 观察者异常不影响采集主流程 */
  }
}

/** 有限非负数校验（不可信数据网关）。 */
function isFiniteNonNeg(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

/**
 * 校验并归一化 `supported_endpoint_types`（不可信数据网关）。
 *
 * 只接受「非空字符串数组」，逐项 trim 后丢掉空串；拿不到合法值返回 undefined
 * （**不返回 `[]`**——空数组会被读成「这个模型不支持任何协议」，那是个比缺失更强的断言，
 * 而我们其实只是没采到）。不做去重排序之外的语义改写：原样保留网关词汇，
 * 翻译成 protocolKind 是消费侧的事，在这里翻译等于把一个未定的映射固化进缓存。
 *
 * 排序是为了让 computeVersion 的内容指纹稳定：网关返回顺序抖动不该被当成「价格变了」
 * 而触发一次无谓写盘。
 */
function sanitizeEndpointTypes(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (t) seen.add(t);
  }
  return seen.size > 0 ? [...seen].sort() : undefined;
}

/**
 * 把一条原始 pricing 换算成 GatewayPricingEntry。非法数据返回 null（调用方丢弃）。
 */
export function convertRawEntry(
  raw: RawPricingEntry,
): { name: string; entry: GatewayPricingEntry } | null {
  const name = raw.model_name;
  if (!name || typeof name !== "string") return null;

  const quotaType = raw.quota_type === 1 ? 1 : 0;
  // 与计价口径无关，两种 quotaType 都要带上（按次计费的模型同样有协议类型）。
  const endpointTypes = sanitizeEndpointTypes(raw.supported_endpoint_types);

  // ── 按次单价：仅 quota_type=1 有意义，缺失即这条非法（网关自称按次却不报单价）──
  let perCallUSD: number | undefined;
  if (quotaType === 1) {
    if (!isFiniteNonNeg(raw.model_price)) return null;
    perCallUSD = raw.model_price;
  }

  // ── token 价：**两种 quotaType 都要算** ──
  //
  // 旧实现在 quotaType===1 时直接把 token 价置 0 并 return，于是网关明明报了
  // model_ratio / completion_ratio 也被丢掉。后果是三处口径同时错：
  //   ① `toModelPricing` 拿不到价 → 计价落 FALLBACK_PRICING（$2/$10），实测把
  //      claude-sonnet-5-ppchat 21 条账本记录全部按兜底价算；
  //   ② 面板只剩「$60.00/次」可显示，而账本记的是另一套数 —— 展示与计费自相矛盾；
  //   ③ 因为价「查不到」，跨桶兜底被激活去借**别的端点**的价（见 lookupGatewayEntry）。
  // 换算公式与 quotaType=0 完全一致，不需要第二套口径。
  const mr = raw.model_ratio;
  // 按 token 计费的条目必须有合法 model_ratio —— 它是这条唯一的价，缺了整条无用。
  // 按次条目允许缺（doubao-seedream 这类纯按次模型），此时 input=0，计价自然退回兜底。
  if (quotaType === 0 && !isFiniteNonNeg(mr)) return null;
  const hasTokenPrice = isFiniteNonNeg(mr) && mr > 0;
  const input = hasTokenPrice ? mr * RATIO_TO_USD_PER_M : 0;

  const compRatio = isFiniteNonNeg(raw.completion_ratio) ? raw.completion_ratio : 0;
  const cacheRatio = isFiniteNonNeg(raw.cache_ratio) ? raw.cache_ratio : undefined;
  const createCacheRatio = isFiniteNonNeg(raw.create_cache_ratio)
    ? raw.create_cache_ratio
    : undefined;

  const entry: GatewayPricingEntry = {
    input,
    output: input * compRatio,
    quotaType,
  };
  if (cacheRatio !== undefined) entry.cacheRead = input * cacheRatio;
  if (createCacheRatio !== undefined) entry.cacheWrite = input * createCacheRatio;
  else entry.cacheWrite = 0; // 网关未给 create_cache_ratio 时按 0（多数网关缓存写入不额外计费）
  if (perCallUSD !== undefined) entry.perCallUSD = perCallUSD;
  if (endpointTypes) entry.supportedEndpointTypes = endpointTypes;

  return { name, entry };
}

/** 计算聚合版本哈希（内容指纹，用于「变了才写盘」）。
 *
 *  ⚠ **指纹必须覆盖每一个会落盘的字段**。`supportedEndpointTypes` 加入采集时如果漏掉这里，
 *  会得到一个很隐蔽的失效形态：老用户盘上已有缓存，价格没变 → 指纹相同 →
 *  `syncGatewayPricing` 走「版本未变，跳过写盘」分支 → **新字段永远写不进磁盘**，
 *  而内存里有、日志显示采集成功、下次启动又没了。不写盘就等于没采。
 *  该字段已在 sanitizeEndpointTypes 里排序，所以网关返回顺序抖动不会让指纹无谓变化。 */
function computeVersion(models: Record<string, GatewayPricingEntry>): string {
  // 简单稳定哈希：排序后 JSON 的 djb2。避免依赖 crypto，纯确定性。
  const keys = Object.keys(models).sort();
  let str = "";
  for (const k of keys) {
    const m = models[k];
    str += `${k}:${m.input},${m.output},${m.cacheRead ?? ""},${m.cacheWrite ?? ""},${m.quotaType},${m.perCallUSD ?? ""},${m.supportedEndpointTypes?.join("+") ?? ""}|`;
  }
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
  }
  return (hash >>> 0).toString(16);
}

/** 从 base_url 推 `/api/pricing` 接口地址（剥 `/v1` 等路径后缀，取 origin）。 */
export function derivePricingURL(baseURL: string): string {
  try {
    const u = new URL(baseURL);
    return `${u.protocol}//${u.host}/api/pricing`;
  } catch {
    // 非法 URL：best-effort 拼接。
    const trimmed = baseURL.replace(/\/+$/, "").replace(/\/v\d+$/, "");
    return `${trimmed}/api/pricing`;
  }
}

/** 把磁盘缓存文件解析为分桶结构（兼容旧版 v1 扁平结构，迁移到 endpoints[""])。 */
function parseCacheFile(raw: unknown): GatewayCacheFile | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Partial<GatewayCacheFile> & LegacyCacheFileV1;

  // 新版分桶结构（v2 / v3）。
  if (obj.endpoints && typeof obj.endpoints === "object") {
    // ⚠ v2 及更早的桶是**被 bug 污染过的产物**：那时 `convertRawEntry` 在 quotaType=1 时
    // 把 token 价硬置 0，于是「网关同时报了 token 价」这个事实在缓存里已经丢失，
    // 且与「真的只有按次价」（doubao-seedream 图片类）**字节上完全同形**，无法就地修复。
    //
    // 处理方式是 `fetched_at = 0` —— **保留价格、只把桶标记为过期**：
    //   - 不清空 models：清空会让本该有渠道价的模型在重采完成前落 FALLBACK，
    //     把一次静默低估换成另一次静默低估，而重采是异步的（端点不可达时可能一直不完成）；
    //   - 标记过期则 `maybeRefreshGatewayPricing` / `refreshGatewayPricingOnStartup` 的
    //     TTL 判据（`Date.now() - fetchedAt > ttlMs`）必然成立 → 下次启动立刻后台重采，
    //     采到即自愈，不必等 24h TTL 自然到期。
    // 负缓存（failed_at / fail_count）照原样保留：端点可达性与这次的换算 bug 无关，
    // 抹掉它会让不可达端点重新开始每次启动白烧 socket。
    const stale = obj.schema_version !== 3;
    const endpoints: Record<string, EndpointBucket> = {};
    for (const [key, bucket] of Object.entries(obj.endpoints)) {
      if (bucket && typeof bucket.models === "object" && bucket.models) {
        endpoints[key] = {
          source_url: bucket.source_url ?? "",
          fetched_at: stale ? 0 : (bucket.fetched_at ?? 0),
          pricing_version: bucket.pricing_version ?? "",
          models: bucket.models,
          // 负缓存字段（第三方/旧文件可能缺失或类型不对，做有限数值校验后再采纳）。
          failed_at: isFiniteNonNeg(bucket.failed_at) ? bucket.failed_at : undefined,
          fail_count: isFiniteNonNeg(bucket.fail_count) ? bucket.fail_count : undefined,
        };
      }
    }
    return { schema_version: 3, endpoints };
  }

  // 旧版 v1：单端点扁平结构 → 迁移到 endpoints[""]（无端点维度，归一化后为空 key）。
  if (obj.models && typeof obj.models === "object") {
    return {
      schema_version: 3,
      endpoints: {
        "": {
          source_url: obj.source_url ?? "",
          // 同上：v1 比 v2 更旧，一律按过期处理以触发重采。
          fetched_at: 0,
          pricing_version: obj.pricing_version ?? "",
          models: obj.models,
        },
      },
    };
  }

  return null;
}

/**
 * 记一次采集失败到端点桶（负缓存），用于下次启动的指数退避判断。
 *
 * 只动 failed_at / fail_count 两个字段：**保留该桶已有的 models 与 fetched_at**——
 * 失败不该抹掉上一次成功采到的价格，也不该冒充"采过了"去满足成功 TTL。
 * 桶不存在（从没采成功过）则建一个空 models 的占位桶，纯粹承载退避状态。
 * 全程 try/catch 吞掉：负缓存写不进去顶多退化成旧行为（每次重试），绝不能反过来影响启动。
 */
function recordFailure(endpointKey: string, url: string): void {
  try {
    const file: GatewayCacheFile = readCacheFile() ?? { schema_version: 3, endpoints: {} };
    const prev = file.endpoints[endpointKey];
    file.endpoints[endpointKey] = {
      source_url: prev?.source_url ?? url,
      fetched_at: prev?.fetched_at ?? 0,
      pricing_version: prev?.pricing_version ?? "",
      models: prev?.models ?? {},
      failed_at: Date.now(),
      fail_count: (prev?.fail_count ?? 0) + 1,
    };
    file.schema_version = 3;
    // 内存侧同步失败计数：本次会话内该桶立刻停止对外借价（跨桶兜底判据）。
    // 不同步会留下"盘上已记失败、内存仍当健康桶借价"的窗口，直到下次进程重启才生效。
    memBucketFailCount[endpointKey] = file.endpoints[endpointKey].fail_count ?? 1;
    // 原子写：半截 JSON 会让整份缓存（含其他端点桶）作废，见 writeCacheFileAtomic。
    writeCacheFileAtomic(file);
  } catch {
    /* 负缓存写入失败：退化为旧行为，不影响启动与计费 */
  }
}

/** 从磁盘读缓存文件（含旧版迁移）。失败返回 null。 */
function readCacheFile(): GatewayCacheFile | null {
  try {
    const path = sidPaths.gatewayPricing();
    if (!existsSync(path)) return null;
    return parseCacheFile(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/**
 * 原子落盘：先写 `.tmp` 再 `rename`。两个写点（recordFailure / syncGatewayPricing）共用。
 *
 * ── 原子写与「丢更新」是两件不同的事，本函数只解决前者 ──────────────────
 *
 * 修前两处都是裸 `writeFileSync(path, ...)` 直写目标文件。进程在写入中途被杀
 * （Ctrl+C / OOM / kill）会留下**半截 JSON** → 下次 `readCacheFile()` 的 `JSON.parse`
 * 抛错 → catch 返回 null → **整份价格缓存作废（含所有其他端点桶）**，全部退回兜底计价。
 * 一次误杀换来所有渠道的错价，而且不报错。
 *
 * 本模块**不需要**补「写盘前重读磁盘」那一半：两个写点本来就是 read-modify-write
 * （`readCacheFile() ?? {...}` → 只改本端点桶 → 写回），跨端点桶的丢更新已由多端点
 * 分桶那次修复顺手治掉。这与 `model-capabilities.ts` 的缺口正好互补 ——
 * 那边从不重读、但早有原子写；这边一直重读、却没有原子写。
 * ⚠ 别照着方案文档 §6.2 的原文给这里补重读，那是在补一个它已经有的东西。
 *
 * 残留窗口（次要，但不声称为零）：`readCacheFile()` 到 `rename` 之间仍有丢更新窗口，
 * `syncGatewayPricing` 在读盘之前刚做完一次网络 fetch，窗口宽于 `recordFailure`。
 * 刻意不引 flock：价格缓存是纯优化项，真撞上的后果仅是下次 TTL 到期重采，不产生错数字，
 * 为它加一个跨进程锁依赖代价更大（与 model-capabilities.ts::persist 同一取舍）。
 *
 * @returns 是否写成功。失败只记日志——写不进去顶多退化成旧行为，绝不能反过来影响启动或计费。
 */
function writeCacheFileAtomic(file: GatewayCacheFile): boolean {
  try {
    const path = sidPaths.gatewayPricing();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), "utf8");
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** 读缓存文件到内存（启动时调用一次；幂等）。 */
export function loadGatewayCache(): void {
  if (memLoaded) return;
  memLoaded = true;
  try {
    const file = readCacheFile();
    if (!file) return;
    memBuckets = {};
    memBucketFailCount = {};
    let total = 0;
    for (const [key, bucket] of Object.entries(file.endpoints)) {
      memBuckets[key] = bucket.models;
      memBucketFailCount[key] = bucket.fail_count ?? 0;
      total += Object.keys(bucket.models).length;
    }
    log().debug(
      "GATEWAY-PRICING",
      `载入网关定价缓存 ${total} 条 / ${Object.keys(memBuckets).length} 端点`,
    );
  } catch (e) {
    log().warn("GATEWAY-PRICING", "载入网关定价缓存失败，回退注册表", { error: String(e) });
  }
}

/**
 * 是否**厂商裸名**（= 内置注册表里有这个精确键），如 `deepseek-v4-pro` / `DeepSeek-V4-Pro`。
 * 带渠道前缀的网关名（`ali-deepseek-v4-pro` / `gw-claude-sonnet-5`）返回 false。
 *
 * ⚠ 判据必须是**注册表精确键**，两条都实测验证过，别改成看起来更简单的写法：
 *
 * - **不能用字符串前缀切分**（"第一个连字符之前算前缀"）：`deepseek-v4-pro` 会被切出
 *   `deepseek` 这个"前缀"，于是官方裸名被判成"带渠道前缀"→ 约束失效 →
 *   本次 4.94× 的事故原样复发。实测：naivePrefix("deepseek-v4-pro") === "deepseek"。
 * - **不能用 `lookupRegistry(model) !== null`**：它带**前缀剥离**兜底，
 *   `lookupRegistry("ali-deepseek-v4-pro")` 照样返回 0.435（官方价）→ 渠道名被判成裸名 →
 *   禁止它跨桶兜底 → 反而复发它本要修的「渠道名套官方价、**低估** 3.7 倍」。
 *   实测：`ali-deepseek-v4-pro` exactKey=false 但 lookupRegistry=0.435。
 *
 * ⚠ 上面那条约束（2026-08-20）已从「注释里的警告」升级为**类型层面的选择**：
 * `lookupRegistryExact` 只做精确 + 大小写不敏感，模糊兜底在 `lookupRegistryFuzzy` 里。
 * 这里改用前者，语义与「注册表精确键」严格一致，且不必再自己维护键集合缓存。
 * 大小写各自登记（注册表里 `deepseek-v4-pro` 与 `DeepSeek-V4-Pro` 是两个键），
 * 这一层由 `lookupRegistryExact` 内部覆盖，避免仅因写法不同而漏判成渠道名。
 */
function isBareVendorName(model: string): boolean {
  return lookupRegistryExact(model) !== null;
}

/**
 * 厂商**官方**端点白名单（host 后缀匹配）。
 *
 * 命中即「这是厂商直连，不是 new-api 类网关」→ 官方价一律以内置注册表为准，
 * 跳过网关采集价。理由是官方端点**根本没有** `/api/pricing` 这个接口（那是 new-api
 * 的私有接口），`derivePricingURL` 拼出来的 URL 必然失败，只会留下一个
 * `fail_count>0` + `models:{}` 的空桶——而空桶又会触发跨桶兜底去抓**别的渠道**的价。
 *
 * 2026-08-11 实测事故：`resolvePricing("deepseek-v4-pro", …, "https://api.deepseek.com")`
 * 返回 `{input: 1.64383, cacheRead: 0.137}`（某网关渠道价），而正确的官方价躺在注册表里
 * （`{input: 0.435, cacheRead: 0.0036}`）。cacheRead 偏离 **38.1×**，且本次 81.2% 的
 * token 都是缓存命中 → 费用被高估 393%。见修复方案 §2.4(c)。
 */
const OFFICIAL_ENDPOINT_HOSTS = [
  "api.deepseek.com",
  "api.anthropic.com",
  "api.openai.com",
  "api.moonshot.cn",
  "api.moonshot.ai",
  "open.bigmodel.cn",
  "dashscope.aliyuncs.com",
  "ark.cn-beijing.volces.com",
  "api.minimax.chat",
  "api.x.ai",
  "generativelanguage.googleapis.com",
];

/**
 * 是否厂商官方端点（→ 计价直接用内置注册表，不碰网关采集价）。
 *
 * 只按 host 判，不看路径：同一 host 上 `/v1` 与无路径是不同部署，但都是官方直连。
 * 用后缀匹配而非全等，兼容 `api.deepseek.com:443` 这类带端口写法被 URL 归一化后的形态。
 */
export function isOfficialEndpoint(baseURL?: string): boolean {
  if (!baseURL) return false;
  let host: string;
  try {
    host = new URL(baseURL.trim()).hostname.toLowerCase();
  } catch {
    return false;
  }
  return OFFICIAL_ENDPOINT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * 采集条目查询（**唯一入口**）—— 只读内存缓存，**绝不触网**。
 *
 * ## 为什么必须只有这一个入口
 *
 * 修前有两条互不知情的查找路径：本函数（当时叫 `lookupGatewayPricing`，带三条约束）
 * 与 `model-profile.ts::getPerCallUSD`（**零约束**，直接
 * `getAllGatewayEntries(baseURL)[name] ?? getAllGatewayEntries()[name]`）。
 * 第二个参数省掉 baseURL 时返回的是**全部端点桶的合并视图**，于是按次价可以无条件
 * 跨端点借用：实测 `claude-sonnet-4-6` 配在 uniapi、面板显示的 $36.00/次 来自
 * **ppchat 桶**——而它是注册表裸名（$3/$15），按约束 (b) 本就不该跨桶借价。
 *
 * 三条约束写在一处、两个消费点共用，是这次修复的结构性部分：给第二条路径补一份
 * 约束副本，下一个新增的消费点还是会漏（本仓「手写字段列表漏字段」有前科）。
 *
 * ## 查找顺序
 *   0. 官方厂商端点直接返回 null → 由 resolvePricing 落到内置注册表（权威官方价）。
 *   1. 请求端点桶（normalizeBaseURL）里的精确渠道条目；别名 miss 后按真名重查一次。
 *   2. 仍未命中才跨桶按名兜底，受下面两条约束。
 *
 * ## 别名解析：为什么这一层必须查两次（本次新增）
 *
 * 网关采集按**真名**入库（`/api/pricing` 报的是 `claude-sonnet-5`），而配置侧的键是
 * **别名**（`claude-sonnet-5-ppchat`，靠 `model_id` 指向真名）。修前两条查找路径都只按
 * 别名查 → 必然 miss → 一路落到注册表；而 `claude-sonnet-5` / `glm-5.3` 这类**新模型
 * 注册表尚未收录** → 最终落 FALLBACK_PRICING（$2/$10）。
 *
 * 实测后果（`usage-ledger.jsonl` 反算）：`claude-sonnet-5-ppchat` 21 条记录里 20 条与
 * $2/$10 吻合到 1e-6 —— 明明采到了 $1.4/$7 的渠道价，账本却整段按兜底价记。
 * 四个配了 `model_id` 的模型全部命中（两个 claude + 两个 glm）。
 *
 * ⚠ 顺序是**别名优先、真名兜底**，不能反：别名命中的是「这条渠道的价」，而
 * `wire-model.ts` 的分工表明确写了计价留在别名侧（同一真名接两个渠道时差价不能被抹平）。
 * 真名只在别名 miss 时补位——那正是"网关按真名入库"造成的 miss。
 *
 * ## 跨桶兜底的两条约束（2026-08-11 计费错 4.94× 的修复，别放宽）
 *
 * **(a) 失效桶不参与兜底**：`fail_count > 0` 或 `models` 为空的桶跳过。失败中的端点，
 * 其价格是上一次成功时的旧快照，借给**别的**端点用是双重不确定；而空桶更危险——
 * 它会让「本该回落注册表」变成「静默抓到某个不相干渠道的价」，且不报错。
 *
 * **(b) 裸名不得跨桶兜底**：只有**带渠道前缀**的名字（`ali-deepseek-v4-pro`）才可跨桶借价。
 * 本模块顶部注释记录的跨桶兜底本意是修「`ali-deepseek-v4-pro` 被剥成
 * `deepseek-v4-pro` 套官方价、低估 3.7 倍」——它修对了**带前缀的渠道名**，
 * 却修错了**裸名**：原设计假设「裸名 = 需要兜底」，但裸名恰恰也是**官方直连**的名字。
 * 于是官方端点请求 `deepseek-v4-pro` 时跨桶抓到了空 key 桶里某网关的 `deepseek-v4-pro`
 * （$1.64383，正确值 $0.435）。裸名回落注册表才是对的。
 *
 * 注：这条约束**不能**写成「同前缀才可互兜」——本函数按精确名查各桶，跨桶时两边键名
 * 是同一个字符串，前缀比较恒为真，那样写等于没有约束。
 *
 * @param model  本地别名（`availableModels[].name`）
 * @param baseURL 本次请求的端点
 * @param wireModel 该别名对应的厂商真名（`resolveWireModel` 的结果）。
 *        与 model 相同或省略时退化为只按别名查，行为与修前一致。
 */
export function lookupGatewayEntry(
  model: string,
  baseURL?: string,
  wireModel?: string,
): GatewayPricingEntry | null {
  if (!memLoaded) loadGatewayCache();

  // 0. 官方厂商端点：注册表优先级高于网关采集价，直接退出让 resolvePricing 走注册表。
  //    官方端点桶本就采不到东西（无 /api/pricing），留在这里只会被下面的兜底拿去乱借价。
  if (isOfficialEndpoint(baseURL)) return null;

  // 待查的名字：别名优先，真名兜底（真名与别名相同时不重复查）。
  const names = wireModel && wireModel !== model ? [model, wireModel] : [model];

  // 1. 端点精确桶（该端点自己采到的价，最权威；失败态不影响自己的价）。
  //
  // 例外：**空 key 桶 + 厂商裸名** → 同样让注册表赢。空 key（`endpoints[""]`）名义上是
  // "官方默认端点"，实际却是个**成分不明的收纳桶**：`syncGatewayPricing({url})`
  // 不带 baseURL 时、以及旧版 v1 扁平结构迁移时，采到的价都落在这里。本次事故里它装的
  // 正是某网关渠道价（`deepseek-v4-pro` → $1.64383）。
  // 而"没有 baseURL"这件事本身就意味着走厂商官方直连（要用网关必须配 baseURL），
  // 所以裸名撞上空 key 桶时，可信的是注册表而非这桶来源不明的采集价。
  // 带渠道前缀的名字（`ali-…`）不受影响，仍照用空 key 桶里的渠道价。
  // ⚠ 这一步返回**条目本身**，命中即停 —— 不再像修前那样先过 `toModelPricing` 再决定
  //   要不要继续跨桶。这是一处刻意的行为变化：本端点桶里有这个模型（哪怕它自报零价）
  //   就是**这个端点的权威事实**，不该被别的渠道的价盖掉。修前「零价 → 继续跨桶」
  //   会让一个自报免费的内部渠道静默套上另一个网关的收费价（虚高，且不报错）。
  //   零价能不能用于计价由 `toModelPricing` 在外层判（`input > 0`），与"要不要借价"无关。
  const key = normalizeBaseURL(baseURL);
  const ownBucket = memBuckets[key];
  if (ownBucket) {
    for (const n of names) {
      if (key === "" && isBareVendorName(n)) continue;
      const hit = ownBucket[n];
      if (hit) return hit;
    }
  }

  // 2. 跨桶按名兜底 —— 受「裸名禁止跨桶」+「失效桶不参与」两条约束。
  //
  // ⚠ 约束 (b) 的判据是**这个名字是不是厂商裸名**，不是"两个名字前缀是否相同"。
  //   本函数按**精确名**查各桶，跨桶时两边键名本就是同一个字符串，
  //   "同前缀才可互兜"在这里恒为真、拦不住任何东西（写成那样是个空判断）。
  //   真正要拦的是：**裸名**（= 厂商官方模型名）不得从别的桶借价，该回落注册表。
  //
  // ⚠ 逐个名字判，不是"任一是裸名就整体放弃"：别名是自定义名（可跨桶）而真名常是裸名
  //   （不可跨桶），两者约束不同，合并判会同时放错和拦错。
  const borrowable = names.filter((n) => !isBareVendorName(n));
  if (borrowable.length === 0) return null;

  // 官方端点桶 "" 优先（历史行为保留：它通常是"没配 baseURL"时采到的那份）。
  //
  // ⚠ 与步骤 1 相反，这里**跳过零价条目继续找**（`usable` 判 `input > 0`）。两步不对称
  //   是有理由的，别"统一"成一样：
  //   - 步骤 1 是**权威事实**——本端点自己报的价，零价也算这个端点的答案，命中即停；
  //   - 本步是**任选借用**——从哪个桶借都无所谓，借到一条没有 token 价的条目等于没借到，
  //     停在它上面只会让本可借到的价白白丢掉（保留了修前的语义）。
  //   纯按次条目（input=0、有 perCallUSD）在这里同样被跳过：按次价是端点自己的计费口径，
  //   跨端点借用毫无意义 —— 这正是「$36.00/次 张冠李戴」那个缺陷的形态。
  const usable = (e?: GatewayPricingEntry): boolean => !!e && e.input > 0;
  const orderedKeys = ["", ...Object.keys(memBuckets).filter((k) => k !== "")];
  for (const k of orderedKeys) {
    if (k === key) continue; // 步骤 1 已查过
    const models = memBuckets[k];
    if (!models) continue;
    if (isBucketUnusableForFallback(k, models)) continue; // 约束 (a)
    for (const n of borrowable) {
      const hit = models[n];
      if (usable(hit)) return hit;
    }
  }
  return null;
}

/**
 * 计费热路径：查这条模型的 **per-token** 渠道价。
 *
 * 薄封装在 `lookupGatewayEntry` 之上——约束只有一份（见该函数）。
 * 拿到条目后由 `toModelPricing` 决定能不能用于计价：`input > 0` 才算有 token 价，
 * 纯按次条目（图片/视频类）此处返回 null，退回注册表兜底。
 */
export function lookupGatewayPricing(
  model: string,
  baseURL?: string,
  wireModel?: string,
): ModelPricing | null {
  return toModelPricing(lookupGatewayEntry(model, baseURL, wireModel));
}

/**
 * 展示层：查这条模型的**按次单价**（USD/次），没有则 undefined。
 *
 * 与 `lookupGatewayPricing` 共用同一套约束与别名解析 —— 这正是修前缺的那一半：
 * 旧 `getPerCallUSD` 走的是无约束的合并视图，于是显示出别的端点的按次价。
 */
export function lookupGatewayPerCallUSD(
  model: string,
  baseURL?: string,
  wireModel?: string,
): number | undefined {
  const entry = lookupGatewayEntry(model, baseURL, wireModel);
  if (entry && typeof entry.perCallUSD === "number") return entry.perCallUSD;
  return undefined;
}

/**
 * 该桶是否**不可**用于跨桶兜底（失效桶）。
 *
 * 两个条件任一命中即失效：
 * - `models` 为空：从没采成功过（或采到的全是非法条目），没有任何可借的价；
 * - `fail_count > 0`：处于连续失败态，价格是旧快照，借给别的端点不可信。
 */
function isBucketUnusableForFallback(
  key: string,
  models: Record<string, GatewayPricingEntry>,
): boolean {
  if (Object.keys(models).length === 0) return true;
  return (memBucketFailCount[key] ?? 0) > 0;
}

/**
 * GatewayPricingEntry → ModelPricing（零价返回 null，退回兜底）。
 *
 * ⚠ 判据是 **`input > 0`，不是 `quotaType !== 1`**。旧实现按 quotaType 一刀切，
 * 于是网关同时报了 token 价的按次条目（实测 ppchat 14/14 全部如此）也被判成"无价"
 * → 计价落 FALLBACK_PRICING $2/$10。现在 quotaType 只描述网关自己的计费口径，
 * 「有没有 token 价」由 input 说话：纯按次条目 input=0 自然返回 null，
 * 而带 token 价的按次条目照常进计费。
 */
function toModelPricing(entry?: GatewayPricingEntry | null): ModelPricing | null {
  if (!entry) return null;
  if (!(entry.input > 0)) return null; // 免费/零价/纯按次模型不覆盖注册表
  return {
    input: entry.input,
    output: entry.output,
    cacheRead: entry.cacheRead,
    cacheWrite: entry.cacheWrite,
  };
}

/**
 * 读取网关缓存的元信息（供 fetched_at / TTL 判断与展示）。
 * @param baseURL 指定端点则返回该端点桶的元信息；不传则返回聚合（最早 fetched_at + 总条数）。
 */
export function getGatewayCacheMeta(
  baseURL?: string,
): { fetchedAt: number; version: string; count: number } | null {
  const file = readCacheFile();
  if (!file) return null;

  if (baseURL !== undefined) {
    const bucket = file.endpoints[normalizeBaseURL(baseURL)];
    if (!bucket) return null;
    return {
      fetchedAt: bucket.fetched_at,
      version: bucket.pricing_version,
      count: Object.keys(bucket.models).length,
    };
  }

  // 聚合：最早 fetched_at（最保守的 TTL 判断口径）+ 总条数 + 各桶版本拼接。
  const buckets = Object.values(file.endpoints);
  if (buckets.length === 0) return null;
  let earliest = Infinity;
  let count = 0;
  const versions: string[] = [];
  for (const b of buckets) {
    if (b.fetched_at > 0 && b.fetched_at < earliest) earliest = b.fetched_at;
    count += Object.keys(b.models).length;
    versions.push(b.pricing_version);
  }
  return {
    fetchedAt: Number.isFinite(earliest) ? earliest : 0,
    version: versions.join(","),
    count,
  };
}

/**
 * 供展示层遍历采集条目（含按次计费，用于 /model pricing --all）。
 * @param baseURL 指定端点则只返回该端点桶；不传则合并全部端点（同名后桶覆盖前桶，仅用于展示）。
 */
export function getAllGatewayEntries(baseURL?: string): Record<string, GatewayPricingEntry> {
  if (!memLoaded) loadGatewayCache();
  if (baseURL !== undefined) {
    return { ...(memBuckets[normalizeBaseURL(baseURL)] ?? {}) };
  }
  const merged: Record<string, GatewayPricingEntry> = {};
  for (const models of Object.values(memBuckets)) {
    Object.assign(merged, models);
  }
  return merged;
}

/**
 * 拉取 + 解析 + 校验 + 写缓存（分桶合并）+ 刷新内存。
 *
 * @returns updated=是否有写盘（内容变化）；count=解析成功条数；version=聚合哈希；reason=说明
 */
export async function syncGatewayPricing(opts?: {
  url?: string;
  baseURL?: string;
  force?: boolean;
  timeoutMs?: number;
}): Promise<{ updated: boolean; count: number; version: string; reason: string }> {
  const url = opts?.url ?? (opts?.baseURL ? derivePricingURL(opts.baseURL) : undefined);
  if (!url) {
    return { updated: false, count: 0, version: "", reason: "未提供采集 URL 或 baseURL" };
  }

  // 此端点桶的归一化 key（用户传 baseURL 时按端点分桶；只传 url 时归到官方桶 ""）。
  const endpointKey = normalizeBaseURL(opts?.baseURL);

  const timeoutMs = opts?.timeoutMs ?? resolveSideCallTimeouts().gatewayPricingMs;
  const controller = new AbortController();
  // 自己 abort 的要留标记：裸 AbortError 的 message 是 "The operation was aborted."，
  // 完全看不出是"我们的超时"还是别的原因，排查时只能靠猜（这次线上反馈就卡在这）。
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let raw: { data?: RawPricingEntry[] };
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json, text/plain, */*", "new-api-user": "-1" },
      signal: controller.signal,
    });
    if (!resp.ok) {
      recordFailure(endpointKey, url);
      emit({
        endpoint: endpointKey,
        url,
        outcome: "failed",
        count: 0,
        version: "",
        dropped: 0,
        reason: `HTTP ${resp.status}`,
      });
      return { updated: false, count: 0, version: "", reason: `HTTP ${resp.status}` };
    }
    raw = (await resp.json()) as { data?: RawPricingEntry[] };
  } catch (e) {
    // 超时说人话（含阈值与可调环境变量），其余错误保留原文。
    const reason = timedOut
      ? `采集超时 ${timeoutMs}ms（可用 SID_CODE_GATEWAY_PRICING_TIMEOUT_MS 调整）`
      : `采集失败: ${String(e)}`;
    // 定价采集是**纯优化项**：失败只是退回内置注册表估价，功能不受影响，用户无需处置
    // → 用 debug 级而非 warn。warn 会经 logger 的 stderr 兜底路径打到终端惊扰用户
    //（本次线上反馈的直接症状），而这条信息对用户不可行动。
    log().debug("GATEWAY-PRICING", `${reason}，保留旧缓存并回退注册表估价`, { url });
    // 记负缓存：不可达端点不再每次启动都白烧一个 socket，按指数退避冷却。
    recordFailure(endpointKey, url);
    emit({
      endpoint: endpointKey,
      url,
      outcome: "failed",
      count: 0,
      version: "",
      dropped: 0,
      reason,
    });
    return { updated: false, count: 0, version: "", reason };
  } finally {
    clearTimeout(timer);
  }

  const list = Array.isArray(raw?.data) ? raw.data : [];
  const models: Record<string, GatewayPricingEntry> = {};
  let dropped = 0;
  for (const item of list) {
    const converted = convertRawEntry(item);
    if (!converted) {
      dropped++;
      continue;
    }
    models[converted.name] = converted.entry;
  }

  const count = Object.keys(models).length;
  if (count === 0) {
    // 连得上但返回不可用（非 new-api 网关 / 结构变更）——同样退避，否则每次启动照样白跑一趟。
    recordFailure(endpointKey, url);
    emit({
      endpoint: endpointKey,
      url,
      outcome: "failed",
      count: 0,
      version: "",
      dropped,
      reason: "解析后无有效条目",
    });
    return { updated: false, count: 0, version: "", reason: "解析后无有效条目" };
  }

  const version = computeVersion(models);

  // 读现有缓存文件（含旧版迁移），只更新本端点桶，其余端点桶原样保留（修复互相覆盖）。
  const file: GatewayCacheFile = readCacheFile() ?? { schema_version: 3, endpoints: {} };
  const existing = file.endpoints[endpointKey];

  // 版本比对：本端点桶内容未变则不写盘（除非 force）。
  // 例外：桶里还挂着未清的失败态（failed_at/fail_count）时必须落盘一次把它清掉 ——
  // 否则「端点已恢复但价格恰好没变」会让退避状态永久留存，之后每次都被冷却挡住不再采集。
  const hasStaleFailure = !!(existing?.failed_at || existing?.fail_count);
  if (!opts?.force && existing && existing.pricing_version === version && !hasStaleFailure) {
    memBuckets[endpointKey] = models;
    // 采集成功 → 清内存失败计数，桶重新可用于跨桶兜底（与写盘处"成功即清零"同口径）。
    memBucketFailCount[endpointKey] = 0;
    memLoaded = true;
    emit({
      endpoint: endpointKey,
      url,
      outcome: "unchanged",
      count,
      version,
      dropped,
      reason: "版本未变，跳过写盘",
    });
    return { updated: false, count, version, reason: "版本未变，跳过写盘" };
  }

  // 成功即整桶重写：**故意不带** failed_at / fail_count —— 这就是"成功一次清零退避"。
  file.endpoints[endpointKey] = {
    source_url: url,
    fetched_at: Date.now(),
    pricing_version: version,
    models,
  };
  file.schema_version = 3;

  // 原子写：半截 JSON 会让整份缓存（含其他端点桶）作废，见 writeCacheFileAtomic。
  // 写盘失败仍继续刷新内存，本次会话可用。
  if (!writeCacheFileAtomic(file)) {
    log().warn("GATEWAY-PRICING", "写缓存失败", { endpoint: endpointKey });
  }

  memBuckets[endpointKey] = models;
  // 采集成功 → 清内存失败计数（磁盘侧靠"整桶重写不带 fail_count"实现，见上方注释）。
  memBucketFailCount[endpointKey] = 0;
  memLoaded = true;
  log().info(
    "GATEWAY-PRICING",
    `采集完成 ${count} 条${dropped > 0 ? `（丢弃 ${dropped} 非法条目）` : ""}`,
    { version, endpoint: endpointKey },
  );
  emit({
    endpoint: endpointKey,
    url,
    outcome: "updated",
    count,
    version,
    dropped,
    reason: dropped > 0 ? `成功（丢弃 ${dropped} 非法）` : "成功",
  });
  return {
    updated: true,
    count,
    version,
    reason: dropped > 0 ? `成功（丢弃 ${dropped} 非法）` : "成功",
  };
}

/**
 * 该端点是否处于失败冷却期（负缓存未到期）→ 本次启动**直接跳过**，不发请求。
 *
 * 这是"端点长期不可达仍每次启动重试"的闸门：不可达端点第 1 次失败后冷却 5min，
 * 第 2 次 10min、第 3 次 20min…封顶 24h，而非每次启动都白烧一个 15s socket。
 * 返回剩余冷却毫秒数（>0 表示应跳过），便于日志说明还要等多久。
 */
export function getFailureCooldownRemainingMs(baseURL?: string): number {
  const file = readCacheFile();
  if (!file) return 0;
  const bucket = file.endpoints[normalizeBaseURL(baseURL)];
  if (!bucket?.failed_at || !bucket.fail_count) return 0;
  const elapsed = Date.now() - bucket.failed_at;
  // failed_at 在未来（系统时钟回拨/被手改）→ 视为已过期，宁可多采一次也不永久锁死。
  if (elapsed < 0) return 0;
  return Math.max(0, computeFailureBackoffMs(bucket.fail_count) - elapsed);
}

/**
 * 启动惰性刷新：先载入缓存（快），若超 TTL 则后台 fire-and-forget 刷新，不阻塞启动。
 *
 * @param baseURL 当前主模型端点（从中推 /api/pricing）
 */
export function maybeRefreshGatewayPricing(baseURL?: string, ttlMs = DEFAULT_TTL_MS): void {
  loadGatewayCache();
  if (!baseURL) return;
  // 失败冷却期内直接跳过（负缓存）。
  if (getFailureCooldownRemainingMs(baseURL) > 0) return;
  // 按端点桶判 TTL：该端点没采过或超 TTL 才刷新（不同端点各自独立 TTL）。
  const meta = getGatewayCacheMeta(baseURL);
  const stale = !meta || Date.now() - meta.fetchedAt > ttlMs;
  if (!stale) return;
  // 后台静默刷新，失败不阻塞、不抛。
  void syncGatewayPricing({ baseURL }).catch(() => {});
}

/**
 * 启动时的网关定价刷新总入口（覆盖 update 后自动拉取场景）。
 *
 * 两种模式：
 * - **force=true（刚 update 过：二进制版本号变化）**：忽略 TTL，对**全部端点**各强制刷新一次，
 *   确保 update 后立即拿到最新渠道价，不必等 24h TTL 或用户手动 /model discover --pricing。
 * - **force=false（日常启动）**：退化为原 maybeRefreshGatewayPricing 的按端点 TTL 惰性刷新。
 *
 * 全程后台 fire-and-forget：失败静默保留旧缓存 + 回退注册表，绝不阻塞启动、绝不抛。
 *
 * @param endpoints 待刷新端点集合（调用方从 availableModels 的 baseURL + 顶层 config.baseURL 去重收集）
 * @param force     是否强制刷新（true 时忽略 TTL）
 * @param ttlMs     TTL（force=false 时生效）
 */
export function refreshGatewayPricingOnStartup(
  endpoints: string[],
  force: boolean,
  ttlMs = DEFAULT_TTL_MS,
): void {
  loadGatewayCache();
  // 去重 + 过滤空端点。
  const uniq = Array.from(new Set(endpoints.filter((e) => e && e.trim() !== "")));
  if (uniq.length === 0) return;

  for (const baseURL of uniq) {
    if (!force) {
      // 失败冷却期内直接跳过（负缓存）——不可达端点不再每次启动都白烧一个 socket。
      const cooldown = getFailureCooldownRemainingMs(baseURL);
      if (cooldown > 0) {
        log().debug(
          "GATEWAY-PRICING",
          `端点处于失败冷却期，跳过本次采集（剩余 ${Math.ceil(cooldown / 1000)}s）`,
          { baseURL },
        );
        continue;
      }
      // 日常：按端点桶判 TTL，未过期跳过。
      const meta = getGatewayCacheMeta(baseURL);
      const stale = !meta || Date.now() - meta.fetchedAt > ttlMs;
      if (!stale) continue;
    }
    // force=true 时忽略 TTL 与失败冷却（用户 update 或显式 /model discover --pricing 的
    // 明确意图优先，且能一次性把恢复了的端点从冷却态里救出来）；后台静默刷新，逐端点独立。
    void syncGatewayPricing({ baseURL, force }).catch(() => {});
  }
}

/** 仅测试用：重置内存态。 */
export function __resetGatewayPricingForTest(): void {
  memBuckets = {};
  memBucketFailCount = {};
  memLoaded = false;
}
