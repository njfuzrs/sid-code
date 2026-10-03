/**
 * P2：CLI 飞书登录（后端代理授权码 + 本地回环）。
 *
 * 流程（对应设计文档 §5.2）：
 *   1. 本地生成 verifier V、challenge C=S256(V)、cli_state s
 *   2. 起 127.0.0.1:P 回调服务器（复用 MCP 的 oauth-callback-server）
 *   3. 浏览器打开 {backend}/api/v1/auth/feishu/cli/start?port=P&challenge=C&cli_state=s&device_id=D
 *   4. 后端走完飞书授权，302 回 http://127.0.0.1:P/callback?code=L&state=s
 *   5. 校验 state==s（防登录 CSRF：别人把他的登录码塞给你）
 *   6. POST {backend}/api/v1/auth/cli/exchange {code:L, verifier:V, device_id, platform, ver}
 *   7. saveDeviceCredential()，凭据里带上 user 段
 *
 * 本地 PKCE 防的是同机其他进程截获 L：截到 L 拿不到 V，换不出凭据。
 * 网络与浏览器都可注入，单测不碰真实网络。
 */

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { startCallbackServer } from "../mcp/oauth-callback-server.ts";
import { getOrCreateDeviceId } from "./device-id.ts";
import {
  clearDeviceCredential,
  getDeviceCredential,
  getUsableCredentialToken,
  saveDeviceCredential,
  type CredentialUser,
  type DeviceCredential,
} from "./credential.ts";
import { backendApiUrl } from "./backend-url.ts";

/** 等用户在浏览器里完成飞书授权的上限。后端 state 10 分钟过期，这里留出余量。 */
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const EXCHANGE_TIMEOUT_MS = 15_000;

export class CliLoginError extends Error {
  constructor(
    message: string,
    /** 机器可读原因，测试与 --json 输出用 */
    readonly reason:
      | "state_mismatch"
      | "callback_error"
      | "timeout"
      | "device_conflict"
      | "rejected"
      | "server_error"
      | "network"
      | "bad_response",
  ) {
    super(message);
    this.name = "CliLoginError";
  }
}

