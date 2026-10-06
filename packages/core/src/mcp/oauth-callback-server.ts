/**
 * MCP OAuth 本地回调服务器
 *
 * 在 localhost 启动 HTTP 服务器，监听 /callback 路径接收授权码。
 * 对标 Claude Code oauthPort.ts + performMCPOAuthFlow 中 createServer 片段。
 *
 * 设计：
 * - 随机或指定端口（RFC 8252 §7.3：loopback 重定向可用任意端口）
 * - CSRF state 校验（授权服务器回传的 state 必须匹配发出时的值）
 * - 超时 + abort 信号清理
 * - 仅绑定 127.0.0.1（不暴露到外网）
 */

import { createServer, type Server } from "node:http";
import { parse as parseUrl } from "node:url";
import { getLogger } from "../debug/logger.ts";

/** 端口范围（非 Windows 平台，对标 CC） */
const PORT_RANGE_MIN = 49152;
const PORT_RANGE_MAX = 65535;
const FALLBACK_PORT = 3118;
const MAX_PORT_ATTEMPTS = 100;

/**
 * RFC 9207 `iss` 校验参数。
 * - expectedIss：授权服务器元数据里的 issuer。回调带了 `iss` 时必须逐字相等。
 * - issRequired：元数据声明 `authorization_response_iss_parameter_supported: true` 时为真，
 *   此时回调**缺** `iss` 也判失败（否则攻击者只要删掉参数就绕过校验）。
 */
export interface IssuerCheck {
  expectedIss?: string;
  issRequired?: boolean;
}

/** 回调服务器句柄 */
export interface CallbackServerHandle {
  /** 回调 redirect URI（含端口，如 http://localhost:52341/callback） */
  redirectUri: string;
  /** 实际监听端口 */
  port: number;
  /**
   * 等待授权码到达（阻塞 Promise）。
   * @param expectedState 发出授权请求时生成的 CSRF state
   * @param timeoutMs 超时毫秒
   * @param signal 外部 abort 信号
   * @param issuer RFC 9207 iss 校验（D19）
   */
  waitForCode(
    expectedState: string,
    timeoutMs: number,
    signal?: AbortSignal,
    issuer?: IssuerCheck,
  ): Promise<string>;
  /** 手动关闭服务器（不论是否已收到回调） */
  close(): void;
}

/**
 * 探测端口是否可用（用 createServer 短暂绑定后释放）。
 * Bun 下 createServer listen(0) 可直接拿随机端口，但为了与 CC 保持一致的
 * 「固定端口优先」行为，这里保留显式探测。
 */
async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

/** 找到一个空闲端口（配置端口 > 随机尝试 > 回退端口） */
async function findAvailablePort(configuredPort?: number): Promise<number> {
  if (configuredPort) {
    if (await isPortAvailable(configuredPort)) return configuredPort;
    getLogger().warn("MCP", `配置的 OAuth 回调端口 ${configuredPort} 不可用，回退随机选取`);
  }
  const range = PORT_RANGE_MAX - PORT_RANGE_MIN + 1;
  for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
    const port = PORT_RANGE_MIN + Math.floor(Math.random() * range);
    if (await isPortAvailable(port)) return port;
  }
  if (await isPortAvailable(FALLBACK_PORT)) return FALLBACK_PORT;
  throw new Error("无可用端口用于 OAuth 回调");
}

/**
 * 启动本地 OAuth 回调服务器。
 * 返回句柄，调用方用 waitForCode 等待授权码，结束后 close。
 */
