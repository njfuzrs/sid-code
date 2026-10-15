/**
 * 设备凭据存储（M1 PR-1.4）。
 *
 * 诚实说明档位：文件 + 0o600，与现有 API Key / mcp-oauth.json 同档。不假装进了 keychain。
 *
 * 失败语义（规划 §6，写进代码而非事后改）：
 * - 读取失败 / 损坏：**fail-open**——降级到本地默认 + 告警，不阻塞主流程。
 *   身份通道挂了不该让开发者无法工作；M2/M3 控制面请求此时不带 Authorization。
 * - 签发本身（enroll）是 fail-closed，那是平台 PR-1.3 的事，本模块不签发。
 *
 * 吊销与过期都只由服务端判定（401）。本地 expires_at 只是登录时的快照，仅用于展示，
 * 不再据此扣下凭据（服务端滑动续期，见 getUsableCredentialToken）。
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
  /**
   * P2 飞书登录态：凭据绑定到的人。只用于客户端展示与 getIdentity() 的 userId；
   * 服务端归因只认 device.user_ref，这里写什么都伪造不了归属。注册码流程没有这一段。
   */
  user?: CredentialUser;
}

export interface CredentialUser {
  /** 后端 users 表主键（字符串化） */
  id?: string;
  name?: string;
  /** 飞书 union_id，跨应用稳定，优先作为 userId */
  unionId?: string;
}

interface CredentialFile {
  credential?: unknown;
  expires_at?: unknown;
  expiresAt?: unknown;
  enrolled_at?: unknown;
  enrolledAt?: unknown;
  user?: unknown;
}

function parseUser(raw: unknown): CredentialUser | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined => {
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    if (typeof v !== "string") return undefined;
    const t = v.trim();
    return t === "" ? undefined : t;
  };
  const user: CredentialUser = {
    id: str(rec.id),
    name: str(rec.name),
    unionId: str(rec.union_id) ?? str(rec.unionId),
  };
  return user.id || user.name || user.unionId ? user : undefined;
}

let cached: DeviceCredential | null | undefined;
let loggedLocalExpired = false;
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
  const user = parseUser(parsed.user);
  return { credential, expiresAt, enrolledAt, ...(user ? { user } : {}) };
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
 * 返回用于 Authorization 的凭据明文。缺失 / 损坏返回 undefined，不抛错。
 *
 * **本地 expiresAt 已过也照常返回**（B1）：服务端是滑动续期（每次鉴权通过把过期时间
 * 往后推），而本地文件里的 expiresAt 是登录那一刻的快照、从不更新。以前本地一过期就
 * 扣下凭据，结果登录满一个 TTL 后，哪怕天天在用，所有企业通道也静默失去凭据——
 * 服务端那边凭据其实还有效。所以「是否失效」只由服务端 401 判定，各通道的 401 路径
 * 本来就处理好了。凭据只发往 backend.url 同源地址，本地过期不扩大泄露面。
 *
 * 不要改回「本地过期就返回 undefined」，也不要让客户端自己模仿服务端滑动续期
 * （要硬编码服务端 TTL，服务端改配置就再次漂移）。
 */
export function getUsableCredentialToken(now = Date.now()): string | undefined {
  const cred = getDeviceCredential();
  if (!cred) return undefined;
  if (isCredentialExpired(cred, now) && !loggedLocalExpired) {
    loggedLocalExpired = true;
    getLogger().debug(
      "IDENTITY",
      "本地记录的设备凭据过期时间已过，仍照常携带（服务端滑动续期，以服务端 401 为准）",
    );
  }
  return cred.credential;
}

/**
 * 服务端 401（凭据被吊销 / 过期 / 设备解绑）时统一追加的提示。
 * 各处 401 告警都拼这一句，用户只需要记住一个动作。
 */
export const RELOGIN_HINT = "请执行 sid-code auth login 重新登录";

/** 给 M2/M3 控制面请求用。无可用凭据时原样返回 headers。 */
export function applyDeviceAuth(headers: Record<string, string>): Record<string, string> {
  const token = getUsableCredentialToken();
  if (!token) return headers;
  return { ...headers, Authorization: `Bearer ${token}` };
}

