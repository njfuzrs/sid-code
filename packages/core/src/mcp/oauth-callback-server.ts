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
   */
  waitForCode(expectedState: string, timeoutMs: number, signal?: AbortSignal): Promise<string>;
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

  let resolveCode: ((code: string) => void) | undefined;
  let rejectCode: ((err: Error) => void) | undefined;
  let server: Server | null = null;
  let closed = false;

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

  server = createServer((req, res) => {
    const parsed = parseUrl(req.url || "", true);
    if (parsed.pathname !== "/callback") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const error = parsed.query.error as string | undefined;
    const errorDesc = parsed.query.error_description as string | undefined;
    const code = parsed.query.code as string | undefined;
    const state = parsed.query.state as string | undefined;

    if (error) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<h1>授权失败</h1><p>${escapeHtml(error)}: ${escapeHtml(errorDesc || "")}</p><p>可关闭此窗口。</p>`);
      close();
      rejectCode?.(new Error(`OAuth 错误: ${error} - ${errorDesc || ""}`));
      return;
    }

    if (!code) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<h1>缺少授权码</h1><p>可关闭此窗口并重试。</p>`);
      return;
    }

    // state 传递给 waitForCode 做校验（这里先回复浏览器）
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<h1>授权成功</h1><p>可关闭此窗口，返回 sid-code。</p>`);

    // resolve（state 校验在 waitForCode 中进行，这里传出 code+state 对）
    resolveCode?.(`${code}\x00${state || ""}`);
    close();
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    close();
    rejectCode?.(new Error(`OAuth 回调服务器错误: ${err.message}`));
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
    waitForCode(expectedState: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
      return new Promise((resolve, reject) => {
        resolveCode = (raw: string) => {
          const [code, state] = raw.split("\x00");
          if (state !== expectedState) {
            close();
            reject(new Error("OAuth state 不匹配（可能是 CSRF 攻击）"));
            return;
          }
          resolve(code);
        };
        rejectCode = reject;

        // 超时
        const timer = setTimeout(() => {
          close();
          reject(new Error("等待 OAuth 授权超时"));
        }, timeoutMs);
        (timer as any).unref?.();

        // abort 信号
        if (signal) {
          if (signal.aborted) {
            close();
            reject(new Error("OAuth 授权已取消"));
            return;
          }
          const onAbort = () => {
            close();
            reject(new Error("OAuth 授权已取消"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    },
    close,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
