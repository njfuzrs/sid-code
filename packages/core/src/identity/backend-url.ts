/**
 * 统一后端地址 `backend.url`（P2 引入）。
 *
 * 控制面与数据面全部通道（登录 / 策略 / 预算 / 账本 / 事件 / flag / 轨迹上传）共用这一个值。
 * 各通道不要直接读本模块：一律走 `./endpoints.ts` 的 `resolveEndpoint()`，路径只在那里拼。
 * 曾经每条通道各读各的 SID_CODE_*_ENDPOINT，配了 backend.url 且登录成功后事件 / 账本 /
 * 策略照样静默不发（20261004 七条通道六种取址）。
 *
 * 取值形如 `https://www.sid-code.cc/traj`（即服务端的 PUBLIC_BASE_URL）。
 *
 * 优先级：环境变量 SID_CODE_BACKEND_URL > managed-settings.json > ~/.sid-code/settings.json。
 * **项目级 settings 不参与**：后端地址决定设备凭据发往哪里，仓库里的 settings.json
 * 能改它就等于能把员工凭据导到攻击者端点（已加入 SECURITY_SENSITIVE_FIELDS）。
 *
 * 不走 loadConfig()：`auth login` 是 bootstrap 快速路径，不加载整套配置；
 * 与 loadManagedIdentity 同样直接读文件，损坏一律当没配。
 */

import { existsSync, readFileSync } from "node:fs";
import { sidPaths } from "../config/paths.ts";
import { getLogger } from "../debug/logger.ts";

export type BackendUrlSource = "env" | "managed" | "user";

export interface ResolvedBackendUrl {
  /** 规范化后的地址：无尾斜杠、无 query / hash */
  url: string;
  /** `new URL(url).origin`，给 P4 的 origin 比对用 */
  origin: string;
  source: BackendUrlSource;
}

function readBackendUrlFromFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const backend = (raw as { backend?: unknown }).backend;
    if (!backend || typeof backend !== "object" || Array.isArray(backend)) return undefined;
    const url = (backend as { url?: unknown }).url;
    return typeof url === "string" && url.trim() !== "" ? url.trim() : undefined;
  } catch {
    getLogger().warn("IDENTITY", `读取 backend.url 失败，已忽略: ${path}`);
    return undefined;
  }
}

/**
 * 规范化并校验。只允许 https，或 loopback 上的 http（本地开发）。
 * 明文非本地地址会让设备凭据裸奔，直接拒绝而不是告警后照用。
 */
export function normalizeBackendUrl(input: string): { url: string; origin: string } | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  const proto = u.protocol.toLowerCase();
  const host = u.hostname.toLowerCase();
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  if (proto !== "https:" && !(proto === "http:" && loopback)) return null;
  if (u.username || u.password) return null;
  u.search = "";
  u.hash = "";
  const url = u.toString().replace(/\/+$/, "");
  return { url, origin: u.origin };
}

/**
 * 解析结果的三种形态。「配了但不合法」必须和「没配」分开：
 * 前者不得降级去用旧的 SID_CODE_*_ENDPOINT（那等于让一个写错的地址悄悄换了出口）。
 */
export type BackendUrlInspection =
  | { kind: "ok"; backend: ResolvedBackendUrl }
  | { kind: "invalid"; source: BackendUrlSource; raw: string }
  | { kind: "none" };

const warnedInvalid = new Set<string>();

export function inspectBackendUrl(): BackendUrlInspection {
  const candidates: Array<[BackendUrlSource, string | undefined]> = [
    ["env", process.env.SID_CODE_BACKEND_URL?.trim() || undefined],
  ];
  const managed = sidPaths.managedPolicyCandidates().find((p) => existsSync(p));
  if (managed) candidates.push(["managed", readBackendUrlFromFile(managed)]);
  candidates.push(["user", readBackendUrlFromFile(sidPaths.settings())]);

  for (const [source, raw] of candidates) {
    if (!raw) continue;
    const norm = normalizeBackendUrl(raw);
    if (!norm) {
      // 每条通道都会解析一次，同一个错值只告警一次，否则日志被刷屏
      const key = `${source}\0${raw}`;
      if (!warnedInvalid.has(key)) {
        warnedInvalid.add(key);
        getLogger().warn(
          "IDENTITY",
          `backend.url（来源 ${source}）不合法，只允许 https:// 或 http://127.0.0.1|localhost：${raw}`,
        );
      }
      return { kind: "invalid", source, raw };
    }
    return { kind: "ok", backend: { ...norm, source } };
  }
  return { kind: "none" };
}

/**
 * 解析当前生效的后端地址。未配置返回 null（不是错误：没有后端的部署照常工作）。
 * 配了但不合法也返回 null，并告警。
 */
export function resolveBackendUrl(): ResolvedBackendUrl | null {
  const r = inspectBackendUrl();
  return r.kind === "ok" ? r.backend : null;
}

export function __resetBackendUrlWarningsForTest(): void {
  warnedInvalid.clear();
}
