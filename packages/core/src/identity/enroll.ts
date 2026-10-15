/**
 * D2：注册码通道——一次性注册码换设备凭据（没有飞书 / 无浏览器的机器，如 CI、共享构建机）。
 *
 * 与 cli-login.ts（飞书身份）并列的第二条设备注册通道：这里换来的凭据**不带 user 段**——
 * 设备没有绑定到人（服务端只记设备与组织 / 团队，归因 `device.user_ref` 为空）。
 *
 * 流程：POST {backend}/api/v1/ctl/enroll，头 `X-Enroll-Token: <码>`，
 * 体 {device_id, org_id, team_id?, platform, ver}；成功后凭据落盘（0o600，见 credential.ts）。
 *
 * 失败语义（服务端契约）：403 = 注册端点未开启（CTL_ENROLL_ENABLED=false）；
 * 401 = 码无效 / 已用过 / 已过期 / 组织不匹配；409 = 设备已在别的组织或已绑定用户
 * （注册码不能覆盖已绑人的设备，防「知道别人 device_id 就能踢人下线」）。
 * 客户端把状态码翻译成可操作的中文提示，不把英文 detail 当主文案。
 */

import { getOrCreateDeviceId } from "./device-id.ts";
import { saveDeviceCredential } from "./credential.ts";
import { backendUrl as endpointUrl } from "./endpoints.ts";
import { readDetail } from "./cli-login.ts";

const ENROLL_TIMEOUT_MS = 15_000;

export class EnrollError extends Error {
  constructor(
    message: string,
    /** 机器可读原因，测试与 --json 输出用 */
    readonly reason:
      | "disabled"
      | "rejected"
      | "conflict"
      | "network"
      | "server_error"
      | "bad_response",
  ) {
    super(message);
    this.name = "EnrollError";
  }
}

export interface EnrollOptions {
  /** 管理员签发的一次性注册码 */
  code: string;
  /** 码绑定的组织 slug；服务端校验与码一致，对不上按无效码处理（401） */
  orgId: string;
  /** 可选：进哪个团队；码已绑团队且不一致时服务端拒绝 */
  teamId?: string;
  /** 客户端版本号，进请求体 */
  version?: string;
}

export interface EnrollResult {
  deviceId: string;
  orgId: string;
  teamId: string;
  expiresAt?: string;
}

/**
 * 用注册码换设备凭据并落盘。成功后凭据即可用于控制面（/ctl/*）。
 * 导出给测试单独覆盖各状态码分支。
 */
export async function performCodeEnroll(
  backendUrl: string,
  opts: EnrollOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<EnrollResult> {
  const deviceId = getOrCreateDeviceId();
  let resp: Response;
  try {
    resp = await fetchImpl(endpointUrl(backendUrl, "enroll"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Enroll-Token": opts.code,
      },
      body: JSON.stringify({
        device_id: deviceId,
        org_id: opts.orgId,
        ...(opts.teamId ? { team_id: opts.teamId } : {}),
        platform: `${process.platform}-${process.arch}`,
        ver: opts.version ?? "",
      }),
      signal: AbortSignal.timeout(ENROLL_TIMEOUT_MS),
    });
  } catch (err) {
    throw new EnrollError(`无法连接后端：${(err as Error).message}`, "network");
  }

  if (resp.status === 403) {
    // 开关默认关闭（CTL_ENROLL_ENABLED=false）：不是用户操作问题，要指向管理员。
    throw new EnrollError(
      "服务端未开启注册端点（CTL_ENROLL_ENABLED=false），请联系管理员打开后重试。",
      "disabled",
    );
  }
  if (resp.status === 401) {
    throw new EnrollError(
      "注册码无效、已被使用或已过期（一次性码，且 24 小时内有效）。请向管理员重新申请。",
      "rejected",
    );
  }
  if (resp.status === 409) {
    throw new EnrollError(
      `这台设备无法用注册码注册（${await readDetail(resp)}）。` +
        "若设备已绑定其他用户，先执行 sid-code auth logout 解绑；若已在其它组织，请联系管理员调整归属。",
      "conflict",
    );
  }
  if (!resp.ok) {
    throw new EnrollError(`后端返回错误：${await readDetail(resp)}`, "server_error");
  }

  let json: Record<string, unknown>;
  try {
    json = (await resp.json()) as Record<string, unknown>;
  } catch {
    throw new EnrollError("后端响应不是 JSON", "bad_response");
  }
  const credential = typeof json.credential === "string" ? json.credential.trim() : "";
  if (!credential) throw new EnrollError("后端响应缺少 credential", "bad_response");
  const expiresAt = typeof json.expires_at === "string" ? json.expires_at : undefined;
  // 组织 / 团队以服务端响应为准（码可能自带团队绑定，客户端不猜）
  const orgId = typeof json.org_id === "string" && json.org_id !== "" ? json.org_id : opts.orgId;
  const teamId = typeof json.team_id === "string" ? json.team_id : "";
  saveDeviceCredential({
    credential,
    ...(expiresAt ? { expiresAt } : {}),
    enrolledAt: new Date().toISOString(),
  });
  return { deviceId, orgId, teamId, ...(expiresAt ? { expiresAt } : {}) };
}
