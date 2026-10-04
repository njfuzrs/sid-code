/**
 * 企业后端全部通道的**唯一取址入口**（20261004 七条通道六种取址）。
 *
 * 只有一个后端（agent-backend），用户只填一个 base：`backend.url`
 * （env `SID_CODE_BACKEND_URL` > managed-settings > 用户 settings，项目级不参与）。
 * 每条通道的路径由本文件按服务端契约拼出——服务端路由结构**只在这里出现一次**，
 * 不再泄漏进用户配置。
 *
 * 曾经的形态：策略 / 预算 / 账本各读各的 `SID_CODE_*_ENDPOINT`（要填完整路径），
 * 事件读 `analytics.backends[]`，flag 读 `analytics.featureFlagEndpoint`。
 * 结果是配了 backend.url、登录成功之后，事件 / 账本 / 策略 / 预算 / flag 照样静默不发，
 * `auth status` 还显示「✓ 凭据有效」。
 *
 * 门禁：`tests/backend/endpoint-single-source.test.ts` 静态扫描 core/src，
 * 本文件之外出现 `/api/v1/` 字面量或读 `SID_CODE_*_ENDPOINT` 即红。
 * 新加通道只能往 `BACKEND_PATHS` 里加一行。
 */

import { getLogger } from "../debug/logger.ts";
import { inspectBackendUrl, normalizeBackendUrl, type BackendUrlSource } from "./backend-url.ts";

export type BackendChannel =
  | "auth"
  | "whoami"
  | "policy"
  | "budget"
  | "flags"
  | "events"
  | "usage"
  | "upload"
  | "health"
  | "bridge";

/** API 前缀。服务端所有路由都在同一个 FastAPI 应用的这个前缀下（agent-backend main.py）。 */
export const BACKEND_API_PREFIX = "/api/v1";

/**
 * 通道 → (方法, 路径)。路径**不含** `/api/v1` 前缀。
 * `auth` / `upload` / `bridge` 是前缀型通道，调用方再拼子路径（见 `backendUrl()`）；
 * 契约快照里登记的是它们实际会打到的具体路由（`BACKEND_ROUTE_CONTRACT`）。
 */
export const BACKEND_PATHS: Readonly<Record<BackendChannel, string>> = {
  auth: "/auth",
  whoami: "/ctl/whoami",
  policy: "/ctl/policy",
  budget: "/ctl/budget",
  flags: "/ctl/flags",
  events: "/events",
  usage: "/usage/ledger",
  upload: "/upload",
  health: "/health",
  bridge: "/ctl/bridge",
};

/**
 * 客户端实际会请求的 (method, path) 全集——导出成 JSON 快照给 agent-backend 的契约测试用
 * （`packages/core/tests/fixtures/backend-paths.json`，由测试生成并断言与本表一致）。
 * 改了这里就要把快照同步到 agent-backend `tests/fixtures/sid-code-backend-paths.json`。
 */
export const BACKEND_ROUTE_CONTRACT: ReadonlyArray<{ method: "GET" | "POST"; path: string }> = [
  { method: "GET", path: `${BACKEND_API_PREFIX}/auth/feishu/cli/start` },
  { method: "POST", path: `${BACKEND_API_PREFIX}/auth/cli/exchange` },
  { method: "POST", path: `${BACKEND_API_PREFIX}/auth/cli/logout` },
  { method: "GET", path: `${BACKEND_API_PREFIX}/ctl/whoami` },
  { method: "GET", path: `${BACKEND_API_PREFIX}/ctl/policy` },
  { method: "GET", path: `${BACKEND_API_PREFIX}/ctl/budget` },
  { method: "GET", path: `${BACKEND_API_PREFIX}/ctl/flags` },
  { method: "POST", path: `${BACKEND_API_PREFIX}/events` },
  { method: "POST", path: `${BACKEND_API_PREFIX}/usage/ledger` },
  { method: "POST", path: `${BACKEND_API_PREFIX}/upload/session-file` },
  { method: "GET", path: `${BACKEND_API_PREFIX}/health` },
];

export type EndpointSource = BackendUrlSource | "legacy-env" | "legacy-settings";

export interface ResolvedEndpoint {
  /** 完整地址，已过统一的 https / loopback 校验 */
  url: string;
  source: EndpointSource;
  /** 推出这个地址的 base（legacy 来源时为 undefined） */
  base?: string;
}