export async function startCallbackServer(configuredPort?: number): Promise<CallbackServerHandle> {
  const port = await findAvailablePort(configuredPort);
  const redirectUri = `http://localhost:${port}/callback`;

  /**
   * 当前这一次 waitForCode 的期望值与结算函数。
   *
   * D20/D22：state 校验必须在**回复浏览器之前、且在请求处理里**完成。原先是
   * 「先回『授权成功』→ close() → 再在 waitForCode 里比 state」，于是：
   *   ① 疑似 CSRF 时浏览器显示成功、CLI 报错，两边说相反的话；
   *   ② 任何本地进程往端口发一个 state 错的请求就能 close 掉服务器、打断真授权（DoS）。
   * 现在只有 state 对得上的请求才能结算这次等待；对不上的回失败页、服务器继续等。
   */
  let pending:
    | {
        expectedState: string;
        issuer?: IssuerCheck;
        resolve: (code: string) => void;
        reject: (err: Error) => void;
      }
    | undefined;
  let server: Server | null = null;
  let closed = false;
  /** 本次等待期间被忽略的 state 不匹配回调数（超时报错时带上，便于调用方归因） */
  let stateMismatches = 0;

  const close = () => {
    if (closed) return;
    closed = true;
    if (server) {
      server.removeAllListeners();
      server.on("error", () => {}); // 防 close 后的迟到错误
      server.close();
      server = null;
    }
  };

  const reply = (res: import("node:http").ServerResponse, status: number, html: string) => {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  };

  server = createServer((req, res) => {
    const parsed = parseUrl(req.url || "", true);
    if (parsed.pathname !== "/callback") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    // 重复参数（?state=a&state=b）解析成数组 → 视为缺失，不取其中任一个
    const one = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
    const error = one(parsed.query.error);
    const errorDesc = one(parsed.query.error_description);
    const code = one(parsed.query.code);
    const state = one(parsed.query.state);
    const iss = one(parsed.query.iss);

    const current = pending;
    if (!current) {
      reply(res, 409, `<h1>授权失败</h1><p>sid-code 当前没有在等待授权回调。</p>`);
      return;
    }

    // state 不对（含缺失、重复参数）→ 不属于这次授权：回失败页，**不结算、不关闭**。
    // 授权服务器的 error 回调同样带 state（RFC 6749 §4.1.2.1），也必须先过这一关，
    // 否则伪造一个 ?error=x 就能打断流程。
    if (state !== current.expectedState) {
      stateMismatches++;
      getLogger().warn("MCP", "OAuth 回调 state 不匹配，已忽略该请求，继续等待真实回调");
      reply(
        res,
        400,
        `<h1>授权失败</h1><p>回调 state 校验未通过（可能是伪造请求或过期链接）。请回到 sid-code 查看状态。</p>`,
      );
      return;
    }

    // D19：RFC 9207 混淆攻击防护。state 已证明「是我发出的那次请求」，iss 再证明
    // 「回应来自我期望的那个授权服务器」。state 对而 iss 错是真实的攻击 / 配置错误信号，
    // 直接终结流程（不是伪造噪声，没必要继续等）。
    const issErr = checkIssuer(iss, current.issuer);
    if (issErr) {
      reply(res, 400, `<h1>授权失败</h1><p>${escapeHtml(issErr)}</p><p>可关闭此窗口。</p>`);
      pending = undefined;
      close();
      current.reject(new Error(`OAuth ${issErr}`));
      return;
    }

    if (error) {
      reply(
        res,
        200,
        `<h1>授权失败</h1><p>${escapeHtml(error)}: ${escapeHtml(errorDesc || "")}</p><p>可关闭此窗口。</p>`,
      );
      pending = undefined;
      close();
      current.reject(new Error(`OAuth 错误: ${error} - ${errorDesc || ""}`));
      return;
    }

    if (!code) {
      // 宽容：不结算，继续等（与 state 不匹配同一策略，见 D20-缺陷4）
      reply(res, 400, `<h1>缺少授权码</h1><p>可关闭此窗口并重试。</p>`);
      return;
    }

    // 全部校验通过，才告诉用户成功
    reply(res, 200, `<h1>授权成功</h1><p>可关闭此窗口，返回 sid-code。</p>`);
    pending = undefined;
    close();
    current.resolve(code);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    close();
    const current = pending;
    pending = undefined;
    current?.reject(new Error(`OAuth 回调服务器错误: ${err.message}`));
  });

  // 绑定到 127.0.0.1（不暴露）
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(port, "127.0.0.1", () => resolve());
  });
  // 取消事件循环引用——不阻止进程退出
  server.unref();

  return {
    redirectUri,
    port,
    waitForCode(
      expectedState: string,
      timeoutMs: number,
      signal?: AbortSignal,
      issuer?: IssuerCheck,
    ): Promise<string> {
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        };
        const fail = (err: Error) => {
          cleanup();
          pending = undefined;
          close();
          reject(err);
        };

        if (signal?.aborted) {
          fail(new Error("OAuth 授权已取消"));
          return;
        }

        pending = {
          expectedState,
          issuer,
          resolve: (code) => {
            cleanup();
            resolve(code);
          },
          reject: (err) => {
            cleanup();
            reject(err);
          },
        };

        stateMismatches = 0;
        timer = setTimeout(
          () =>
            fail(
              new Error(
                stateMismatches > 0
                  ? `等待 OAuth 授权超时（期间收到 ${stateMismatches} 次 state 不匹配的回调，已忽略）`
                  : "等待 OAuth 授权超时",
              ),
            ),
          timeoutMs,
        );
        (timer as any).unref?.();

        if (signal) {
          onAbort = () => fail(new Error("OAuth 授权已取消"));
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    },
    close,
  };
}

/** RFC 9207 §2.4 校验；通过返回 undefined，否则返回失败原因 */
function checkIssuer(iss: string | undefined, check: IssuerCheck | undefined): string | undefined {
  if (!check) return undefined;
  if (iss === undefined) {
    return check.issRequired ? "授权响应缺少 iss 参数（授权服务器声明了必须携带）" : undefined;
  }
  if (check.expectedIss !== undefined && iss !== check.expectedIss) {
    return "授权响应的 iss 与期望的授权服务器不一致（可能是混淆攻击）";
  }
  return undefined;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
