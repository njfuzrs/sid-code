/**
 * 远程预算加载器（M5 PR-5.2）。
 *
 * 独立于 PolicySettings：ALLOWED_REMOTE_KEYS 不含 quota / costLimit（R4）。
 * 端点只读 `SID_CODE_BUDGET_ENDPOINT`。远程 body 里的 `budgetEndpoint` 一律忽略（自举）。
 *
 * fail-open：401 / 5xx / 超时 / 明文拒绝 / 无凭据 → 当没配远程预算。
 * 本地 costLimit 硬停保持不变。
 *
 * ## 双计窗口（必须写进代码，R6）
 *
 * `used_usd` 来自服务端 SUM(cost_usd)。本会话如果已经 upsert 成功过，SUM **已经包含**
 * 本会话当前 `costUSD`。此时再加 `getEffectiveTotalCostUSD()` 会把本会话加两次，
 * 可能提前告警/硬停。
 *
 * 估计公式：
 *   if (lastPushedSessionId === currentSessionId)
 *     estimated = used_usd - lastPushedCostUSD + currentCostUSD
 *   else
 *     estimated = used_usd + currentCostUSD
 * 减出来为负则当 0。乐观估计只用于告警/硬拦，不写回服务端。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { applyDeviceAuth, getUsableCredentialToken } from "../identity/credential.ts";
import { isNonLocalHttp } from "../config/policy.ts";
import { sidPaths } from "../config/paths.ts";
import { getLogger } from "../debug/logger.ts";
import { onUsageLedgerRemotePushed } from "./usage-ledger-remote.ts";
import type { UsageLedgerEntry } from "./usage-ledger.ts";

export const BUDGET_FETCH_TIMEOUT_MS = 5_000;
/** 距上次 GET < 30s 则跳过。失败的 upsert 不配刷新。 */
export const BUDGET_REFRESH_MIN_INTERVAL_MS = 30_000;

export type BudgetEnforcement = "alert" | "block";
export type BudgetPeriod = "session" | "daily" | "weekly" | "monthly";

export interface RemoteBudget {
  source: "remote";
  scope_type: string;
  scope_id: string;
  period: BudgetPeriod;
  period_key: string;
  limit_usd: number;
  used_usd: number;
  enforcement: BudgetEnforcement;
  updated_at?: string;
}

interface BudgetCacheFile {
  etag?: string;
  fetched_at?: string;
  endpoint?: string;
  last_status?: number;
  budget?: RemoteBudget;
}

export type RemoteBudgetCheck =
  | { kind: "none" }
  | {
      kind: "ok";
      estimated: number;
      limit: number;
      enforcement: BudgetEnforcement;
      exceeded: boolean;
      budget: RemoteBudget;
    };

const BOOTSTRAP_KEYS = new Set(["budgetEndpoint", "endpoint", "SID_CODE_BUDGET_ENDPOINT"]);

let warnedNoCredential = false;
let warnedPlaintext = false;
let warnedCorruptCache = false;
let lastGetAt = 0;
let lastPushedSessionId: string | undefined;
let lastPushedCostUSD = 0;
let inFlightLoad: Promise<RemoteBudget | null> | null = null;
let pushHookRegistered = false;
let lastBudget: RemoteBudget | null | undefined;

function budgetEndpoint(): string | undefined {
  const raw = process.env.SID_CODE_BUDGET_ENDPOINT;
  if (!raw || raw.trim() === "") return undefined;
  return raw.trim();
}

function parseEnforcement(raw: unknown): BudgetEnforcement {
  // 不认识就不硬停（fail-open 方向）。
  return raw === "block" ? "block" : "alert";
}

function parsePeriod(raw: unknown): BudgetPeriod {
  if (raw === "session" || raw === "daily" || raw === "weekly" || raw === "monthly") return raw;
  return "monthly";
}

/**
 * 剥自举字段、强制 source=remote、只认 alert|block。
 * 完全不可解析返回 null。
 */
