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

/** 缓存文件结构（~/.sid-code/gateway-pricing.json）。 */
interface GatewayCacheFile {
  source_url: string;
  fetched_at: number;
  /** 聚合哈希，用于版本比对（内容不变则不写盘） */
  pricing_version: string;
  models: Record<string, GatewayPricingEntry>;
}

/** new-api 基准单位换算系数：model_ratio × 2 = input $/1M。 */
const RATIO_TO_USD_PER_M = 2;

/** 默认采集 TTL：24h。缓存超此时长则后台静默刷新。 */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** 默认采集超时。 */
const DEFAULT_TIMEOUT_MS = 15_000;

/** 内存态：模型名 → 定价条目。启动时由 loadGatewayCache 载入。 */
let memCache: Record<string, GatewayPricingEntry> = {};
let memLoaded = false;

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

/** 读缓存文件到内存（启动时调用一次；幂等）。 */
export function loadGatewayCache(): void {
  if (memLoaded) return;
  memLoaded = true;
  try {
    const path = sidPaths.gatewayPricing();
    if (!existsSync(path)) return;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as GatewayCacheFile;
    if (parsed && typeof parsed.models === "object" && parsed.models) {
      memCache = parsed.models;
      log.debug("GATEWAY-PRICING", `载入网关定价缓存 ${Object.keys(memCache).length} 条`, {
        version: parsed.pricing_version,
        fetchedAt: parsed.fetched_at,
      });
    }
  } catch (e) {
    log.warn("GATEWAY-PRICING", "载入网关定价缓存失败，回退注册表", { error: String(e) });
  }
}

/**
 * 计费热路径查询 — 只读内存缓存，**绝不触网**。
 *
 * 按模型名查（网关渠道名已含前缀天然区分端点）。按次计费（quotaType=1）返回 null，
 * 由调用方退回注册表兜底。baseURL 目前作为保留参数（网关返回不带 host 维度，同名即同价）。
 */
export function lookupGatewayPricing(model: string, _baseURL?: string): ModelPricing | null {
  if (!memLoaded) loadGatewayCache();
  const entry = memCache[model];
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

/** 读取当前内存缓存的元信息（供 fetched_at / TTL 判断与展示）。 */
export function getGatewayCacheMeta(): { fetchedAt: number; version: string; count: number } | null {
  try {
    const path = sidPaths.gatewayPricing();
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as GatewayCacheFile;
    return {
      fetchedAt: parsed.fetched_at ?? 0,
      version: parsed.pricing_version ?? "",
      count: Object.keys(parsed.models ?? {}).length,
    };
  } catch {
    return null;
  }
}

/** 供展示层遍历全部采集条目（含按次计费，用于 /model pricing --all）。 */
export function getAllGatewayEntries(): Record<string, GatewayPricingEntry> {
  if (!memLoaded) loadGatewayCache();
  return { ...memCache };
}

/**
 * 拉取 + 解析 + 校验 + 写缓存 + 刷新内存。
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

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
      return { updated: false, count: 0, version: "", reason: `HTTP ${resp.status}` };
    }
    raw = (await resp.json()) as { data?: RawPricingEntry[] };
  } catch (e) {
    log.warn("GATEWAY-PRICING", "采集失败，保留旧缓存", { url, error: String(e) });
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
    return { updated: false, count: 0, version: "", reason: "解析后无有效条目" };
  }

  const version = computeVersion(models);

  // 版本比对：内容未变则不写盘（除非 force）。
  const existingMeta = getGatewayCacheMeta();
  if (!opts?.force && existingMeta && existingMeta.version === version) {
    // 内容未变，但刷新内存（确保内存与磁盘一致）。
    memCache = models;
    memLoaded = true;
    return { updated: false, count, version, reason: "版本未变，跳过写盘" };
  }

  const cacheFile: GatewayCacheFile = {
    source_url: url,
    fetched_at: Date.now(),
    pricing_version: version,
    models,
  };
  try {
    const path = sidPaths.gatewayPricing();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cacheFile, null, 2), "utf8");
  } catch (e) {
    log.warn("GATEWAY-PRICING", "写缓存失败", { error: String(e) });
    // 写盘失败仍刷新内存，本次会话可用。
  }

  memCache = models;
  memLoaded = true;
  log.info("GATEWAY-PRICING", `采集完成 ${count} 条${dropped > 0 ? `（丢弃 ${dropped} 非法条目）` : ""}`, { version });
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
  const meta = getGatewayCacheMeta();
  const stale = !meta || Date.now() - meta.fetchedAt > ttlMs;
  if (!stale) return;
  // 后台静默刷新，失败不阻塞、不抛。
  void syncGatewayPricing({ baseURL }).catch(() => {});
}

/** 仅测试用：重置内存态。 */
export function __resetGatewayPricingForTest(): void {
  memCache = {};
  memLoaded = false;
}
