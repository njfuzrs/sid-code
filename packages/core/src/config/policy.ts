/**
 * 策略层抽象
 * 支持本地文件策略（managed-settings.json）和远程策略（SID_CODE_POLICY_ENDPOINT）
 * first-source-wins：只取最高优先级的来源，不合并
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname } from "path";
import { getLogger } from "../debug/logger.ts";
import { applyDeviceAuth, getUsableCredentialToken } from "../identity/credential.ts";
import { setModePolicy } from "../permission/mode-policy.ts";
import { sidPaths } from "./paths.ts";
import { setPluginOnlyPolicy, type CustomizationSurface } from "./plugin-only-policy.ts";
import { setPolicyLimits } from "./policy-limits.ts";
import { setRemotePolicyPermissions } from "./remote-policy-state.ts";
import { logPolicyEnforced, type PolicyEnforcedOutcome } from "../analytics/events.ts";

/** 策略来源（优先级从高到低，first-source-wins） */
export type PolicySource = "remote" | "mdm" | "managed_file";

/** 策略设置 */
export interface PolicySettings {
  source: PolicySource;
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
  };
  /**
   * 功能级开关。
   *
   * `reason` 是管理员可填的禁用理由，会由 `policy-limits.ts` 的
   * `getPolicyDenialReason()` 原样展示给用户（"为什么这个功能没了"）。
   *
   * 补这个字段是**类型对齐，不是修 bug**：`policy-limits.ts` 侧一直声明了
   * `reason?: string`，而这边漏了。运行时的值本来就能流通
   *（`PolicyManager.load()` 走 `JSON.parse` + 展开，不做 schema 剥离），
   * 所以补之前管理员写的 reason 也能生效 —— 只是这里的类型在说谎，
   * 任何按它写代码的人都会以为没有这个字段。
   */
  policyLimits?: Record<string, { allowed: boolean; reason?: string }>;
  /** 是否只允许企业策略中的规则 */
  allowManagedPermissionRulesOnly?: boolean;
  /** G13：禁用所有 Hook（企业管控最强档，任何来源的 hook 都不执行） */
  disableAllHooks?: boolean;
  /** G13：只允许企业管理的 Hook（Runtime/Project 来源），屏蔽 User/Plugin/Global 来源的 hook */
  allowManagedHooksOnly?: boolean;
  /** 禁用的权限模式（通用：禁用任意模式，接进 cyclePermissionMode 与 CLI 校验） */
  disabledModes?: string[];
  /**
   * 禁用 bypass（always-allow / dangerously-skip-permissions）模式（P2-2，对齐 CC
   * utils/settings/types.ts:67 disableBypassPermissionsMode）。
   * - "disable"：强制禁用 bypass，即使 CLI 传了 --dangerously-skip-permissions 也报错退出/降级；
   * - "allow"（默认/缺省）：不限制。
   */
  disableBypassPermissionsMode?: "disable" | "allow";
  /**
   * 锁定定制化来源为「仅管理员可信来源」（对齐 CC strictPluginOnlyCustomization）。
   * true=锁全部面；数组=只锁列出的面（commands/skills/agents/hooks/mcp-servers）。
   * 锁定后用户级（~/.sid-code/*）与项目级（.sid-code/*）自带内容不再加载，
   * managed / plugin / builtin 来源不受影响。详见 config/plugin-only-policy.ts。
   */
  strictPluginOnlyCustomization?:
    | boolean
    | import("./plugin-only-policy.ts").CustomizationSurface[];
}

/** 策略加载器接口（可扩展） */
export interface PolicyLoader {
  load(): Promise<PolicySettings | null>;
  /** 是否支持后台轮询 */
  supportsPolling: boolean;
  /** 轮询间隔（毫秒） */
  pollingInterval?: number;
}

/**
 * M4：PolicyManager.load 的信封。settings 形状不变（测试 / loader 链不改），
 * outcome 从 interpretRemoteResponse / ManagedFileLoader 的真实路径来，
 * 不要在 applyLoadedPolicy 里从 policy == null 猜（那个函数看不到 200/204/304）。
 */
export interface PolicyLoadMeta {
  source: PolicySource | "none";
  outcome: PolicyEnforcedOutcome;
  durationMs: number;
}

