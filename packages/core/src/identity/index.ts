/**
 * 身份最小可用档（M1）。
 *
 * 只做「可注入」，不做登录。userId / orgId / teamId 来自环境变量或 managed / user settings；
 * deviceId 是本机持久 UUID。自建账号明确不做。
 *
 * 优先级：环境变量 > setIdentityConfig（loadConfig 从 settings 灌进来的值）。
 * SID_CODE_TRACE_USER_ID / SID_CODE_TRACE_DEVICE_ID 是轨迹上传专用覆盖，不进本函数——
 * 四方落盘（事件 / 轨迹 / 账本 / hook）必须共用 getIdentity()，才能切片守恒。
 */

import { getOrCreateDeviceId, __resetDeviceIdCacheForTest } from "./device-id.ts";
import { __resetGitSnapshotForTest } from "./git-snapshot.ts";
import { __resetCredentialCacheForTest } from "./credential.ts";

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

function nonempty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** loadConfig 在合并完成后灌入，让 settings.json / managed-settings 的 identity 生效。 */
export function setIdentityConfig(cfg: IdentityConfig | undefined): void {
  override = cfg;
}

export function getIdentity(): ResolvedIdentity {
  const userId = nonempty(process.env.SID_CODE_IDENTITY_USER_ID) ?? nonempty(override?.userId);
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
  __resetCredentialCacheForTest,
  type DeviceCredential,
} from "./credential.ts";