/** 拼地址：`${base}/api/v1${PATHS[ch]}${sub}`。base 须已规范化（无尾斜杠）。 */
export function backendUrl(base: string, channel: BackendChannel, sub = ""): string {
  const tail = sub === "" ? "" : sub.startsWith("/") ? sub : `/${sub}`;
  return `${base.replace(/\/+$/, "")}${BACKEND_API_PREFIX}${BACKEND_PATHS[channel]}${tail}`;
}

/**
 * 明文 HTTP 且 host 不是 loopback → true（拒绝）。四份实现合并后的唯一版本（U7）。
 * 与 `normalizeBackendUrl` 同一判据：多了「URL 里带用户名密码也拒绝」——
 * 旧的 policy.ts 版本放行 `https://u:p@host`，凭据会随 URL 进日志与缓存文件。
 */
export function isNonLocalHttp(endpoint: string): boolean {
  return normalizeBackendUrl(endpoint) === null;
}

// ─── 兼容旧配置（一个版本周期后删除，见 §3.3） ───

/** 旧通道变量。只有这里读它们——静态门禁豁免本文件。 */
const LEGACY_ENV: Partial<Record<BackendChannel, string>> = {
  policy: "SID_CODE_POLICY_ENDPOINT",
  budget: "SID_CODE_BUDGET_ENDPOINT",
  usage: "SID_CODE_USAGE_ENDPOINT",
};

const warnedLegacy = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedLegacy.has(key)) return;
  warnedLegacy.add(key);
  getLogger().warn("BACKEND", message);
}

function readLegacyEnv(channel: BackendChannel): { name: string; value: string } | null {
  const name = LEGACY_ENV[channel];
  if (!name) return null;
  const value = process.env[name]?.trim();
  return value ? { name, value } : null;
}

/**
 * 兼容层的「旧地址与新地址打架」判定。新地址优先；旧值有、且推出的地址不同时告警。
 * 导出给 `legacySetting` 场景复用（flag 的 analytics.featureFlagEndpoint）。
 */
function resolveWithLegacy(
  channel: BackendChannel,
  legacy: { name: string; value: string; source: "legacy-env" | "legacy-settings" } | null,
): ResolvedEndpoint | null {
  const inspected = inspectBackendUrl();
  if (inspected.kind === "ok") {
    const base = inspected.backend.url;
    const url = backendUrl(base, channel);
    if (legacy) {
      const legacyNorm = normalizeBackendUrl(legacy.value)?.url;
      if (legacyNorm !== url) {
        warnOnce(
          `${legacy.name}:ignored`,
          `${legacy.name} 已弃用且与 backend.url 推出的地址不一致，将忽略 ${legacy.value}，改用 ${url}`,
        );
      } else {
        warnOnce(
          `${legacy.name}:redundant`,
          `${legacy.name} 已弃用：backend.url 已覆盖这条通道，可以删除`,
        );
      }
    }
    return { url, source: inspected.backend.source, base };
  }
  // 配了 backend.url 但不合法：**不得**降级用旧变量（T5）。告警已在 inspectBackendUrl 里。
  if (inspected.kind === "invalid") return null;
  if (!legacy) return null;
  const norm = normalizeBackendUrl(legacy.value);
  if (!norm) {
    warnOnce(
      `${legacy.name}:plaintext`,
      `${legacy.name} 拒绝明文非本地地址（只允许 https:// 或 http://127.0.0.1|localhost）: ${legacy.value}`,
    );
    return null;
  }
  warnOnce(
    `${legacy.name}:deprecated`,
    `${legacy.name} 已弃用，请改为在 settings.json 配 backend.url`,
  );
  return { url: norm.url, source: legacy.source };
}

/**
 * 解析一条通道的完整地址。未配置 / 不合法返回 null。
 *
 * `legacySetting`：调用方从 settings 读到的旧字段值（目前只有 flag 的
 * `analytics.featureFlagEndpoint`）。本模块不加载 Config，所以由调用方传进来。
 */
export function resolveEndpoint(
  channel: BackendChannel,
  opts: { legacySetting?: { name: string; value: string | undefined } } = {},
): ResolvedEndpoint | null {
  const env = readLegacyEnv(channel);
  const setting = opts.legacySetting?.value?.trim()
    ? {
        name: opts.legacySetting.name,
        value: opts.legacySetting.value.trim(),
        source: "legacy-settings" as const,
      }
    : null;
  const legacy = env ? { ...env, source: "legacy-env" as const } : setting;
  return resolveWithLegacy(channel, legacy);
}

export function __resetEndpointWarningsForTest(): void {
  warnedLegacy.clear();
}