export interface PolicyLoadResult {
  settings: PolicySettings | null;
  meta: PolicyLoadMeta;
}

let lastPolicyLoadMeta: PolicyLoadMeta | null = null;

function rememberLoadMeta(meta: PolicyLoadMeta): void {
  lastPolicyLoadMeta = meta;
}

/** 最近一次 PolicyManager / loader 链记下的信封。测试与 applyLoadedPolicy 缺省时用。 */
export function getLastPolicyLoad(): PolicyLoadMeta | null {
  return lastPolicyLoadMeta;
}

/** 本地文件策略加载器 */
export class ManagedFileLoader implements PolicyLoader {
  supportsPolling = false;

  async load(): Promise<PolicySettings | null> {
    const log = getLogger();
    const filePath = sidPaths.managedSettings();

    if (!existsSync(filePath)) return null;

    // 安全检查：文件权限应为 600（只有所有者可读写）
    try {
      const stats = statSync(filePath);
      const mode = stats.mode & 0o777;
      if (mode !== 0o600) {
        log.warn("POLICY", `managed-settings.json 权限不安全 (${mode.toString(8)})，建议设为 600`);
      }
    } catch {
      // 权限检查失败不阻塞加载
    }

    try {
      const content = await Bun.file(filePath).text();
      const parsed = JSON.parse(content);
      log.info("POLICY", `加载本地策略: ${filePath}`);
      rememberLoadMeta({ source: "managed_file", outcome: "applied", durationMs: 0 });
      return { source: "managed_file", ...parsed };
    } catch (err: any) {
      log.warn("POLICY", `读取策略文件失败: ${err.message}`);
      rememberLoadMeta({ source: "managed_file", outcome: "error", durationMs: 0 });
      return null;
    }
  }
}

/**
 * 远程策略加载器（M3）。
 *
 * 权威 vs 非权威（契约 §5 / §7，禁止再用「fail-open」一个词覆盖）：
 * - 权威：200 / 204 / 304。以本次响应为准。204 = 无远程策略：写负缓存（无 settings），
 *   进程内 `remote-policy-state.applied=false`（由 applyLoadedPolicy 同步）。
 * - 非权威：超时 / 网络错 / 5xx / JSON 坏了 / 401。进程不崩。缓存**可以**用，但必须同时
 *   满足：① endpoint 一致；② 上次权威是 200（有 settings）；③ `fetched_at` 未过
 *   `POLICY_CACHE_STALE_MS`。缺一条就当无远程策略，不得续命已撤销的 deny。
 *
 * 其它：
 * - 未设 `SID_CODE_POLICY_ENDPOINT` → 立即 null，零请求（不是错误）
 * - `http://` 且 host 不是 localhost/127.0.0.1 → 拒绝请求并 warn，当 null
 * - 200 + 空对象 `{source:"remote"}` 才是「远程明确下发了什么都不禁」（会盖掉本地）
 *
 * `supportsPolling` 保持 true，但 PolicyManager 本里程碑不轮询——生效延迟 = 下次重启。
 */
export class RemotePolicyLoader implements PolicyLoader {
  supportsPolling = true;
  pollingInterval = 60 * 60 * 1000; // 1 小时；本里程碑没有任何调用方 setInterval

  async load(): Promise<PolicySettings | null> {
    const log = getLogger();
    const endpoint = process.env.SID_CODE_POLICY_ENDPOINT?.trim();
    if (!endpoint) return null;

    if (isNonLocalHttp(endpoint)) {
      log.warn(
        "POLICY",
        `SID_CODE_POLICY_ENDPOINT 拒绝明文非本地地址（只允许 https:// 或 http://127.0.0.1|localhost）: ${endpoint}`,
      );
      rememberLoadMeta({ source: "none", outcome: "error", durationMs: 0 });
      return null;
    }

    let cache = readPolicyCache();
    if (cache && cache.endpoint !== endpoint) cache = null;

    const token = getUsableCredentialToken();
    if (!token) {
      if (!warnedNoCredential) {
        warnedNoCredential = true;
        log.warn("POLICY", "无设备凭据，跳过远程策略（有未过期 200 缓存则用缓存）");
      }
      const cached = usableCachedSettings(cache, "no_credential");
      rememberLoadMeta({
        source: cached ? "remote" : "none",
        outcome: cached ? "cache_fallback" : "error",
        durationMs: 0,
      });
      return cached;
    }

    const started = Date.now();
    const result = await fetchRemotePolicyWithRetry(endpoint, cache);
    const elapsedMs = Date.now() - started;
    return interpretRemoteResponse(result, cache, endpoint, elapsedMs);
  }
}