export function sanitizeRemoteBudget(raw: unknown): RemoteBudget | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some((k) => BOOTSTRAP_KEYS.has(k))) {
    getLogger().debug("BUDGET", "忽略自举字段 budgetEndpoint/endpoint/SID_CODE_BUDGET_ENDPOINT");
  }
  const limit = typeof input.limit_usd === "number" ? input.limit_usd : Number(input.limit_usd);
  const used = typeof input.used_usd === "number" ? input.used_usd : Number(input.used_usd);
  if (!Number.isFinite(limit) || !Number.isFinite(used)) return null;
  const scopeType = typeof input.scope_type === "string" ? input.scope_type : "";
  const scopeId = typeof input.scope_id === "string" ? input.scope_id : "";
  const periodKey = typeof input.period_key === "string" ? input.period_key : "";
  return {
    source: "remote",
    scope_type: scopeType,
    scope_id: scopeId,
    period: parsePeriod(input.period),
    period_key: periodKey,
    limit_usd: limit,
    used_usd: used,
    enforcement: parseEnforcement(input.enforcement),
    ...(typeof input.updated_at === "string" ? { updated_at: input.updated_at } : {}),
  };
}

function readBudgetCache(): BudgetCacheFile | null {
  const path = sidPaths.budgetCache();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as BudgetCacheFile;
    if (!parsed || typeof parsed !== "object") return null;
    const lastStatus =
      typeof parsed.last_status === "number" ? parsed.last_status : parsed.budget ? 200 : undefined;
    const budget = parsed.budget ? sanitizeRemoteBudget(parsed.budget) : null;
    if (lastStatus === 200 && !budget) return null;
    if (lastStatus === 204 && budget) {
      return {
        etag: typeof parsed.etag === "string" ? parsed.etag : undefined,
        fetched_at: typeof parsed.fetched_at === "string" ? parsed.fetched_at : undefined,
        endpoint: typeof parsed.endpoint === "string" ? parsed.endpoint : undefined,
        last_status: 204,
      };
    }
    return {
      etag: typeof parsed.etag === "string" ? parsed.etag : undefined,
      fetched_at: typeof parsed.fetched_at === "string" ? parsed.fetched_at : undefined,
      endpoint: typeof parsed.endpoint === "string" ? parsed.endpoint : undefined,
      last_status: lastStatus,
      ...(budget ? { budget } : {}),
    };
  } catch {
    if (!warnedCorruptCache) {
      warnedCorruptCache = true;
      getLogger().warn("BUDGET", `远程预算缓存损坏，已忽略: ${sidPaths.budgetCache()}`);
    }
    return null;
  }
}

function writeBudgetCache(cache: {
  etag?: string;
  endpoint: string;
  fetched_at: string;
  last_status: number;
  budget?: RemoteBudget;
}): void {
  const path = sidPaths.budgetCache();
  const dir = dirname(path);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const body = JSON.stringify(
      {
        ...(cache.etag ? { etag: cache.etag } : {}),
        fetched_at: cache.fetched_at,
        endpoint: cache.endpoint,
        last_status: cache.last_status,
        ...(cache.budget ? { budget: cache.budget } : {}),
      },
      null,
      2,
    );
    writeFileSync(path, body, { mode: 0o600, encoding: "utf-8" });
    try {
      chmodSync(path, 0o600);
    } catch {
      /* umask 兜底 */
    }
  } catch (err: any) {
    getLogger().debug("BUDGET", `写入远程预算缓存失败: ${err?.message ?? err}`);
  }
}

/**
 * 双计窗口估计。纯函数，loop 与单测共用。
 */
export function estimateRemoteBudgetUsed(args: {
  usedUsd: number;
  currentCostUsd: number;
  currentSessionId: string;
  lastPushedSessionId?: string;
  lastPushedCostUsd?: number;
}): number {
  const { usedUsd, currentCostUsd, currentSessionId, lastPushedSessionId, lastPushedCostUsd } =
    args;
  if (lastPushedSessionId === currentSessionId) {
    return Math.max(0, usedUsd - (lastPushedCostUsd ?? 0) + currentCostUsd);
  }
  return usedUsd + currentCostUsd;
}

export function checkRemoteBudget(args: {
  budget: RemoteBudget | null | undefined;
  currentCostUsd: number;
  currentSessionId: string;
  lastPushedSessionId?: string;
  lastPushedCostUsd?: number;
}): RemoteBudgetCheck {
  if (!args.budget) return { kind: "none" };
  const estimated = estimateRemoteBudgetUsed({
    usedUsd: args.budget.used_usd,
    currentCostUsd: args.currentCostUsd,
    currentSessionId: args.currentSessionId,
    lastPushedSessionId: args.lastPushedSessionId,
    lastPushedCostUsd: args.lastPushedCostUsd,
  });
  return {
    kind: "ok",
    estimated,
    limit: args.budget.limit_usd,
    enforcement: args.budget.enforcement,
    exceeded: estimated >= args.budget.limit_usd,
    budget: args.budget,
  };
}