// ── 进程内事件：凭据换了 / 凭据被服务端拒了 ─────────────────────────────
//
// 为什么需要：在 TUI 里 /login，当前进程已经按「没登录」初始化过策略和预算（进程内只加载一次）。
// 不通知的话，登录成功了本会话仍按无远程策略、无预算运行。core 只负责发事件，
// 刷新动作由持有 permissionChecker / hookSystem 的 app 层订阅（登录闭环方案 §5.6）。

type CredentialChangedListener = (cred: DeviceCredential | null) => void;
type CredentialRejectedListener = (source: string) => void;
const changedListeners = new Set<CredentialChangedListener>();
const rejectedListeners = new Set<CredentialRejectedListener>();

/**
 * 凭据代数：凭据明文每换一次（登录 / 登出）加一。
 * 各通道的「401 只告警一次」标记记下告警时的代数，代数变了就允许再告警——
 * 否则重新登录后凭据第二次失效时，用户什么提示都看不到。
 */
let credentialGeneration = 0;
/** 本代凭据是否已经上报过一次 rejected（多条通道同时 401 只通知一次） */
let rejectedReportedGeneration = -1;

export function getCredentialGeneration(): number {
  return credentialGeneration;
}

/** 订阅「凭据明文变了」（登录、登出）。只续期过期时间不触发。返回取消订阅函数。 */
export function onCredentialChanged(listener: CredentialChangedListener): () => void {
  changedListeners.add(listener);
  return () => {
    changedListeners.delete(listener);
  };
}

/** 订阅「服务端拒绝了当前凭据（401）」。每一代凭据最多触发一次。 */
export function onCredentialRejected(listener: CredentialRejectedListener): () => void {
  rejectedListeners.add(listener);
  return () => {
    rejectedListeners.delete(listener);
  };
}

/**
 * 企业通道收到 401 时调用（策略 / 预算 / 账本 / 事件）。统一上报点，TUI 据此提示「请 /login」。
 * 各通道原有的日志告警不变，这里只多一条用户看得见的通知。
 */
export function reportCredentialRejected(source: string): void {
  if (rejectedReportedGeneration === credentialGeneration) return;
  rejectedReportedGeneration = credentialGeneration;
  for (const l of rejectedListeners) {
    try {
      l(source);
    } catch {
      /* 订阅方自己吞 */
    }
  }
}

function emitChanged(cred: DeviceCredential | null): void {
  credentialGeneration++;
  for (const l of changedListeners) {
    try {
      l(cred);
    } catch {
      /* 订阅方自己吞，不能拖垮登录 / 登出 */
    }
  }
}

/** 落盘凭据（enroll 成功后由调用方写入）。权限 0o600。 */
export function saveDeviceCredential(cred: DeviceCredential): void {
  // 先取旧值再覆盖缓存：只有凭据明文变了才算「换了凭据」，单纯同步过期时间（credential-sync）不算
  const previous = getDeviceCredential();
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
      ...(cred.user
        ? {
            user: {
              ...(cred.user.id ? { id: cred.user.id } : {}),
              ...(cred.user.name ? { name: cred.user.name } : {}),
              ...(cred.user.unionId ? { union_id: cred.user.unionId } : {}),
            },
          }
        : {}),
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
  loggedLocalExpired = false;
  warnedCorrupt = false;
  if (previous?.credential !== cred.credential) emitChanged(cred);
}

/** 删除落盘凭据（登出 / 吊销后的本地清理）。失败不抛。 */
export function clearDeviceCredential(): void {
  const hadCredential = getDeviceCredential() !== null;
  cached = null;
  loggedLocalExpired = false;
  warnedCorrupt = false;
  const path = sidPaths.deviceCredential();
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch (err) {
    getLogger().warn("IDENTITY", `删除设备凭据失败: ${(err as Error).message}`);
  }
  if (hadCredential) emitChanged(null);
}

/** 仅测试 */
export function __resetCredentialCacheForTest(): void {
  cached = undefined;
  loggedLocalExpired = false;
  warnedCorrupt = false;
  changedListeners.clear();
  rejectedListeners.clear();
  rejectedReportedGeneration = -1;
}