/**
 * 单次 fetch 超时。本机生产 HTTPS 握手实测可 >5s（不带 -4 时 17–25s），
 * 5s 会把权威 204 误判成超时、然后用旧 deny 续命。15s 活过一次慢握手。
 * 首次失败再试一次（合计预算 ≈ 30s），第二次成功必须按权威响应处理。
 */
export const POLICY_FETCH_TIMEOUT_MS = 15_000;

/** 非权威回退 200 缓存的最长寿命。过了就当无远程策略，停用不会永生。 */
export const POLICY_CACHE_STALE_MS = 10 * 60 * 1000;

/** 启动路径最多打几次网（含首次）。 */
const POLICY_FETCH_ATTEMPTS = 2;

/** policyLimits 里本模块真正把关的 4 个 key；多的丢掉并 debug，不要整份丢。 */
const GATED_POLICY_LIMIT_KEYS = new Set(["mcp", "sub_agent", "custom_commands", "extensions"]);

const CUSTOMIZATION_SURFACES = new Set<string>([
  "commands",
  "skills",
  "agents",
  "hooks",
  "mcp-servers",
]);

/** 远程 JSON 允许保留的顶层键（与服务端 extra=forbid 闭集对齐）。 */
const ALLOWED_REMOTE_KEYS = new Set([
  "source",
  "permissions",
  "policyLimits",
  "allowManagedPermissionRulesOnly",
  "disableAllHooks",
  "allowManagedHooksOnly",
  "disabledModes",
  "disableBypassPermissionsMode",
  "strictPluginOnlyCustomization",
]);

const BOOTSTRAP_KEYS = new Set(["policyEndpoint", "endpoint", "SID_CODE_POLICY_ENDPOINT"]);

interface PolicyCacheFile {
  etag?: string;
  fetched_at?: string;
  endpoint?: string;
  /** 上次权威 HTTP 状态。204 负缓存没有 settings。 */
  last_status?: number;
  settings?: PolicySettings;
}

type RemoteFetchOutcome =
  | { kind: "http"; status: number; etag?: string; json?: unknown }
  | { kind: "network"; message: string };

let warnedNoCredential = false;
let warnedCorruptCache = false;

/** 进程内默认链只 fetch 一次：cli 与 app 共用。自定义 loaders 的 PolicyManager 不走这里。 */
let inFlightDefaultLoad: Promise<PolicySettings | null> | null = null;
let defaultLoadResult: PolicySettings | null | undefined;

/**
 * 明文 HTTP 且 host 不是 loopback → 拒绝。
 * https 一律放行（证书校验交给运行时）。非法 URL 也当拒绝。
 */
export function isNonLocalHttp(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return true;
  }
  const proto = url.protocol.toLowerCase();
  if (proto === "https:") return false;
  if (proto !== "http:") return true;
  const host = url.hostname.toLowerCase();
  return host !== "127.0.0.1" && host !== "localhost";
}

/**
 * 剥未知键、强制 source="remote"、丢掉自举字段。
 * 完全不可解析（非对象）返回 null；已知字段仍用，不要整份丢。
 */