function rememberPushed(entry: UsageLedgerEntry): void {
  lastPushedSessionId = entry.sessionId;
  lastPushedCostUSD = entry.costUSD ?? 0;
}

function ensurePushHook(): void {
  if (pushHookRegistered) return;
  pushHookRegistered = true;
  onUsageLedgerRemotePushed((entry) => {
    rememberPushed(entry);
    void refreshRemoteBudgetAfterPush();
  });
}

async function fetchBudget(
  endpoint: string,
  cache: BudgetCacheFile | null,
): Promise<{ status: number; etag?: string; json?: unknown } | { network: string }> {
  const headers = applyDeviceAuth({ Accept: "application/json" });
  if (cache?.etag) headers["If-None-Match"] = cache.etag;
  try {
    const resp = await fetch(endpoint, {
      headers,
      signal: AbortSignal.timeout(BUDGET_FETCH_TIMEOUT_MS),
    });
    const etag = resp.headers.get("ETag") ?? undefined;
    if (resp.status === 200) {
      let json: unknown;
      try {
        json = await resp.json();
      } catch (err: any) {
        return { network: `JSON 不可解析: ${err?.message ?? err}` };
      }
      return { status: 200, etag, json };
    }
    return { status: resp.status, etag };
  } catch (err: any) {
    return { network: String(err?.message ?? err) };
  }
}

function interpret(
  result: { status: number; etag?: string; json?: unknown } | { network: string },
  cache: BudgetCacheFile | null,
  endpoint: string,
): RemoteBudget | null {
  const log = getLogger();
  if ("network" in result) {
    log.warn("BUDGET", `远程预算 超时/网络 ${result.network}（fail-open，当没配）`);
    lastBudget = null;
    return null;
  }
  if (result.status === 304) {
    // 304 时仍用缓存的 used_usd，靠乐观估计补本会话增量。
    const budget = cache?.budget ?? null;
    if (budget) {
      writeBudgetCache({
        etag: result.etag ?? cache?.etag,
        endpoint,
        fetched_at: new Date().toISOString(),
        last_status: 200,
        budget,
      });
    }
    lastBudget = budget;
    return budget;
  }
  if (result.status === 204) {
    writeBudgetCache({
      etag: result.etag,
      endpoint,
      fetched_at: new Date().toISOString(),
      last_status: 204,
    });
    lastBudget = null;
    return null;
  }
  if (result.status === 401 || result.status >= 500) {
    log.warn("BUDGET", `远程预算 HTTP ${result.status}（fail-open，当没配）`);
    lastBudget = null;
    return null;
  }
  if (result.status !== 200) {
    log.warn("BUDGET", `远程预算 HTTP ${result.status}（fail-open，当没配）`);
    lastBudget = null;
    return null;
  }
  const budget = sanitizeRemoteBudget(result.json);
  if (!budget) {
    log.warn("BUDGET", "远程预算 200 但 body 不可解析（fail-open）");
    lastBudget = null;
    return null;
  }
  writeBudgetCache({
    etag: result.etag,
    endpoint,
    fetched_at: new Date().toISOString(),
    last_status: 200,
    budget,
  });
  lastBudget = budget;
  return budget;
}

/**
 * 启动拉一次。未配 endpoint / 明文 / 无凭据 → null，零硬停。
 */
export async function loadRemoteBudget(): Promise<RemoteBudget | null> {
  ensurePushHook();
  const log = getLogger();
  const endpoint = budgetEndpoint();
  if (!endpoint) {
    lastBudget = null;
    return null;
  }
  if (isNonLocalHttp(endpoint)) {
    if (!warnedPlaintext) {
      warnedPlaintext = true;
      log.warn(
        "BUDGET",
        `SID_CODE_BUDGET_ENDPOINT 拒绝明文非本地地址（只允许 https:// 或 http://127.0.0.1|localhost）: ${endpoint}`,
      );
    }
    lastBudget = null;
    return null;
  }
  if (!getUsableCredentialToken()) {
    if (!warnedNoCredential) {
      warnedNoCredential = true;
      log.warn("BUDGET", "无设备凭据，跳过远程预算（fail-open）");
    }
    lastBudget = null;
    return null;
  }

  if (inFlightLoad) return inFlightLoad;
  inFlightLoad = (async () => {
    let cache = readBudgetCache();
    if (cache && cache.endpoint !== endpoint) cache = null;
    const result = await fetchBudget(endpoint, cache);
    lastGetAt = Date.now();
    return interpret(result, cache, endpoint);
  })().finally(() => {
    inFlightLoad = null;
  });
  return inFlightLoad;
}

