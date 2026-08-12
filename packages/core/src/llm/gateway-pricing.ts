/**
 * 网关定价自动采集 — 从 new-api 类网关（企业自建的 LLM 中转站常用这类实现）的
 * `/api/pricing` 接口采集**价格**，与官方注册表（model-registry.ts）的**能力字段**互补。
 *
 * 职责边界（严格）：
 * - **只采价格**。contextWindow / supportsThinking / protocolKind / maxOutputTokens 等能力字段
 *   永远以官方注册表为准，本模块绝不触碰。
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
 *   quota_type=1 → 按次计费（model_price USD/次），本期 per-token 计价无法表达 → 视为「网关未提供
 *                  可用 per-token 价」返回 null，退回注册表兜底（veo 视频类，通常非对话主模型）。
 *   quota_type=0 → 按上面 token 公式。
 *
 * 容错：第三方 HTTP 属**不可信数据**——严格数值校验（有限、非负），非法条目丢弃；网络/解析失败
 * 静默保留旧缓存 + 回退注册表，绝不阻塞启动或计费。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { sidPaths } from "../config/paths.ts";
import { normalizeBaseURL } from "./endpoint-key.ts";
import { resolveSideCallTimeouts } from "../config/network-profile.ts";
import type { ModelPricing } from "../api/cost-tracker.ts";
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
  model_price?: number; // quota_type=1 时的按次单价（USD/次）
  completion_ratio?: number;
  cache_ratio?: number;
  create_cache_ratio?: number;
}

/** 换算后的网关定价条目（缓存与内存态）。 */
export interface GatewayPricingEntry extends ModelPricing {
  /** 0=按 token（input/output 有效）；1=按次（perCallUSD 有效，input/output=0） */
  quotaType: number;
  /** 按次单价（USD/次），仅 quotaType=1 有值 */
  perCallUSD?: number;
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
  /** 缓存结构版本（区别于内容 pricing_version），便于将来迁移。 */
  schema_version: 2;
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
 * 把一条原始 pricing 换算成 GatewayPricingEntry。非法数据返回 null（调用方丢弃）。
 */
export function convertRawEntry(
  raw: RawPricingEntry,
): { name: string; entry: GatewayPricingEntry } | null {
  const name = raw.model_name;
  if (!name || typeof name !== "string") return null;

  const quotaType = raw.quota_type === 1 ? 1 : 0;

  if (quotaType === 1) {
    // 按次计费：只保留 perCallUSD，token 价置 0。
    const perCall = raw.model_price;
    if (!isFiniteNonNeg(perCall)) return null;
    return {
      name,
      entry: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        quotaType: 1,
        perCallUSD: perCall,
      },
    };
  }

  // 按 token 计费。
  const mr = raw.model_ratio;
  if (!isFiniteNonNeg(mr)) return null;
  const input = mr * RATIO_TO_USD_PER_M;

  const compRatio = isFiniteNonNeg(raw.completion_ratio) ? raw.completion_ratio : 0;
  const cacheRatio = isFiniteNonNeg(raw.cache_ratio) ? raw.cache_ratio : undefined;
  const createCacheRatio = isFiniteNonNeg(raw.create_cache_ratio)
    ? raw.create_cache_ratio
    : undefined;

  const entry: GatewayPricingEntry = {
    input,
    output: input * compRatio,
    quotaType: 0,
  };
  if (cacheRatio !== undefined) entry.cacheRead = input * cacheRatio;
  if (createCacheRatio !== undefined) entry.cacheWrite = input * createCacheRatio;
  else entry.cacheWrite = 0; // 网关未给 create_cache_ratio 时按 0（多数网关缓存写入不额外计费）

  return { name, entry };
}