export interface CliLoginDeps {
  /** 打开浏览器；返回 false 表示没能打开（调用方已经把 URL 打印出来了） */
  openBrowser?: (url: string) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  /** 拿到授权 URL 后回调（CLI 用它打印 URL，方便无法自动打开浏览器时手动复制） */
  onAuthorizeUrl?: (url: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 客户端版本号，进 exchange 请求体 */
  version?: string;
}

export interface CliLoginResult {
  user?: CredentialUser;
  expiresAt?: string;
  deviceId: string;
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** 构造 cli/start 地址。导出给测试断言参数齐全。 */
export function buildCliStartUrl(
  backendUrl: string,
  params: { port: number; challenge: string; cliState: string; deviceId: string },
): string {
  const u = new URL(backendApiUrl(backendUrl, "/auth/feishu/cli/start"));
  u.searchParams.set("port", String(params.port));
  u.searchParams.set("challenge", params.challenge);
  u.searchParams.set("challenge_method", "S256");
  u.searchParams.set("cli_state", params.cliState);
  u.searchParams.set("device_id", params.deviceId);
  return u.toString();
}

/** 跨平台打开浏览器。参数走数组，不经 shell，URL 里的 & 不会被解释。 */
export async function defaultOpenBrowser(url: string): Promise<boolean> {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

function parseExchangeUser(raw: unknown): CredentialUser | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const s = (v: unknown) =>
    typeof v === "string" && v.trim() !== ""
      ? v.trim()
      : typeof v === "number" && Number.isFinite(v)
        ? String(v)
        : undefined;
  const user: CredentialUser = {
    id: s(rec.id),
    name: s(rec.name),
    unionId: s(rec.union_id) ?? s(rec.unionId),
  };
  return user.id || user.name || user.unionId ? user : undefined;
}

async function readDetail(resp: Response): Promise<string> {
  try {
    const body = (await resp.json()) as { detail?: unknown };
    if (typeof body?.detail === "string") return body.detail;
    if (body?.detail !== undefined) return JSON.stringify(body.detail);
  } catch {
    /* 非 JSON */
  }
  return `HTTP ${resp.status}`;
}

/** 用登录码 + verifier 换设备凭据。导出给测试单独覆盖各状态码分支。 */
export async function exchangeLoginCode(
  backendUrl: string,
  body: { code: string; verifier: string; deviceId: string; version?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceCredential> {
  let resp: Response;
  try {
    resp = await fetchImpl(backendApiUrl(backendUrl, "/auth/cli/exchange"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        code: body.code,
        verifier: body.verifier,
        device_id: body.deviceId,
        platform: `${process.platform}-${process.arch}`,
        ver: body.version ?? "",
      }),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CliLoginError(`无法连接后端：${(err as Error).message}`, "network");
  }

  if (resp.status === 409) {
    throw new CliLoginError(
      `这台设备已绑定给另一个用户（${await readDetail(resp)}）。` +
        "请原用户先执行 sid-code auth logout 解绑，或联系管理员处理。",
      "device_conflict",
    );
  }
  if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
    throw new CliLoginError(
      `后端拒绝了登录（${await readDetail(resp)}）。登录码 60 秒内有效且只能用一次，请重新执行 sid-code auth login。`,
      "rejected",
    );
  }
  if (!resp.ok) {
    throw new CliLoginError(`后端返回错误：${await readDetail(resp)}`, "server_error");
  }

  let json: Record<string, unknown>;
  try {
    json = (await resp.json()) as Record<string, unknown>;
  } catch {
    throw new CliLoginError("后端响应不是 JSON", "bad_response");
  }
  const credential = typeof json.credential === "string" ? json.credential.trim() : "";
  if (!credential) throw new CliLoginError("后端响应缺少 credential", "bad_response");
  const expiresAt = typeof json.expires_at === "string" ? json.expires_at : undefined;
  const user = parseExchangeUser(json.user);
  return {
    credential,
    ...(expiresAt ? { expiresAt } : {}),
    enrolledAt: new Date().toISOString(),
    ...(user ? { user } : {}),
  };
}

/** 完整登录流程。成功后凭据已落盘。 */
export async function performCliLogin(
  backendUrl: string,
  deps: CliLoginDeps = {},
): Promise<CliLoginResult> {
  const { verifier, challenge } = generatePkce();
  const cliState = randomBytes(24).toString("base64url");
  const deviceId = getOrCreateDeviceId();

  const server = await startCallbackServer();
  // 回调服务器与它的超时计时器都 unref()（为 TUI 内的 MCP OAuth 设计，不阻止进程退出）。
  // 独立 CLI 进程里没有别的东西撑着事件循环 —— 不加这个保活句柄，`sid-code login`
  // 会在浏览器回调之前就以 exit 0 静默退出（编译产物端到端实测；bun test 撑着循环所以单测看不见）。
  const keepAlive = setInterval(() => {}, 1 << 30);
  try {
    const authorizeUrl = buildCliStartUrl(backendUrl, {
      port: server.port,
      challenge,
      cliState,
      deviceId,
    });
    deps.onAuthorizeUrl?.(authorizeUrl);
    // SSH 远程机器上打开的是服务器自己的浏览器，没意义：只打印 URL，用户在本机浏览器打开。
    // 注意回调是 127.0.0.1，远程场景需要 `ssh -L <port>:127.0.0.1:<port>` 转发。
    const skipBrowser = process.env.SID_CODE_NO_BROWSER === "1";
    if (!skipBrowser) await (deps.openBrowser ?? defaultOpenBrowser)(authorizeUrl);

    let code: string;
    try {
      code = await server.waitForCode(cliState, deps.timeoutMs ?? LOGIN_TIMEOUT_MS, deps.signal);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("state 不匹配")) {
        throw new CliLoginError(
          "回调的 state 与本次登录不一致，已拒绝（可能是别人构造的登录链接）。请重新登录。",
          "state_mismatch",
        );
      }
      if (msg.includes("超时")) {
        throw new CliLoginError("等待浏览器授权超时，请重新执行 sid-code auth login。", "timeout");
      }
      throw new CliLoginError(`授权失败：${msg}`, "callback_error");
    }

    const cred = await exchangeLoginCode(
      backendUrl,
      { code, verifier, deviceId, version: deps.version },
      deps.fetchImpl,
    );
    saveDeviceCredential(cred);
    return { user: cred.user, expiresAt: cred.expiresAt, deviceId };
  } finally {
    clearInterval(keepAlive);
    server.close();
  }
}

export interface CliLogoutResult {
  /** 本地本来就有凭据 */
  hadCredential: boolean;
  /** 服务端解绑结果：ok / 端点不存在（旧后端）/ 失败 / 没调（无后端或无凭据） */
  remote: "ok" | "unsupported" | "failed" | "skipped";
  remoteDetail?: string;
}

/**
 * 登出：先尽力通知后端解绑设备（让换人登录不再撞 409），再删本地凭据。
 * 后端失败不阻止本地删除——本地凭据删了，这台机器就不再以该用户身份上报。
 */
export async function performCliLogout(
  backendUrl: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<CliLogoutResult> {
  const hadCredential = getDeviceCredential() !== null;
  const token = getUsableCredentialToken();
  let remote: CliLogoutResult["remote"] = "skipped";
  let remoteDetail: string | undefined;
  if (backendUrl && token) {
    try {
      const resp = await fetchImpl(backendApiUrl(backendUrl, "/auth/cli/logout"), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      });
      if (resp.ok || resp.status === 401) {
        // 401 = 凭据已经失效，服务端那侧本来就不认它了，等价于解绑完成
        remote = "ok";
      } else if (resp.status === 404 || resp.status === 405) {
        remote = "unsupported";
      } else {
        remote = "failed";
        remoteDetail = `HTTP ${resp.status}`;
      }
    } catch (err) {
      remote = "failed";
      remoteDetail = (err as Error).message;
    }
  }
  clearDeviceCredential();
  return { hadCredential, remote, ...(remoteDetail ? { remoteDetail } : {}) };
}

export type WhoAmIOutcome =
  | { kind: "ok"; body: unknown }
  | { kind: "unauthorized" }
  | { kind: "error"; detail: string };

/** `auth status --verify`：调 /ctl/whoami 自证凭据仍有效（能发现服务端吊销）。 */
export async function verifyCredentialRemote(
  backendUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WhoAmIOutcome> {
  try {
    const resp = await fetchImpl(backendApiUrl(backendUrl, "/ctl/whoami"), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
    if (resp.status === 401) return { kind: "unauthorized" };
    if (!resp.ok) return { kind: "error", detail: `HTTP ${resp.status}` };
    return { kind: "ok", body: await resp.json().catch(() => null) };
  } catch (err) {
    return { kind: "error", detail: (err as Error).message };
  }
}
