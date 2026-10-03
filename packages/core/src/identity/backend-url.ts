/**
 * 统一后端地址 `backend.url`（P2 引入）。
 *
 * 登录（auth login）、P5 插件市场、P4 远程 MCP 的 origin 校验共用这一个值，
 * 不再每个功能各读各的 endpoint 环境变量。已有的 SID_CODE_*_ENDPOINT 暂时不动。
 *
 * 取值形如 `https://www.sid-code.cc/traj`（即服务端的 PUBLIC_BASE_URL），
 * API 路径由调用方拼 `/api/v1/...`。
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
 * 解析当前生效的后端地址。未配置返回 null（不是错误：没有后端的部署照常工作）。
 * 配了但不合法也返回 null，并告警。
 */
export function resolveBackendUrl(): ResolvedBackendUrl | null {
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
      getLogger().warn(
        "IDENTITY",
        `backend.url（来源 ${source}）不合法，只允许 https:// 或 http://127.0.0.1|localhost：${raw}`,
      );
      return null;
    }
    return { ...norm, source };
  }
  return null;
}

/** 拼 API 地址：`${backend}/api/v1${path}` */
export function backendApiUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/api/v1${path.startsWith("/") ? path : `/${path}`}`;
}
