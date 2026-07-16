/**
 * 网关定价自动采集 — 从 new-api 类网关（如公司中转站 gateway.example.com）的
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

const log = getLogger();

/** new-api /api/pricing 单条原始返回（仅声明我们消费的字段）。 */
interface RawPricingEntry {
  model_name?: string;
  quota_type?: number;         // 0=按 token，1=按次
  model_ratio?: number;
  model_price?: number;        // quota_type=1 时的按次单价（USD/次）
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
export function convertRawEntry(raw: RawPricingEntry): { name: string; entry: GatewayPricingEntry } | null {
  const name = raw.model_name;
  if (!name || typeof name !== "string") return null;

  const quotaType = raw.quota_type === 1 ? 1 : 0;

  if (quotaType === 1) {
    // 按次计费：只保留 perCallUSD，token 价置 0。
    const perCall = raw.model_price;
    if (!isFiniteNonNeg(perCall)) return null;
    return {
      name,
      entry: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, quotaType: 1, perCallUSD: perCall },
    };
  }

  // 按 token 计费。
  const mr = raw.model_ratio;
  if (!isFiniteNonNeg(mr)) return null;
  const input = mr * RATIO_TO_USD_PER_M;

  const compRatio = isFiniteNonNeg(raw.completion_ratio) ? raw.completion_ratio : 0;
  const cacheRatio = isFiniteNonNeg(raw.cache_ratio) ? raw.cache_ratio : undefined;
  const createCacheRatio = isFiniteNonNeg(raw.create_cache_ratio) ? raw.create_cache_ratio : undefined;

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
    log.debug("GATEWAY-PRICING", `载入网关定价缓存 ${total} 条 / ${Object.keys(memBuckets).length} 端点`);
  } catch (e) {
    log.warn("GATEWAY-PRICING", "载入网关定价缓存失败，回退注册表", { error: String(e) });
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
  if (!(entry.input > 0)) return null;    // 免费/零价模型不覆盖注册表
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
  const url = opts?.url
    ?? (opts?.baseURL ? derivePricingURL(opts.baseURL) : undefined);
  if (!url) {
    return { updated: false, count: 0, version: "", reason: "未提供采集 URL 或 baseURL" };
  }

  // 此端点桶的归一化 key（用户传 baseURL 时按端点分桶；只传 url 时归到官方桶 ""）。
  const endpointKey = normalizeBaseURL(opts?.baseURL);

  const timeoutMs = opts?.timeoutMs ?? resolveSideCallTimeouts().gatewayPricingMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let raw: { data?: RawPricingEntry[] };
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json, text/plain, */*", "new-api-user": "-1" },
      signal: controller.signal,
    });
    if (!resp.ok) {
      emit({ endpoint: endpointKey, url, outcome: "failed", count: 0, version: "", dropped: 0, reason: `HTTP ${resp.status}` });
      return { updated: false, count: 0, version: "", reason: `HTTP ${resp.status}` };
    }
    raw = (await resp.json()) as { data?: RawPricingEntry[] };
  } catch (e) {
    log.warn("GATEWAY-PRICING", "采集失败，保留旧缓存", { url, error: String(e) });
    emit({ endpoint: endpointKey, url, outcome: "failed", count: 0, version: "", dropped: 0, reason: `采集失败: ${String(e)}` });
    return { updated: false, count: 0, version: "", reason: `采集失败: ${String(e)}` };
  } finally {
    clearTimeout(timer);
  }

  const list = Array.isArray(raw?.data) ? raw.data : [];
  const models: Record<string, GatewayPricingEntry> = {};
  let dropped = 0;
  for (const item of list) {
    const converted = convertRawEntry(item);
    if (!converted) { dropped++; continue; }
    models[converted.name] = converted.entry;
  }

  const count = Object.keys(models).length;
  if (count === 0) {
    emit({ endpoint: endpointKey, url, outcome: "failed", count: 0, version: "", dropped, reason: "解析后无有效条目" });
    return { updated: false, count: 0, version: "", reason: "解析后无有效条目" };
  }

  const version = computeVersion(models);

  // 读现有缓存文件（含旧版迁移），只更新本端点桶，其余端点桶原样保留（修复互相覆盖）。
  const file: GatewayCacheFile = readCacheFile() ?? { schema_version: 2, endpoints: {} };
  const existing = file.endpoints[endpointKey];

  // 版本比对：本端点桶内容未变则不写盘（除非 force）。
  if (!opts?.force && existing && existing.pricing_version === version) {
    memBuckets[endpointKey] = models;
    memLoaded = true;
    emit({ endpoint: endpointKey, url, outcome: "unchanged", count, version, dropped, reason: "版本未变，跳过写盘" });
    return { updated: false, count, version, reason: "版本未变，跳过写盘" };
  }

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
    log.warn("GATEWAY-PRICING", "写缓存失败", { error: String(e) });
    // 写盘失败仍刷新内存，本次会话可用。
  }

  memBuckets[endpointKey] = models;
  memLoaded = true;
  log.info("GATEWAY-PRICING", `采集完成 ${count} 条${dropped > 0 ? `（丢弃 ${dropped} 非法条目）` : ""}`, { version, endpoint: endpointKey });
  emit({ endpoint: endpointKey, url, outcome: "updated", count, version, dropped, reason: dropped > 0 ? `成功（丢弃 ${dropped} 非法）` : "成功" });
  return { updated: true, count, version, reason: dropped > 0 ? `成功（丢弃 ${dropped} 非法）` : "成功" };
}

/**
 * 启动惰性刷新：先载入缓存（快），若超 TTL 则后台 fire-and-forget 刷新，不阻塞启动。
 *
 * @param baseURL 当前主模型端点（从中推 /api/pricing）
 */
export function maybeRefreshGatewayPricing(baseURL?: string, ttlMs = DEFAULT_TTL_MS): void {
  loadGatewayCache();
  if (!baseURL) return;
  // 按端点桶判 TTL：该端点没采过或超 TTL 才刷新（不同端点各自独立 TTL）。
  const meta = getGatewayCacheMeta(baseURL);
  const stale = !meta || Date.now() - meta.fetchedAt > ttlMs;
  if (!stale) return;
  // 后台静默刷新，失败不阻塞、不抛。
  void syncGatewayPricing({ baseURL }).catch(() => {});
}

/** 仅测试用：重置内存态。 */
export function __resetGatewayPricingForTest(): void {
  memBuckets = {};
  memLoaded = false;
}