export function sanitizeRemotePolicy(raw: unknown): PolicySettings | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const log = getLogger();

  if (Object.keys(input).some((k) => BOOTSTRAP_KEYS.has(k))) {
    log.debug("POLICY", "忽略自举字段 policyEndpoint/endpoint/SID_CODE_POLICY_ENDPOINT");
  }

  const out: PolicySettings = { source: "remote" };

  if (
    input.permissions &&
    typeof input.permissions === "object" &&
    !Array.isArray(input.permissions)
  ) {
    const p = input.permissions as Record<string, unknown>;
    const permissions: NonNullable<PolicySettings["permissions"]> = {};
    const allow = asStringArray(p.allow);
    const deny = asStringArray(p.deny);
    const ask = asStringArray(p.ask);
    if (allow) permissions.allow = allow;
    if (deny) permissions.deny = deny;
    if (ask) permissions.ask = ask;
    if (Object.keys(permissions).length > 0) out.permissions = permissions;
  }

  if (
    input.policyLimits &&
    typeof input.policyLimits === "object" &&
    !Array.isArray(input.policyLimits)
  ) {
    const limits = input.policyLimits as Record<string, unknown>;
    const kept: NonNullable<PolicySettings["policyLimits"]> = {};
    const dropped: string[] = [];
    for (const [key, value] of Object.entries(limits)) {
      if (!GATED_POLICY_LIMIT_KEYS.has(key)) {
        dropped.push(key);
        continue;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const rec = value as Record<string, unknown>;
      if (typeof rec.allowed !== "boolean") continue;
      kept[key] = {
        allowed: rec.allowed,
        ...(typeof rec.reason === "string" ? { reason: rec.reason } : {}),
      };
    }
    if (dropped.length > 0) {
      log.debug("POLICY", `忽略无 gate 的 policyLimits key: ${dropped.join(", ")}`);
    }
    if (Object.keys(kept).length > 0) out.policyLimits = kept;
  }

  if (typeof input.allowManagedPermissionRulesOnly === "boolean") {
    out.allowManagedPermissionRulesOnly = input.allowManagedPermissionRulesOnly;
  }
  if (typeof input.disableAllHooks === "boolean") {
    out.disableAllHooks = input.disableAllHooks;
  }
  if (typeof input.allowManagedHooksOnly === "boolean") {
    out.allowManagedHooksOnly = input.allowManagedHooksOnly;
  }
  const modes = asStringArray(input.disabledModes);
  if (modes) out.disabledModes = modes;
  if (
    input.disableBypassPermissionsMode === "disable" ||
    input.disableBypassPermissionsMode === "allow"
  ) {
    out.disableBypassPermissionsMode = input.disableBypassPermissionsMode;
  }
  const pluginOnly = sanitizePluginOnly(input.strictPluginOnlyCustomization);
  if (pluginOnly !== undefined) out.strictPluginOnlyCustomization = pluginOnly;

  // 未知顶层键（含自举字段、管理台字段）直接剥掉，不整份丢。
  for (const key of Object.keys(input)) {
    if (!ALLOWED_REMOTE_KEYS.has(key) && !BOOTSTRAP_KEYS.has(key)) {
      log.debug("POLICY", `忽略远程策略未知字段: ${key}`);
    }
  }

  return out;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string");
  return out;
}

function sanitizePluginOnly(value: unknown): boolean | CustomizationSurface[] | undefined {
  if (typeof value === "boolean") return value;
  if (!Array.isArray(value)) return undefined;
  const known = value.filter(
    (s): s is CustomizationSurface => typeof s === "string" && CUSTOMIZATION_SURFACES.has(s),
  );
  return known;
}

function readPolicyCache(): PolicyCacheFile | null {
  const path = sidPaths.policyCache();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as PolicyCacheFile;
    if (!parsed || typeof parsed !== "object") return null;
    const lastStatus =
      typeof parsed.last_status === "number"
        ? parsed.last_status
        : parsed.settings
          ? 200
          : undefined;
    const settings = parsed.settings ? sanitizeRemotePolicy(parsed.settings) : null;
    // 204 负缓存合法：无 settings。损坏 = 声称 200 却没有 settings，或 JSON 形状不对。
    if (lastStatus === 200 && !settings) return null;
    if (lastStatus === 204 && settings) {
      // 半写/崩溃留下的矛盾文件：权威是空，丢掉 settings。
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
      ...(settings ? { settings } : {}),
    };
  } catch {
    if (!warnedCorruptCache) {
      warnedCorruptCache = true;
      getLogger().warn("POLICY", `远程策略缓存损坏，已忽略: ${path}`);
    }
    return null;
  }
}