async function refreshRemoteBudgetAfterPush(): Promise<void> {
  if (!budgetEndpoint()) return;
  if (Date.now() - lastGetAt < BUDGET_REFRESH_MIN_INTERVAL_MS) return;
  await loadRemoteBudget().catch(() => {});
}

/**
 * 启动时调一次。进程内默认只跑一次 load。
 */
export async function loadEnterpriseBudgetOnce(): Promise<RemoteBudget | null> {
  ensurePushHook();
  if (lastBudget !== undefined && !inFlightLoad) return lastBudget;
  return loadRemoteBudget();
}

export function getLastRemoteBudget(): RemoteBudget | null {
  return lastBudget ?? null;
}

export function getLastPushedUsage(): { sessionId?: string; costUSD: number } {
  return { sessionId: lastPushedSessionId, costUSD: lastPushedCostUSD };
}

/**
 * loop 用：结合当前会话成本做乐观估计。
 */
export function checkLoadedRemoteBudget(
  currentSessionId: string,
  currentCostUsd: number,
): RemoteBudgetCheck {
  return checkRemoteBudget({
    budget: lastBudget,
    currentCostUsd,
    currentSessionId,
    lastPushedSessionId,
    lastPushedCostUsd: lastPushedCostUSD,
  });
}

/**
 * 金额展示。分位以上保持两位；不足半分的非零金额改四位。
 *
 * `toFixed(2)` 对 `$0.001` 这种验收用的限额会写成 `$0.00`（M5 验收 F3 看到的
 * `$0.0055 / $0.00`）。半分是两位小数的四舍五入边界：`0.005.toFixed(2)` 是
 * `0.01`，再小就掉成 `0.00`。
 *
 * 不在这里修 float32：`0.01` 存成 float4 再读回是 `0.009999999776482582`，
 * `toFixed(2)` 会把它四舍五入回 `0.01`，不是 `$0.00` 的成因。列类型是服务端
 * 的事，客户端改展示解决不了它，也不该假装解决了。
 */
export function formatBudgetUsd(amount: number, floorDigits: number): string {
  if (!Number.isFinite(amount)) return (0).toFixed(floorDigits);
  const abs = Math.abs(amount);
  if (abs !== 0 && abs < 0.005) return amount.toFixed(4);
  return amount.toFixed(floorDigits);
}

export function formatRemoteBudgetWarning(
  check: Extract<RemoteBudgetCheck, { kind: "ok" }>,
): string {
  const scope = check.budget.scope_type
    ? `${check.budget.scope_type}${check.budget.scope_id ? `:${check.budget.scope_id}` : ""}`
    : "org";
  const period = check.budget.period_key || check.budget.period;
  const verb =
    check.enforcement === "block" ? "已超限，自动停止" : "已超限（告警放行，不结束会话）";
  return `远程预算 ${scope} ${period} ${verb}（$${formatBudgetUsd(check.estimated, 4)} / $${formatBudgetUsd(check.limit, 2)}，含辅助调用）`;
}

/** 仅测试 */
export function __resetRemoteBudgetForTest(): void {
  warnedNoCredential = false;
  warnedPlaintext = false;
  warnedCorruptCache = false;
  lastGetAt = 0;
  lastPushedSessionId = undefined;
  lastPushedCostUSD = 0;
  inFlightLoad = null;
  lastBudget = undefined;
  // pushHookRegistered 故意不复位：onUsageLedgerRemotePushed 是累加 Set，
  // 重复注册会双刷新。测试通过 __resetUsageLedgerRemoteForTest 清监听后再由
  // loadRemoteBudget 重新注册。
  pushHookRegistered = false;
}

/** 测试：直接灌一份已加载预算（跳过 HTTP）。 */
export function __setLastRemoteBudgetForTest(budget: RemoteBudget | null): void {
  lastBudget = budget;
}

/** 测试：模拟一次成功 upsert。 */
export function __setLastPushedUsageForTest(sessionId: string, costUSD: number): void {
  lastPushedSessionId = sessionId;
  lastPushedCostUSD = costUSD;
}
