/**
 * 企业登录状态：采集 + 渲染（登录闭环方案 §5.4）。
 *
 * 从 cli 的 `auth status` 下沉到 core，让 CLI（`sid-code auth status`）与 TUI（`/whoami`、
 * `/status`）共用同一份判断与文案，不各写一套再各自漂移。
 * 渲染只返回行数组，不直接 console.log：TUI 要把它放进命令结果，CLI 自己逐行打印。
 */

import { resolveBackendUrl } from "./backend-url.ts";
import { verifyCredentialRemote } from "./cli-login.ts";
import { getDeviceCredential, isCredentialExpired } from "./credential.ts";
import { getOrCreateDeviceId } from "./device-id.ts";

/** 没配 backend.url 时的统一提示（CLI 与 TUI 同文案）。 */
export const NO_BACKEND_HINT =
  "未配置后端地址。设置环境变量 SID_CODE_BACKEND_URL，或在 ~/.sid-code/settings.json 写\n" +
  '  { "backend": { "url": "https://<你的后端>/traj" } }';

export interface LoginStatus {
  backendUrl: string | null;
  backendSource: string | null;
  loggedIn: boolean;
  user: { id?: string; name?: string; unionId?: string } | null;
  /** 登录（签发）时间，取凭据文件的 enrolled_at */
  enrolledAt: string | null;
  /** 本地记录的过期时间：登录时的快照，服务端滑动续期后不会更新，仅供参考 */
  expiresAt: string | null;
  /** 本地快照已过期。不代表服务端失效，以 --verify 为准 */
  expired: boolean;
  deviceId: string;
  /** 仅 --verify：ok / unauthorized / error / skipped */
  remote?: string;
  remoteDetail?: string;
  /** 仅 --verify 且服务端返回：组织 / 团队 */
  orgId?: string;
  teamId?: string;
}

export interface CollectLoginStatusOptions {
  verify?: boolean;
  fetchImpl?: typeof fetch;
}

function pickId(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const v = (body as Record<string, unknown>)[key];
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

export async function collectLoginStatus(
  opts: CollectLoginStatusOptions = {},
): Promise<LoginStatus> {
  const backend = resolveBackendUrl();
  const cred = getDeviceCredential();
  const expired = cred ? isCredentialExpired(cred) : false;
  const status: LoginStatus = {
    backendUrl: backend?.url ?? null,
    backendSource: backend?.source ?? null,
    // 注册码流程签发的凭据没有 user 段，也算「已登录（设备）」，只是没绑到人。
    // 本地 expiresAt 已过不算登出（B1）：服务端滑动续期，凭据仍会照常携带，失效只认服务端 401
    loggedIn: cred !== null,
    user: cred?.user ?? null,
    enrolledAt: cred?.enrolledAt ?? null,
    expiresAt: cred?.expiresAt ?? null,
    expired,
    deviceId: getOrCreateDeviceId(),
  };
  if (opts.verify) {
    // 本地过期也要核验（B3）：本地快照过期时服务端往往仍有效，跳过核验用户就无从自查
    if (!backend || !cred) {
      status.remote = "skipped";
    } else {
      const r = await verifyCredentialRemote(backend.url, cred.credential, opts.fetchImpl);
      status.remote = r.kind;
      if (r.kind === "unauthorized") status.loggedIn = false;
      if (r.kind === "error") status.remoteDetail = r.detail;
      if (r.kind === "ok") {
        const orgId = pickId(r.body, "org_id");
        const teamId = pickId(r.body, "team_id");
        if (orgId) status.orgId = orgId;
        if (teamId) status.teamId = teamId;
      }
    }
  }
  return status;
}

/** 展示用的登录人：名字 > union_id > id。 */
export function displayLoginUser(st: Pick<LoginStatus, "user">): string | undefined {
  return st.user?.name ?? st.user?.unionId ?? st.user?.id;
}

export interface RenderLoginStatusOptions {
  /** 未登录时提示用哪个命令：CLI 是 sid-code auth login，TUI 是 /login */
  loginHint?: string;
  /** 「加 --verify 确认」里的命令写法 */
  verifyHint?: string;
}

/** 渲染登录段。与 `sid-code auth status` 原有输出逐行一致（新增的组织 / 团队行只在 --verify 有值时出现）。 */
export function renderLoginStatus(st: LoginStatus, opts: RenderLoginStatusOptions = {}): string[] {
  const loginHint = opts.loginHint ?? "sid-code auth login";
  const verifyHint = opts.verifyHint ?? "--verify";
  const lines: string[] = ["企业登录:", ""];
  lines.push(
    `  后端地址:     ${st.backendUrl ? `${st.backendUrl}（来源 ${st.backendSource}）` : "(未配置)"}`,
  );
  if (st.user) {
    const who = displayLoginUser(st);
    lines.push(`  登录用户:     ${who}${st.user.unionId ? `（union_id ${st.user.unionId}）` : ""}`);
  } else {
    lines.push(`  登录用户:     ${st.loggedIn ? "(设备凭据未绑定到人)" : "(未登录)"}`);
  }
  if (st.enrolledAt) lines.push(`  登录时间:     ${st.enrolledAt}`);
  if (st.expiresAt) {
    // 不写死天数：TTL 由企业后端配置，客户端写死就会和服务端漂移
    const note = st.expired
      ? `（本地记录已过；服务端每次使用自动顺延，加 ${verifyHint} 确认）`
      : "（本地记录；服务端每次使用自动顺延，以服务端为准）";
    lines.push(`  凭据过期:     ${st.expiresAt}${note}`);
  }
  lines.push(`  设备 ID:      ${st.deviceId}`);
  if (st.orgId) lines.push(`  组织:         ${st.orgId}`);
  if (st.teamId) lines.push(`  团队:         ${st.teamId}`);
  if (st.remote === "ok") {
    lines.push(
      st.expired
        ? "  服务端核验:   ✓ 本地记录已过期，但服务端确认仍有效"
        : "  服务端核验:   ✓ 凭据有效",
    );
  }
  if (st.remote === "unauthorized") lines.push("  服务端核验:   ✗ 401 凭据已失效或被吊销");
  if (st.remote === "error") lines.push(`  服务端核验:   ? 无法确认（${st.remoteDetail}）`);
  if (!st.loggedIn && st.backendUrl) {
    lines.push("", `  提示: 请执行 ${loginHint}`);
  }
  lines.push("");
  return lines;
}

/**
 * `/status` 末尾那一段的一行摘要。没配 backend.url 返回 null（个人用户不显示这段）。
 * 不发网络请求。
 */
export function summarizeLoginStatus(st: LoginStatus): string | null {
  if (!st.backendUrl) return null;
  if (!st.loggedIn) return "未登录，执行 /login";
  const who = displayLoginUser(st) ?? "(设备凭据未绑定到人)";
  return st.expiresAt ? `${who}（凭据记录有效至 ${st.expiresAt}）` : who;
}
