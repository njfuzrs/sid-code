/**
 * 策略层抽象
 * 支持本地文件策略（managed-settings.json）和远程策略（SID_CODE_POLICY_ENDPOINT）
 * first-source-wins：只取最高优先级的来源，不合并
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";
import { getLogger } from "../debug/logger.ts";
import { applyDeviceAuth, getUsableCredentialToken } from "../identity/credential.ts";
import { sidPaths } from "./paths.ts";
import type { CustomizationSurface } from "./plugin-only-policy.ts";

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
      return { source: "managed_file", ...parsed };
    } catch (err: any) {
      log.warn("POLICY", `读取策略文件失败: ${err.message}`);
      return null;
    }
  }
}

/**
 * 远程策略加载器（M3）。
 *
 * 失败语义（契约写进代码，不要事后改）：
 * - 未设 `SID_CODE_POLICY_ENDPOINT` → 立即 null，零请求（fail-open，不是错误）
 * - `http://` 且 host 不是 localhost/127.0.0.1 → 拒绝请求并 warn，当 null
 * - 网络 / 5xx / 超时 / JSON 不可解析 → 磁盘缓存 → 再没有则 null
 * - 401 → 告警凭据，退回缓存 / null，不阻塞启动
 * - 204 → 远程明确没有；清缓存、返回 null，让位给 ManagedFileLoader
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
      return null;
    }

    let cache = readPolicyCache();
    if (cache && cache.endpoint !== endpoint) cache = null;

    const token = getUsableCredentialToken();
    if (!token) {
      if (!warnedNoCredential) {
        warnedNoCredential = true;
        log.warn("POLICY", "无设备凭据，跳过远程策略（fail-open；有磁盘缓存则用缓存）");
      }
      return cache?.settings ?? null;
    }

    const headers = applyDeviceAuth({ Accept: "application/json" });
    if (cache?.etag) headers["If-None-Match"] = cache.etag;

    let resp: Response;
    try {
      resp = await fetch(endpoint, {
        headers,
        signal: AbortSignal.timeout(POLICY_FETCH_TIMEOUT_MS),
      });
    } catch (err: any) {
      log.warn("POLICY", `远程策略请求失败（fail-open，回退缓存）: ${err?.message ?? err}`);
      return cache?.settings ?? null;
    }

    if (resp.status === 304) {
      return cache?.settings ?? null;
    }
    if (resp.status === 204) {
      // 远程明确没有。按契约当 null，让位给 ManagedFileLoader。
      // 不要把「空远程」写入缓存当成有效 settings。
      clearPolicyCache();
      return null;
    }
    if (resp.status === 401) {
      log.warn("POLICY", "远程策略 401：设备凭据无效或已吊销（fail-open，回退缓存）");
      return cache?.settings ?? null;
    }
    if (!resp.ok) {
      log.debug("POLICY", `远程策略 HTTP ${resp.status}（fail-open，回退缓存）`);
      return cache?.settings ?? null;
    }

    let json: unknown;
    try {
      json = await resp.json();
    } catch (err: any) {
      log.warn("POLICY", `远程策略 JSON 不可解析（fail-open，回退缓存）: ${err?.message ?? err}`);
      return cache?.settings ?? null;
    }

    const settings = sanitizeRemotePolicy(json);
    if (!settings) return cache?.settings ?? null;

    const etag = resp.headers.get("ETag") ?? undefined;
    writePolicyCache({
      etag,
      endpoint,
      fetched_at: new Date().toISOString(),
      settings,
    });
    return settings;
  }
}

/** 启动路径 5s 超时，与 flag `refreshFromRemote` 一致，不能挂死。 */
const POLICY_FETCH_TIMEOUT_MS = 5000;

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
  settings?: PolicySettings;
}

let warnedNoCredential = false;
let warnedCorruptCache = false;

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
    const settings = parsed.settings ? sanitizeRemotePolicy(parsed.settings) : null;
    if (!settings) return null;
    return {
      etag: typeof parsed.etag === "string" ? parsed.etag : undefined,
      fetched_at: typeof parsed.fetched_at === "string" ? parsed.fetched_at : undefined,
      endpoint: typeof parsed.endpoint === "string" ? parsed.endpoint : undefined,
      settings,
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
  settings: PolicySettings;
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
        settings: cache.settings,
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

function clearPolicyCache(): void {
  const path = sidPaths.policyCache();
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch (err: any) {
    getLogger().debug("POLICY", `清除远程策略缓存失败: ${err?.message ?? err}`);
  }
}

/** 仅测试 */
export function __resetRemotePolicyLoaderForTest(): void {
  warnedNoCredential = false;
  warnedCorruptCache = false;
}

/**
 * 策略管理器
 * 按优先级尝试多个加载器，first-source-wins
 */
export class PolicyManager {
  private loaders: PolicyLoader[];
  private cachedSettings: PolicySettings | null = null;

  constructor(loaders?: PolicyLoader[]) {
    this.loaders = loaders || [new RemotePolicyLoader(), new ManagedFileLoader()];
  }

  /**
   * 加载策略（first-source-wins）。
   *
   * ⚠️ cli 启动路径必须 await 本方法：后续 PermissionChecker.initRules()
   * 依赖 setRemotePolicyPermissions 的进程内状态。改成 fire-and-forget
   * 会让远程 permissions.deny 再次空转（app.ts 那条异步只影响 hook 门控）。
   */
  async load(): Promise<PolicySettings | null> {
    for (const loader of this.loaders) {
      const settings = await loader.load();
      if (settings) {
        this.cachedSettings = settings;
        return settings;
      }
    }
    this.cachedSettings = null;
    return null;
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
