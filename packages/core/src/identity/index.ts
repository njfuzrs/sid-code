/**
 * 身份最小可用档（M1）。
 *
 * userId 优先取 `sid-code auth login`（P2 飞书登录）写进凭据文件的登录态，
 * 其次是环境变量或 managed / user settings；orgId / teamId 仍只来自后两者；
 * deviceId 是本机持久 UUID。自建账号明确不做。
 *
 * 优先级：环境变量 > setIdentityConfig（loadConfig 从 settings 灌进来的值）。
 * SID_CODE_TRACE_USER_ID / SID_CODE_TRACE_DEVICE_ID 是轨迹上传专用覆盖，不进本函数——
 * 四方落盘（事件 / 轨迹 / 账本 / hook）必须共用 getIdentity()，才能切片守恒。
 */

import { getOrCreateDeviceId, __resetDeviceIdCacheForTest } from "./device-id.ts";
import { __resetGitSnapshotForTest } from "./git-snapshot.ts";
import { __resetCredentialCacheForTest, getDeviceCredential } from "./credential.ts";
import { getLogger } from "../debug/logger.ts";

export interface IdentityConfig {
  /** 如 zhangsan@corp.com */
  userId?: string;
  /** 如 corp-shanghai */
  orgId?: string;
  /** 如 infra-platform */
  teamId?: string;
}

export interface ResolvedIdentity {
  deviceId: string;
  userId?: string;
  orgId?: string;
  teamId?: string;
}

let override: IdentityConfig | undefined;
let warnedLoginMismatch = false;

function nonempty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** loadConfig 在合并完成后灌入，让 settings.json / managed-settings 的 identity 生效。 */
export function setIdentityConfig(cfg: IdentityConfig | undefined): void {
  override = cfg;
}

/**
 * 登录态里的 userId：union_id 优先（跨应用稳定），没有再用后端 users 主键。
 * 不看过期——过期只影响 Authorization，凭据仍然说明「这台机器是谁登录的」。
 */
function loginUserId(): string | undefined {
  const user = getDeviceCredential()?.user;
  return nonempty(user?.unionId) ?? nonempty(user?.id);
}

/**
 * 优先级（P2 起）：飞书登录态 > 环境变量 > settings。
 * 登录态是服务端核验过的身份，env / settings 是自报的；两者不一致时以登录态为准并告警一次。
 * 这只影响客户端上报的展示字段，服务端归因只认 device.user_ref。
 */
export function getIdentity(): ResolvedIdentity {
  const claimed = nonempty(process.env.SID_CODE_IDENTITY_USER_ID) ?? nonempty(override?.userId);
  const loggedIn = loginUserId();
  if (loggedIn && claimed && claimed !== loggedIn && !warnedLoginMismatch) {
    warnedLoginMismatch = true;
    getLogger().warn(
      "IDENTITY",
      `配置的 userId（${claimed}）与飞书登录态（${loggedIn}）不一致，以登录态为准`,
    );
  }
  const userId = loggedIn ?? claimed;
  const orgId = nonempty(process.env.SID_CODE_IDENTITY_ORG_ID) ?? nonempty(override?.orgId);
  const teamId = nonempty(process.env.SID_CODE_IDENTITY_TEAM_ID) ?? nonempty(override?.teamId);
  return {
    deviceId: getOrCreateDeviceId(),
    ...(userId ? { userId } : {}),
    ...(orgId ? { orgId } : {}),
    ...(teamId ? { teamId } : {}),
  };
}

/**
 * 深度合并 identity 段。loadConfig 的浅合并会让 env 的 `{userId}` 整段盖掉文件的 `{orgId}`，
 * 必须按字段后写覆盖、空串视为未设。
 */
export function coalesceIdentity(
  ...parts: Array<IdentityConfig | undefined>
): IdentityConfig | undefined {
  const out: IdentityConfig = {};
  for (const p of parts) {
    if (!p) continue;
    const userId = nonempty(p.userId);
    const orgId = nonempty(p.orgId);
    const teamId = nonempty(p.teamId);
    if (userId) out.userId = userId;
    if (orgId) out.orgId = orgId;
    if (teamId) out.teamId = teamId;
  }
  return out.userId || out.orgId || out.teamId ? out : undefined;
}

/** 仅测试：清掉进程内所有身份缓存（deviceId / 凭据 / git / override）。 */
export function __resetIdentityForTest(): void {
  override = undefined;
  warnedLoginMismatch = false;
  __resetDeviceIdCacheForTest();
  __resetGitSnapshotForTest();
  __resetCredentialCacheForTest();
}

export { getOrCreateDeviceId, __resetDeviceIdCacheForTest } from "./device-id.ts";
export { getGitSnapshot, __resetGitSnapshotForTest, type GitSnapshot } from "./git-snapshot.ts";
export {
  getDeviceCredential,
  getUsableCredentialToken,
  applyDeviceAuth,
  saveDeviceCredential,
  clearDeviceCredential,
  isCredentialExpired,
  RELOGIN_HINT,
  __resetCredentialCacheForTest,
  type DeviceCredential,
  type CredentialUser,
} from "./credential.ts";