/** 计算聚合版本哈希（内容指纹，用于「变了才写盘」）。 */
function computeVersion(models: Record<string, GatewayPricingEntry>): string {
  // 简单稳定哈希：排序后 JSON 的 djb2。避免依赖 crypto，纯确定性。
  const keys = Object.keys(models).sort();
  let str = "";
  for (const k of keys) {
    const m = models[k];
    str += `${k}:${m.input},${m.output},${m.cacheRead ?? ""},${m.cacheWrite ?? ""},${m.quotaType},${m.perCallUSD ?? ""}|`;
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

  // 新版 v2：分桶结构。
  if (obj.endpoints && typeof obj.endpoints === "object") {
    const endpoints: Record<string, EndpointBucket> = {};
    for (const [key, bucket] of Object.entries(obj.endpoints)) {
      if (bucket && typeof bucket.models === "object" && bucket.models) {
        endpoints[key] = {
          source_url: bucket.source_url ?? "",
          fetched_at: bucket.fetched_at ?? 0,
          pricing_version: bucket.pricing_version ?? "",
          models: bucket.models,
          // 负缓存字段（第三方/旧文件可能缺失或类型不对，做有限数值校验后再采纳）。
          failed_at: isFiniteNonNeg(bucket.failed_at) ? bucket.failed_at : undefined,
          fail_count: isFiniteNonNeg(bucket.fail_count) ? bucket.fail_count : undefined,
        };
      }
    }
    return { schema_version: 2, endpoints };
  }

  // 旧版 v1：单端点扁平结构 → 迁移到 endpoints[""]（无端点维度，归一化后为空 key）。
  if (obj.models && typeof obj.models === "object") {
    return {
      schema_version: 2,
      endpoints: {
        "": {
          source_url: obj.source_url ?? "",
          fetched_at: obj.fetched_at ?? 0,
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
    const file: GatewayCacheFile = readCacheFile() ?? { schema_version: 2, endpoints: {} };
    const prev = file.endpoints[endpointKey];
    file.endpoints[endpointKey] = {
      source_url: prev?.source_url ?? url,
      fetched_at: prev?.fetched_at ?? 0,
      pricing_version: prev?.pricing_version ?? "",
      models: prev?.models ?? {},
      failed_at: Date.now(),
      fail_count: (prev?.fail_count ?? 0) + 1,
    };
    file.schema_version = 2;
    const path = sidPaths.gatewayPricing();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(file, null, 2), "utf8");
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

/** 读缓存文件到内存（启动时调用一次；幂等）。 */
export function loadGatewayCache(): void {
  if (memLoaded) return;
  memLoaded = true;
  try {
    const file = readCacheFile();
    if (!file) return;
    memBuckets = {};
    let total = 0;
    for (const [key, bucket] of Object.entries(file.endpoints)) {
      memBuckets[key] = bucket.models;
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
 * 计费热路径查询 — 只读内存缓存，**绝不触网**。
 *
 * 端点感知（修复多端点覆盖后）：
 *   1. 先查请求端点（normalizeBaseURL(baseURL)）对应桶里的精确渠道价。
 *   2. 未命中再跨桶按模型名兜底（兼容没传 baseURL、或端点桶里没这个冷门模型的场景）。
 * 按次计费（quotaType=1）返回 null，由调用方退回注册表兜底。
 */
export function lookupGatewayPricing(model: string, baseURL?: string): ModelPricing | null {
  if (!memLoaded) loadGatewayCache();

  // 1. 端点精确桶。
  const key = normalizeBaseURL(baseURL);
  const primary = memBuckets[key]?.[model];
  const hit = toModelPricing(primary);
  if (hit) return hit;

  // 2. 跨桶按名兜底（同名渠道价在任一端点桶里出现即可用；官方端点桶 "" 优先）。
  if (memBuckets[""]?.[model]) {
    const fromDefault = toModelPricing(memBuckets[""][model]);
    if (fromDefault) return fromDefault;
  }
  for (const [k, models] of Object.entries(memBuckets)) {
    if (k === key || k === "") continue;
    const fallback = toModelPricing(models[model]);
    if (fallback) return fallback;
  }
  return null;
}

/** GatewayPricingEntry → ModelPricing（按次计费/零价返回 null，退回兜底）。 */
function toModelPricing(entry?: GatewayPricingEntry): ModelPricing | null {
  if (!entry) return null;
  if (entry.quotaType === 1) return null; // 按次计费无 per-token 价，退回兜底
  if (!(entry.input > 0)) return null; // 免费/零价模型不覆盖注册表
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
  const file: GatewayCacheFile = readCacheFile() ?? { schema_version: 2, endpoints: {} };
  const existing = file.endpoints[endpointKey];

  // 版本比对：本端点桶内容未变则不写盘（除非 force）。
  // 例外：桶里还挂着未清的失败态（failed_at/fail_count）时必须落盘一次把它清掉 ——
  // 否则「端点已恢复但价格恰好没变」会让退避状态永久留存，之后每次都被冷却挡住不再采集。
  const hasStaleFailure = !!(existing?.failed_at || existing?.fail_count);
  if (!opts?.force && existing && existing.pricing_version === version && !hasStaleFailure) {
    memBuckets[endpointKey] = models;
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
  file.schema_version = 2;

  try {
    const path = sidPaths.gatewayPricing();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(file, null, 2), "utf8");
  } catch (e) {
    log().warn("GATEWAY-PRICING", "写缓存失败", { error: String(e) });
    // 写盘失败仍刷新内存，本次会话可用。
  }

  memBuckets[endpointKey] = models;
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
  memLoaded = false;
}