function writePolicyCache(cache: {
  etag?: string;
  endpoint: string;
  fetched_at: string;
  last_status: number;
  settings?: PolicySettings;
}): void {
  const path = sidPaths.policyCache();
  const dir = dirname(path);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const body = JSON.stringify(
      {
        ...(cache.etag ? { etag: cache.etag } : {}),
        fetched_at: cache.fetched_at,
        endpoint: cache.endpoint,
        last_status: cache.last_status,
        ...(cache.settings ? { settings: cache.settings } : {}),
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
    getLogger().debug("POLICY", `写入远程策略缓存失败: ${err?.message ?? err}`);
  }
}

function writeNegativeCache(endpoint: string, etag?: string): void {
  writePolicyCache({
    etag,
    endpoint,
    fetched_at: new Date().toISOString(),
    last_status: 204,
  });
}

function isCacheFresh(cache: PolicyCacheFile | null): boolean {
  if (!cache?.fetched_at) return false;
  const t = Date.parse(cache.fetched_at);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t <= POLICY_CACHE_STALE_MS;
}

/**
 * 非权威路径才能用的缓存：必须是未过期的 200 settings。
 * 204 负缓存 / 过期 / 无 settings → null（不得复活 deny）。
 */
function usableCachedSettings(
  cache: PolicyCacheFile | null,
  reason: string,
): PolicySettings | null {
  const log = getLogger();
  if (!cache?.settings || cache.last_status === 204) {
    log.warn("POLICY", `远程策略 ${reason} 无可用 200 缓存 → 无远程策略`);
    return null;
  }
  if (!isCacheFresh(cache)) {
    log.warn("POLICY", `远程策略 ${reason} 缓存过期 fetched_at=${cache.fetched_at} 已停用约束`);
    return null;
  }
  log.warn(
    "POLICY",
    `远程策略 ${reason} 回退缓存 fetched_at=${cache.fetched_at} last_status=${cache.last_status ?? 200}`,
  );
  return cache.settings;
}

async function fetchOnce(
  endpoint: string,
  cache: PolicyCacheFile | null,
): Promise<RemoteFetchOutcome> {
  const headers = applyDeviceAuth({ Accept: "application/json" });
  if (cache?.etag) headers["If-None-Match"] = cache.etag;
  try {
    const resp = await fetch(endpoint, {
      headers,
      signal: AbortSignal.timeout(POLICY_FETCH_TIMEOUT_MS),
    });
    const etag = resp.headers.get("ETag") ?? undefined;
    if (resp.status === 200) {
      let json: unknown;
      try {
        json = await resp.json();
      } catch (err: any) {
        return { kind: "network", message: `JSON 不可解析: ${err?.message ?? err}` };
      }
      return { kind: "http", status: 200, etag, json };
    }
    return { kind: "http", status: resp.status, etag };
  } catch (err: any) {
    return { kind: "network", message: String(err?.message ?? err) };
  }
}

async function fetchRemotePolicyWithRetry(
  endpoint: string,
  cache: PolicyCacheFile | null,
): Promise<RemoteFetchOutcome> {
  let last: RemoteFetchOutcome = { kind: "network", message: "未请求" };
  for (let i = 0; i < POLICY_FETCH_ATTEMPTS; i++) {
    last = await fetchOnce(endpoint, cache);
    if (
      last.kind === "http" &&
      (last.status === 200 || last.status === 204 || last.status === 304)
    ) {
      return last;
    }
    // 401 不重试：凭据不会自己变好。
    if (last.kind === "http" && last.status === 401) return last;
  }
  return last;
}

function interpretRemoteResponse(
  result: RemoteFetchOutcome,
  cache: PolicyCacheFile | null,
  endpoint: string,
  elapsedMs: number,
): PolicySettings | null {
  const log = getLogger();

  if (result.kind === "network") {
    log.warn("POLICY", `远程策略 超时 elapsed_ms=${elapsedMs} ${result.message}`);
    const cached = usableCachedSettings(cache, `超时 elapsed_ms=${elapsedMs}`);
    rememberLoadMeta({
      source: cached ? "remote" : "none",
      outcome: cached ? "cache_fallback" : "error",
      durationMs: elapsedMs,
    });
    return cached;
  }

  if (result.status === 304) {
    if (cache?.settings) {
      // 304 是权威「内容没变」。刷新 fetched_at，否则紧接着一次超时会把仍有效的策略当过期丢掉。
      writePolicyCache({
        etag: result.etag ?? cache.etag,
        endpoint,
        fetched_at: new Date().toISOString(),
        last_status: 200,
        settings: cache.settings,
      });
      log.info(
        "POLICY",
        `远程策略 304 用缓存 fetched_at=${cache.fetched_at ?? "?"} elapsed_ms=${elapsedMs}`,
      );
      rememberLoadMeta({ source: "remote", outcome: "unchanged", durationMs: elapsedMs });
      return cache.settings;
    }
    log.warn("POLICY", `远程策略 304 但本地无 settings elapsed_ms=${elapsedMs} → 无远程策略`);
    rememberLoadMeta({ source: "none", outcome: "none", durationMs: elapsedMs });
    return null;
  }

  if (result.status === 204) {
    writeNegativeCache(endpoint, result.etag);
    log.info("POLICY", `远程策略 204 无策略 elapsed_ms=${elapsedMs} 已清缓存`);
    rememberLoadMeta({ source: "none", outcome: "none", durationMs: elapsedMs });
    return null;
  }

  if (result.status === 401) {
    log.warn("POLICY", `远程策略 401 elapsed_ms=${elapsedMs}：设备凭据无效或已吊销`);
    const cached = usableCachedSettings(cache, `401 elapsed_ms=${elapsedMs}`);
    rememberLoadMeta({
      source: cached ? "remote" : "none",
      outcome: cached ? "cache_fallback" : "error",
      durationMs: elapsedMs,
    });
    return cached;
  }

  if (result.status !== 200) {
    log.warn("POLICY", `远程策略 HTTP ${result.status} elapsed_ms=${elapsedMs}`);
    const cached = usableCachedSettings(cache, `HTTP ${result.status} elapsed_ms=${elapsedMs}`);
    rememberLoadMeta({
      source: cached ? "remote" : "none",
      outcome: cached ? "cache_fallback" : "error",
      durationMs: elapsedMs,
    });
    return cached;
  }

  const settings = sanitizeRemotePolicy(result.json);
  if (!settings) {
    log.warn("POLICY", `远程策略 200 body 无效 elapsed_ms=${elapsedMs}`);
    const cached = usableCachedSettings(cache, `200 无效 elapsed_ms=${elapsedMs}`);
    rememberLoadMeta({
      source: cached ? "remote" : "none",
      outcome: cached ? "cache_fallback" : "error",
      durationMs: elapsedMs,
    });
    return cached;
  }

  writePolicyCache({
    etag: result.etag,
    endpoint,
    fetched_at: new Date().toISOString(),
    last_status: 200,
    settings,
  });
  const deny = settings.permissions?.deny?.length ?? 0;
  log.info(
    "POLICY",
    `远程策略 200 etag=${result.etag ?? "—"} deny=${deny} elapsed_ms=${elapsedMs}`,
  );
  rememberLoadMeta({ source: "remote", outcome: "applied", durationMs: elapsedMs });
  return settings;
}

/** 仅测试 */
export function __resetRemotePolicyLoaderForTest(): void {
  warnedNoCredential = false;
  warnedCorruptCache = false;
  inFlightDefaultLoad = null;
  defaultLoadResult = undefined;
  lastPolicyLoadMeta = null;
}

async function runLoaders(loaders: PolicyLoader[]): Promise<PolicySettings | null> {
  lastPolicyLoadMeta = null;
  for (const loader of loaders) {
    const settings = await loader.load();
    if (settings) return settings;
  }
  // 链上全 null：未配 endpoint 且无本地文件。loader 自己没记信封时补 none。
  if (!lastPolicyLoadMeta) {
    rememberLoadMeta({ source: "none", outcome: "none", durationMs: 0 });
  }
  return null;
}

/**
 * 进程内默认链只跑一次。cli.ts 与 app.ts 必须调这个，禁止各 `new PolicyManager().load()`
 * 打两次网（验收 16:01：一次超时回退 deny、一次 204 清盘，进程内 deny 留下）。
 *
 * 自定义 loaders 的 PolicyManager 不走去重——测试替身必须每次真的 load。
 */
export function loadEnterprisePolicyOnce(): Promise<PolicySettings | null> {
  if (defaultLoadResult !== undefined) return Promise.resolve(defaultLoadResult);
  if (inFlightDefaultLoad) return inFlightDefaultLoad;
  inFlightDefaultLoad = runLoaders([new RemotePolicyLoader(), new ManagedFileLoader()])
    .then((settings) => {
      defaultLoadResult = settings;
      return settings;
    })
    .finally(() => {
      inFlightDefaultLoad = null;
    });
  return inFlightDefaultLoad;
}

/**
 * 把 PolicyManager.load 的结果同步进进程内单例。
 *
 * **无论 policy 是否 null 都要跑**：204 / 超时无可用缓存 / 未配 endpoint 必须把
 * `applied` 拨回 false。修前 `cli.ts` 用 `if (policy)` 包住，null 不拨状态，
 * 同进程先超时后 204 就会把旧 deny 留到进程结束。
 *
 * 第二参是 M4 信封。生产路径必须传；测试里直接调可以缺省——无 meta 时仍 apply
 * 状态机，**不 emit**（避免单测污染 events.jsonl）。
 */
export function applyLoadedPolicy(policy: PolicySettings | null, meta?: PolicyLoadMeta): void {
  if (policy?.source === "remote") {
    setRemotePolicyPermissions(policy.permissions, true);
  } else {
    setRemotePolicyPermissions(undefined, false);
  }
  if (policy) {
    if (policy.policyLimits) {
      setPolicyLimits(policy.policyLimits);
    }
    setPluginOnlyPolicy(policy.strictPluginOnlyCustomization);
    setModePolicy(policy.disabledModes, policy.disableBypassPermissionsMode);
  }
  emitPolicyEnforced(policy, meta);
}

function emitPolicyEnforced(policy: PolicySettings | null, meta?: PolicyLoadMeta): void {
  if (!meta) return;
  try {
    logPolicyEnforced({
      source: meta.source,
      outcome: meta.outcome,
      denyRuleCount: policy?.permissions?.deny?.length ?? 0,
      allowRuleCount: policy?.permissions?.allow?.length ?? 0,
      askRuleCount: policy?.permissions?.ask?.length ?? 0,
      disabledFeatures: policy
        ? Object.entries(policy.policyLimits ?? {})
            .filter(([, v]) => v && v.allowed === false)
            .map(([k]) => k)
        : [],
      durationMs: meta.durationMs,
    });
  } catch {
    /* 遥测旁路 */
  }
}

/**
 * 策略管理器
 * 按优先级尝试多个加载器，first-source-wins
 */
export class PolicyManager {
  private loaders: PolicyLoader[];
  private cachedSettings: PolicySettings | null = null;
  private readonly usesDefaultLoaders: boolean;

  constructor(loaders?: PolicyLoader[]) {
    this.usesDefaultLoaders = !loaders;
    this.loaders = loaders || [new RemotePolicyLoader(), new ManagedFileLoader()];
  }

  /**
   * 加载策略（first-source-wins）。
   *
   * ⚠️ cli 启动路径必须 await 本方法：后续 PermissionChecker.initRules()
   * 依赖 setRemotePolicyPermissions 的进程内状态。改成 fire-and-forget
   * 会让远程 permissions.deny 再次空转。
   *
   * 默认 loaders 走 `loadEnterprisePolicyOnce()`：进程内第二次调用复用第一次的
   * in-flight / 结果，不再打第二次 HTTPS。
   */
  async load(): Promise<PolicySettings | null> {
    const settings = this.usesDefaultLoaders
      ? await loadEnterprisePolicyOnce()
      : await runLoaders(this.loaders);
    this.cachedSettings = settings;
    return settings;
  }

  /** 加载并带上信封（生产路径用这个再交给 applyLoadedPolicy）。 */
  async loadWithMeta(): Promise<PolicyLoadResult> {
    const settings = await this.load();
    const meta = lastPolicyLoadMeta ?? {
      source: (settings?.source ?? "none") as PolicySource | "none",
      outcome: settings ? "applied" : "none",
      durationMs: 0,
    };
    return { settings, meta };
  }

  /** 获取缓存的策略 */
  getCached(): PolicySettings | null {
    return this.cachedSettings;
  }

  /** 检查功能是否被策略允许 */
  isPolicyAllowed(feature: string): boolean {
    if (!this.cachedSettings?.policyLimits) return true;
    const limit = this.cachedSettings.policyLimits[feature];
    if (!limit) return true;
    return limit.allowed;
  }

  /** 检查权限模式是否被策略禁用 */
  isModeDisabled(mode: string): boolean {
    if (!this.cachedSettings?.disabledModes) return false;
    return this.cachedSettings.disabledModes.includes(mode);
  }
}
