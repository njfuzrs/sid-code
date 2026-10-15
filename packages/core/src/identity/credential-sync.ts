/**
 * 启动时同步设备凭据的过期时间（登录闭环方案 §5.1 方案 A，客户端部分）。
 *
 * 为什么需要：服务端凭据是滑动续期（每次鉴权通过把 expires_at 往后推一个 TTL），
 * 而本地文件里的 expiresAt 是登录那一刻的快照、从不更新。`auth status` 于是一直显示
 * 登录时的过期时间，满一个 TTL 后还会显示「已过期」——服务端那边其实仍有效。
 * agent-backend 从 #63 起在 `/ctl/whoami` 回传续期后的 `expires_at`，这里据此回写本地。
 *
 * 四条刻意的取舍：
 * - **用原始凭据，不用 getUsableCredentialToken()**：本地已过期时后者可能扣下凭据，
 *   那正是最需要同步的时刻（否则同步被 B1 本身拦住）。
 * - **不模仿服务端 TTL**：客户端只抄服务端给的值，服务端改 CTL_CREDENTIAL_TTL_DAYS 也不会漂移。
 * - **旧后端（响应无 expires_at）/ 401 / 网络错误：本地文件不动**。401 由各通道原有路径处理，
 *   这里不替用户删凭据——那是 logout 的职责。
 * - **24 小时最多一次**，fire-and-forget，不挡启动。节流状态落 `state/credential-sync.json`。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sidPaths } from "../config/paths.ts";
import { getLogger } from "../debug/logger.ts";
import { resolveBackendUrl } from "./backend-url.ts";
import { verifyCredentialRemote } from "./cli-login.ts";
import { getDeviceCredential, saveDeviceCredential } from "./credential.ts";

/** 两次同步的最小间隔。 */
export const CREDENTIAL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type CredentialSyncResult =
  /** 本地过期时间已更新 */
  | { kind: "updated"; expiresAt: string }
  /** 服务端返回的过期时间与本地一致 */
  | { kind: "unchanged" }
  /** 没有发请求：没配后端 / 没有凭据 / 24 小时内同步过 */
  | { kind: "skipped"; reason: "no-backend" | "no-credential" | "throttled" }
  /** 服务端没回 expires_at（旧后端）或值无法解析 */
  | { kind: "no-field" }
  | { kind: "unauthorized" }
  | { kind: "error"; detail: string };

interface SyncState {
  last_attempt_at?: string;
}

function statePath(): string {
  return sidPaths.stateFile("credential-sync.json");
}

function readLastAttempt(): number | undefined {
  const path = statePath();
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as SyncState;
    const ts = typeof raw.last_attempt_at === "string" ? Date.parse(raw.last_attempt_at) : NaN;
    return Number.isNaN(ts) ? undefined : ts;
  } catch {
    return undefined;
  }
}

function writeLastAttempt(now: number): void {
  const path = statePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ last_attempt_at: new Date(now).toISOString() }), "utf-8");
  } catch (err) {
    // 写不进去只会让下次启动再同步一次，不影响主流程
    getLogger().debug("IDENTITY", `凭据同步节流状态写入失败: ${(err as Error).message}`);
  }
}

/** 从 whoami 响应里取 expires_at；缺失、非字符串或解析不出时间都返回 undefined。 */
function pickExpiresAt(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>).expires_at;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return Number.isNaN(Date.parse(value)) ? undefined : value;
}

export interface SyncCredentialOptions {
  /** 缺省按 backend.url 解析 */
  backendUrl?: string | null;
  fetchImpl?: typeof fetch;
  now?: number;
  /** 忽略 24 小时节流（auth status --verify 之类的显式核验用） */
  force?: boolean;
}

/**
 * 调 `/ctl/whoami`，把服务端续期后的过期时间回写本地凭据文件。不抛错。
 */
export async function syncCredentialFromServer(
  opts: SyncCredentialOptions = {},
): Promise<CredentialSyncResult> {
  const now = opts.now ?? Date.now();
  const backendUrl =
    opts.backendUrl !== undefined ? opts.backendUrl : (resolveBackendUrl()?.url ?? null);
  if (!backendUrl) return { kind: "skipped", reason: "no-backend" };

  const cred = getDeviceCredential();
  if (!cred) return { kind: "skipped", reason: "no-credential" };

  if (!opts.force) {
    const last = readLastAttempt();
    if (last !== undefined && now - last >= 0 && now - last < CREDENTIAL_SYNC_INTERVAL_MS) {
      return { kind: "skipped", reason: "throttled" };
    }
  }

  const outcome = await verifyCredentialRemote(backendUrl, cred.credential, opts.fetchImpl);
  if (outcome.kind === "error") {
    // 网络错误不记节流：下次启动再试，不让一次断网吃掉一整天
    return { kind: "error", detail: outcome.detail };
  }
  writeLastAttempt(now);
  if (outcome.kind === "unauthorized") return { kind: "unauthorized" };

  const expiresAt = pickExpiresAt(outcome.body);
  if (!expiresAt) return { kind: "no-field" };

  // 请求期间可能有别的进程重新登录换了凭据：只回写发请求时用的那一份，不覆盖新凭据
  const current = getDeviceCredential();
  if (!current || current.credential !== cred.credential) return { kind: "unchanged" };
  if (current.expiresAt === expiresAt) return { kind: "unchanged" };

  saveDeviceCredential({ ...current, expiresAt });
  getLogger().debug("IDENTITY", `已按服务端同步设备凭据过期时间: ${expiresAt}`);
  return { kind: "updated", expiresAt };
}

/** 启动入口：后台跑一次，不等待、不抛错。 */
export function startCredentialSync(): void {
  void syncCredentialFromServer()
    .then((r) => {
      if (r.kind === "error") getLogger().debug("IDENTITY", `凭据过期时间同步失败: ${r.detail}`);
    })
    .catch(() => {});
}
