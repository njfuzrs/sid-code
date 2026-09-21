/**
 * 设备凭据存储（M1 PR-1.4）。
 *
 * 诚实说明档位：文件 + 0o600，与现有 API Key / mcp-oauth.json 同档。不假装进了 keychain。
 *
 * 失败语义（规划 §6，写进代码而非事后改）：
 * - 读取 / 过期 / 损坏：**fail-open**——降级到本地默认 + 告警，不阻塞主流程。
 *   身份通道挂了不该让开发者无法工作；M2/M3 控制面请求此时不带 Authorization。
 * - 签发本身（enroll）是 fail-closed，那是平台 PR-1.3 的事，本模块不签发。
 *
 * 吊销只能由服务端判定（401）；本地只看 expires_at。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sidPaths } from "../config/paths.ts";
import { getLogger } from "../debug/logger.ts";

export interface DeviceCredential {
  /** 凭据明文。只在本机文件里，不上报、不进轨迹。 */
  credential: string;
  /** ISO 8601；缺省视为未设过期（仍 fail-open） */
  expiresAt?: string;
  /** ISO 8601 签发时间 */
  enrolledAt?: string;
}

interface CredentialFile {
  credential?: unknown;
  expires_at?: unknown;
  expiresAt?: unknown;
  enrolled_at?: unknown;
  enrolledAt?: unknown;
}

let cached: DeviceCredential | null | undefined;
let warnedExpired = false;
let warnedCorrupt = false;

function parseCredential(raw: string): DeviceCredential | null {
  let parsed: CredentialFile;
  try {
    parsed = JSON.parse(raw) as CredentialFile;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const credential = typeof parsed.credential === "string" ? parsed.credential.trim() : "";
  if (!credential) return null;
  const expiresAt =
    (typeof parsed.expires_at === "string" && parsed.expires_at) ||
    (typeof parsed.expiresAt === "string" && parsed.expiresAt) ||
    undefined;
  const enrolledAt =
    (typeof parsed.enrolled_at === "string" && parsed.enrolled_at) ||
    (typeof parsed.enrolledAt === "string" && parsed.enrolledAt) ||
    undefined;
  return { credential, expiresAt, enrolledAt };
}

function readFromDisk(): DeviceCredential | null {
  const path = sidPaths.deviceCredential();
  if (!existsSync(path)) return null;
  try {
    return parseCredential(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/** 读取落盘凭据。损坏时告警一次并视为缺失（fail-open）。不检查过期。 */
export function getDeviceCredential(): DeviceCredential | null {
  if (cached !== undefined) return cached;
  const path = sidPaths.deviceCredential();
  if (!existsSync(path)) {
    cached = null;
    return null;
  }
  const parsed = readFromDisk();
  if (!parsed) {
    if (!warnedCorrupt) {
      warnedCorrupt = true;
      getLogger().warn(
        "IDENTITY",
        `设备凭据文件损坏或为空，已忽略（fail-open，不阻断主流程）: ${path}`,
      );
    }
    cached = null;
    return null;
  }
  cached = parsed;
  return cached;
}

export function isCredentialExpired(cred: DeviceCredential, now = Date.now()): boolean {
  if (!cred.expiresAt) return false;
  const ts = Date.parse(cred.expiresAt);
  if (Number.isNaN(ts)) return true;
  return ts <= now;
}

/**
 * 返回仍可用于 Authorization 的凭据明文。
 * 过期 / 缺失 / 损坏一律返回 undefined，并告警，不抛错。
 */
export function getUsableCredentialToken(now = Date.now()): string | undefined {
  const cred = getDeviceCredential();
  if (!cred) return undefined;
  if (isCredentialExpired(cred, now)) {
    if (!warnedExpired) {
      warnedExpired = true;
      getLogger().warn(
        "IDENTITY",
        "设备凭据已过期，控制面请求将不携带 Authorization（fail-open，不阻断主流程）",
      );
    }
    return undefined;
  }
  return cred.credential;
}

/** 给 M2/M3 控制面请求用。无可用凭据时原样返回 headers。 */
export function applyDeviceAuth(headers: Record<string, string>): Record<string, string> {
  const token = getUsableCredentialToken();
  if (!token) return headers;
  return { ...headers, Authorization: `Bearer ${token}` };
}

/** 落盘凭据（enroll 成功后由调用方写入）。权限 0o600。 */
export function saveDeviceCredential(cred: DeviceCredential): void {
  const path = sidPaths.deviceCredential();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const body = JSON.stringify(
    {
      credential: cred.credential,
      ...(cred.expiresAt ? { expires_at: cred.expiresAt } : {}),
      ...(cred.enrolledAt ? { enrolled_at: cred.enrolledAt } : {}),
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
  cached = cred;
  warnedExpired = false;
  warnedCorrupt = false;
}

/** 删除落盘凭据（登出 / 吊销后的本地清理）。失败不抛。 */
export function clearDeviceCredential(): void {
  cached = null;
  warnedExpired = false;
  warnedCorrupt = false;
  const path = sidPaths.deviceCredential();
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch (err) {
    getLogger().warn("IDENTITY", `删除设备凭据失败: ${(err as Error).message}`);
  }
}

/** 仅测试 */
export function __resetCredentialCacheForTest(): void {
  cached = undefined;
  warnedExpired = false;
  warnedCorrupt = false;
}
