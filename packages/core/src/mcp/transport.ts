/**
 * MCP 传输层
 * 支持 stdio（子进程）、HTTP 和 SSE 三种传输方式
 */

import type { JsonRpcRequest, JsonRpcResponse } from "./types.ts";
import { spawn, type Subprocess } from "bun";
import { sanitizeStrings } from "../llm/sanitize-unicode.ts";
import { getLogger } from "../debug/logger.ts";

/** JSON-RPC 通知（无 id） */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

/** 传输接口 */
export interface Transport {
  send(request: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse>;
  /** 发送通知（无 id，不等响应） */
  sendNotification?(notification: JsonRpcNotification): void;
  /** 通知回调（处理无 id 的 JSON-RPC 消息） */
  onNotification?: (notification: JsonRpcNotification) => void;
  /**
   * 服务器发起请求的回调（G3 Elicitation 接线）。
   * 服务器可主动发请求（含 id + method，如 `elicitation/create`），传输层调用此回调
   * 拿到响应后回传给服务器。未注册时传输层用「方法未找到」错误应答，避免服务器悬挂。
   */
  onRequest?: (request: JsonRpcRequest) => Promise<JsonRpcResponse>;
  /** 连接关闭回调（用于断线检测） */
  onClose?: () => void;
  close(): void;
}

/**
 * 带「送达语义」的传输层错误（D15 / D27）。
 *
 * 重试是否安全取决于**请求有没有可能已经到达服务器**：超时、断流时服务器可能已经执行了，
 * 对 `tools/call` 这类非幂等请求重发就是重复执行（建了两个 issue、发了两条消息）。
 * 所以传输层只在**确定没送达**时打 `notDelivered`：传输已关闭（请求根本没写出去）、
 * 连接建立失败（POST 还没发）、HTTP 429（服务器明确拒收）。其余错误一律视为「可能已执行」。
 *
 * `retryAfterMs` 来自 429 / 503 的 `Retry-After` 头，供重试与重连退避尊重对端节奏。
 */
export class McpTransportError extends Error {
  readonly notDelivered: boolean;
  /** 重试也不会好（传输已关闭）：重试层直接放弃，别白等退避 */
  readonly terminal: boolean;
  readonly retryAfterMs?: number;
  readonly status?: number;
  constructor(
    message: string,
    opts: {
      notDelivered?: boolean;
      terminal?: boolean;
      retryAfterMs?: number;
      status?: number;
    } = {},
  ) {
    super(message);
    this.name = "McpTransportError";
    this.notDelivered = opts.notDelivered ?? false;
    this.terminal = opts.terminal ?? false;
    this.retryAfterMs = opts.retryAfterMs;
    this.status = opts.status;
  }
}

/** 重试无意义（传输已关闭） */
export function isTerminalTransportError(err: unknown): boolean {
  return err instanceof McpTransportError && err.terminal;
}

/** 请求确定没有到达服务器（重发不会造成重复执行） */
export function isNotDeliveredError(err: unknown): boolean {
  return err instanceof McpTransportError && err.notDelivered;
}

/** 对端要求的最短重试等待（ms），没有则 undefined */
export function getRetryAfterMs(err: unknown): number | undefined {
  return err instanceof McpTransportError ? err.retryAfterMs : undefined;
}

/** Retry-After 上限：超过 1 小时的值按异常处理，不采信 */
const MAX_RETRY_AFTER_MS = 3_600_000;

/** 解析 Retry-After（秒数或 HTTP-date，RFC 9110 §10.2.3） */
export function parseRetryAfterHeader(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (!v) return undefined;
  let ms: number;
  if (/^\d+$/.test(v)) {
    ms = Number(v) * 1000;
  } else {
    const at = Date.parse(v);
    if (Number.isNaN(at)) return undefined;
    ms = Math.max(0, at - now);
  }
  return ms <= MAX_RETRY_AFTER_MS ? ms : undefined;
}

/** 非 2xx 响应 → McpTransportError。429 = 服务器明确拒收，确定未执行 */
function httpStatusError(prefix: string, response: Response): McpTransportError {
  return new McpTransportError(`${prefix}: ${response.status}`, {
    status: response.status,
    notDelivered: response.status === 429,
    retryAfterMs:
      response.status === 429 || response.status === 503
        ? parseRetryAfterHeader(response.headers.get("retry-after"))
        : undefined,
  });
}

/** 已关闭传输上的 send：请求根本没写出去 */
function closedError(): McpTransportError {
  return new McpTransportError("传输已关闭", { notDelivered: true, terminal: true });
}

/** 连接建立失败：后续请求一个字节都没发出去 */
function connectFailedError(err: unknown): McpTransportError {
  if (err instanceof McpTransportError) {
    return new McpTransportError(err.message, {
      notDelivered: true,
      retryAfterMs: err.retryAfterMs,
      status: err.status,
    });
  }
  return new McpTransportError((err as Error)?.message ?? String(err), { notDelivered: true });
}

/**
 * 服务器发起请求的统一分派（D10/D12）：有 onRequest 就把结果回传，没有就回 -32601。
 * 原先每个传输各写一份，WebSocket 与进程内两份干脆漏写——对端发了带 id 的请求永远等不到应答。
 * 新传输一律走这里，别再各写一份。
 */
function dispatchServerRequest(
  onRequest: ((request: JsonRpcRequest) => Promise<JsonRpcResponse>) | undefined,
  request: JsonRpcRequest,
  respond: (response: JsonRpcResponse) => void,
): void {
  if (!onRequest) {
    respond({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: `方法未找到: ${request.method}` },
    });
    return;
  }
  onRequest(request)
    .then(respond)
    .catch((err) => {
      respond({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32603, message: `内部错误: ${err?.message ?? err}` },
      });
    });
}

/** stdio 子进程 stderr 只保留尾部这么多字符，供排查（D7：drain 必须有上限，否则把死锁换成 OOM） */
const STDERR_TAIL_MAX = 8192;

/** Stdio 传输 - 通过子进程的 stdin/stdout 通信 */
export class StdioTransport implements Transport {
  // 三路都显式声明为 "pipe"：不带泛型的 Subprocess 会把 stdin/stdout 退化成
  // `number | FileSink` / `number | ReadableStream` 联合类型（对应 inherit/fd 的情形），
  // 于是 .getReader() / .write() 全部报错。构造时传的就是 pipe，这里把它写进类型。
  private proc: Subprocess<"pipe", "pipe", "pipe">;
  private pendingRequests = new Map<
    number | string,
    {
      resolve: (resp: JsonRpcResponse) => void;
      reject: (err: Error) => void;
      // 修:请求 settle 时移除 signal 的 abort 监听器,防止成功/超时路径下监听器在
      // 共享(会话级)signal 上线性累加(每次 MCP 调用泄漏一个)。
      cleanup?: () => void;
    }
  >();
  private buffer = "";
  private closed = false;
  private timeout: number;
  /** stderr 尾部（环形截断到 STDERR_TAIL_MAX），子进程诊断信息的唯一留存处 */
  private stderrBuf = "";
  onNotification?: (notification: JsonRpcNotification) => void;
  onRequest?: (request: JsonRpcRequest) => Promise<JsonRpcResponse>;
  onClose?: () => void;

  constructor(
    command: string,
    args: string[] = [],
    env?: Record<string, string>,
    timeout?: number,
  ) {
    this.timeout = timeout ?? 30000;
    this.proc = spawn({
      cmd: [command, ...args],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...(process.env as Record<string, string>), ...env },
    });

    // 监听进程退出，立即 reject 所有 pending 请求
    this.proc.exited.then((code) => {
      if (!this.closed) {
        this.closed = true;
        const err = new Error(`MCP 子进程退出 (code=${code})`);
        for (const [, pending] of this.pendingRequests) {
          pending.cleanup?.();
          pending.reject(err);
        }
        this.pendingRequests.clear();
        this.onClose?.();
      }
    });

    // 读取 stdout 响应
    this.readLoop();
    // D7：stderr 必须持续排空。不读的话管道缓冲（典型 64KB）写满后 Server 的下一次
    // console.error 会阻塞主线程，于是 JSON-RPC 响应全部超时——Server 越守规矩把日志
    // 写 stderr、写得越详细，越容易挂。读出的内容转 debug 日志并只留尾部。
    this.drainStderr();
  }

  /** 子进程 stderr 的尾部内容（最多 STDERR_TAIL_MAX 字符） */
  get stderrTail(): string {
    return this.stderrBuf;
  }

  private async drainStderr(): Promise<void> {
    const reader = this.proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      // 不看 this.closed：close() 之后子进程可能还在写，照样要读到 EOF，否则它退出前会卡在写上
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        this.stderrBuf = (this.stderrBuf + text).slice(-STDERR_TAIL_MAX);
        getLogger().debug("MCP", `stdio stderr: ${text.slice(0, 2000)}`);
      }
    } catch {
      // 进程已关闭
    } finally {
      reader.releaseLock();
    }
  }

  private async readLoop(): Promise<void> {
    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (!this.closed) {
        const { done, value } = await reader.read();
        if (done) break;

        this.buffer += decoder.decode(value, { stream: true });
        this.processBuffer();
      }
    } catch {
      // 进程已关闭
    } finally {
      reader.releaseLock();
    }
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed);

        // 无 id 的消息是通知
        if (msg.jsonrpc === "2.0" && !("id" in msg) && msg.method) {
          this.onNotification?.(msg as JsonRpcNotification);
          continue;
        }

        // 含 id + method 的是服务器发起的请求（G3：elicitation/create 等）
        if (msg.jsonrpc === "2.0" && "id" in msg && msg.method) {
          this.handleServerRequest(msg as JsonRpcRequest);
          continue;
        }

        const response = msg as JsonRpcResponse;
        const pending = this.pendingRequests.get(response.id);
        if (pending) {
          this.pendingRequests.delete(response.id);
          pending.cleanup?.(); // 成功路径:移除 abort 监听器,防泄漏
          pending.resolve(response);
        }
      } catch {
        // 跳过非 JSON 行
      }
    }
  }

  /**
   * 处理服务器发起的请求（G3）：调用 onRequest 拿响应写回 stdin。
   * 未注册 onRequest 时用 JSON-RPC「方法未找到」(-32601) 应答，避免服务器悬挂等待。
   */
  private handleServerRequest(request: JsonRpcRequest): void {
    const respond = (response: JsonRpcResponse) => {
      if (this.closed) return;
      try {
        this.proc.stdin.write(JSON.stringify(response) + "\n");
        this.proc.stdin.flush();
      } catch {
        // 写回失败（进程已退出等），忽略
      }
    };
    dispatchServerRequest(this.onRequest, request, respond);
  }

  async send(request: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse> {
    if (this.closed) {
      throw closedError();
    }

    return new Promise((resolve, reject) => {
      // 外部取消信号:监听器 + 其清理函数一并登记,任何 settle 路径都能移除监听器。
      // D8：超时 timer 也归 cleanup 管。原先成功路径从不 clearTimeout，每次调用留一个
      // 活 timer 30s，closeAll() 之后 event loop 还要被它拖住最多 30s。
      let onAbort: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      };
      this.pendingRequests.set(request.id, { resolve, reject, cleanup });

      if (signal) {
        if (signal.aborted) {
          this.pendingRequests.delete(request.id);
          reject(new Error("用户取消"));
          return;
        }
        onAbort = () => {
          if (this.pendingRequests.has(request.id)) {
            this.pendingRequests.delete(request.id);
            cleanup();
            reject(new Error("用户取消"));
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      const data = JSON.stringify(request) + "\n";
      this.proc.stdin.write(data);
      this.proc.stdin.flush();

      // 超时
      timer = setTimeout(() => {
        const pending = this.pendingRequests.get(request.id);
        if (pending) {
          this.pendingRequests.delete(request.id);
          pending.cleanup?.(); // 超时路径:移除 abort 监听器,防泄漏
          reject(new Error(`MCP 请求超时: ${request.method}`));
        }
      }, this.timeout);
    });
  }

  sendNotification(notification: JsonRpcNotification): void {
    if (this.closed) return;
    const data = JSON.stringify(notification) + "\n";
    this.proc.stdin.write(data);
    this.proc.stdin.flush();
  }

  close(): void {
    this.closed = true;
    this.proc.kill();
    for (const [, pending] of this.pendingRequests) {
      pending.cleanup?.();
      pending.reject(new Error("传输已关闭"));
    }
    this.pendingRequests.clear();
  }
}

/** 单个 SSE 事件（event + data 已聚合） */
export interface SSEEvent {
  event: string;
  data: string;
}

/**
 * 通用 SSE 流解析（G4 抽出，供 SSETransport 与 StreamableHTTPTransport 共用）。
 *
 * 逐块读取 ReadableStream，按 SSE 规范（`event:`/`data:` 行 + 空行分隔事件）切分，
 * 每完成一个事件回调 onEvent。多行 data 用 `\n` 拼接（对齐 SSE 规范）。
 * shouldStop 返回 true 时提前结束（如传输已关闭）。
 */
export async function parseSSEStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SSEEvent) => void,
  shouldStop?: () => boolean,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType = "";
  let eventData = "";

  const flush = () => {
    if (eventData || eventType) {
      onEvent({ event: eventType || "message", data: eventData });
    }
    eventType = "";
    eventData = "";
  };

  try {
    while (!shouldStop?.()) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, ""); // 兼容 CRLF
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const chunk = line.slice(5).replace(/^ /, ""); // 去掉冒号后单个前导空格
          eventData = eventData ? `${eventData}\n${chunk}` : chunk;
        } else if (line === "") {
          flush();
        }
        // 其它字段（id:/retry: 等）忽略
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** HTTP 传输 - 通过 HTTP 请求通信 */
export class HTTPTransport implements Transport {
  private url: string;
  private headers: Record<string, string>;
  private timeout: number;
  private closed = false;
  /** close() 时 abort，用来中止在途请求（D11） */
  private closeController = new AbortController();
  onNotification?: (notification: JsonRpcNotification) => void;

  constructor(url: string, headers?: Record<string, string>, timeout?: number) {
    this.url = url;
    this.headers = headers || {};
    this.timeout = timeout ?? 30000;
  }

  async send(request: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse> {
    if (this.closed) {
      throw closedError();
    }
    const signals: AbortSignal[] = [AbortSignal.timeout(this.timeout), this.closeController.signal];
    if (signal) signals.push(signal);
    const combinedSignal = AbortSignal.any(signals);

    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify(sanitizeStrings(request)),
      signal: combinedSignal,
    });

    if (!response.ok) {
      throw httpStatusError("MCP HTTP 错误", response);
    }

    return (await response.json()) as JsonRpcResponse;
  }

  close(): void {
    // D11：原先是空实现，disconnect() 之后仍持有 client 的调用方（如重试中的请求）
    // 还能继续对已断开的 Server 发请求。现在与其它传输一致：拒绝后续请求、中止在途请求。
    this.closed = true;
    this.closeController.abort(new Error("传输已关闭"));
  }
}

/** POST 时声明同时接受 JSON 与 SSE（Streamable HTTP spec 要求，否则服务器可能回 406） */
const STREAMABLE_HTTP_ACCEPT = "application/json, text/event-stream";
/** MCP session 失效错误码（Streamable HTTP：Session not found） */
const SESSION_NOT_FOUND_CODE = -32001;

/**
 * Streamable HTTP 传输（G4，对齐 MCP 2025-03-26 规范）。
 *
 * 与旧 HTTPTransport 的差异：
 * - POST 带 `Accept: application/json, text/event-stream`（spec 要求）。
 * - 响应按 Content-Type 分流：application/json → 单 JSON；text/event-stream → 解析 SSE
 *   流，从中取匹配 request.id 的 message 事件（同时把服务器发的通知/请求路由出去）。
 * - 读响应头 `mcp-session-id` 缓存，后续请求带 `Mcp-Session-Id`（会话保持）。
 * - 收到 -32001（Session not found）→ 清 session id，让上层重新 initialize。
 *
 * 不引 @modelcontextprotocol/sdk，自研以对齐本仓既有传输层风格。
 */
export class StreamableHTTPTransport implements Transport {
  private url: string;
  private headers: Record<string, string>;
  private timeout: number;
  private closed = false;
  /** 服务器返回的会话 id，后续请求回传 */
  private sessionId: string | null = null;
  onNotification?: (notification: JsonRpcNotification) => void;
  onRequest?: (request: JsonRpcRequest) => Promise<JsonRpcResponse>;
  onClose?: () => void;

  constructor(url: string, headers?: Record<string, string>, timeout?: number) {
    this.url = url;
    this.headers = headers || {};
    this.timeout = timeout ?? 30000;
  }

  private buildHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: STREAMABLE_HTTP_ACCEPT,
      ...this.headers,
    };
    if (this.sessionId) h["Mcp-Session-Id"] = this.sessionId;
    return h;
  }

  async send(request: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse> {
    if (this.closed) {
      throw closedError();
    }

    const signals: AbortSignal[] = [AbortSignal.timeout(this.timeout)];
    if (signal) signals.push(signal);
    const combinedSignal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

    const response = await fetch(this.url, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(sanitizeStrings(request)),
      signal: combinedSignal,
    });

    // 捕获/更新会话 id（spec：initialize 响应头带 mcp-session-id）
    const newSession = response.headers.get("mcp-session-id");
    if (newSession) this.sessionId = newSession;

    if (!response.ok) {
      throw httpStatusError("MCP Streamable HTTP 错误", response);
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();

    let result: JsonRpcResponse;
    if (contentType.includes("text/event-stream") && response.body) {
      result = await this.readResponseFromSSE(response.body, request.id);
    } else {
      result = (await response.json()) as JsonRpcResponse;
    }

    // -32001 Session not found → 清 session，让上层重新 initialize（对齐 CC）
    if (result.error?.code === SESSION_NOT_FOUND_CODE) {
      this.sessionId = null;
    }
    return result;
  }

  /**
   * 从 SSE 响应流中读出匹配 targetId 的响应。
   * 期间若遇到服务器通知/服务器发起的请求，分别路由到 onNotification / onRequest。
   */
  private async readResponseFromSSE(
    body: ReadableStream<Uint8Array>,
    targetId: number | string,
  ): Promise<JsonRpcResponse> {
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      let settled = false;
      parseSSEStream(
        body,
        (evt) => {
          if (!evt.data) return;
          let msg: any;
          try {
            msg = JSON.parse(evt.data);
          } catch {
            return; // 跳过非 JSON
          }
          if (msg?.jsonrpc !== "2.0") return;

          // 无 id + method：服务器通知
          if (!("id" in msg) && msg.method) {
            this.onNotification?.(msg as JsonRpcNotification);
            return;
          }
          // 有 id + method：服务器发起的请求（elicitation/create 等）
          if ("id" in msg && msg.method) {
            this.handleServerRequest(msg as JsonRpcRequest);
            return;
          }
          // 匹配目标响应
          if ("id" in msg && msg.id === targetId) {
            settled = true;
            resolve(msg as JsonRpcResponse);
          }
        },
        () => this.closed || settled,
      )
        .then(() => {
          if (!settled) reject(new Error("Streamable HTTP SSE 流结束但未收到匹配响应"));
        })
        .catch(reject);
    });
  }

  /** 处理服务器发起的请求：调 onRequest 拿响应，经 POST 回传（无 onRequest 时回 -32601） */
  private handleServerRequest(request: JsonRpcRequest): void {
    const respond = (response: JsonRpcResponse) => {
      if (this.closed) return;
      fetch(this.url, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(sanitizeStrings(response)),
      }).catch(() => {
        /* 回传失败忽略 */
      });
    };
    dispatchServerRequest(this.onRequest, request, respond);
  }

  sendNotification(notification: JsonRpcNotification): void {
    if (this.closed) return;
    fetch(this.url, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(sanitizeStrings(notification)),
    }).catch(() => {});
  }

  close(): void {
    // 主动关闭不触发 onClose（D1）：onClose 只表示「意外断开」，
    // 五个传输里只有这里曾在 close() 中回调它，会把用户主动断开变成一次自动重连。
    this.closed = true;
    this.sessionId = null;
  }
}

/** SSE 传输 - GET 连接 SSE 流接收响应/通知，POST 发送请求 */
export class SSETransport implements Transport {
  private url: string;
  private headers: Record<string, string>;
  private timeout: number;
  private closed = false;
  private pendingRequests = new Map<
    number | string,
    {
      resolve: (resp: JsonRpcResponse) => void;
      reject: (err: Error) => void;
      // 修:请求 settle 时移除 signal 的 abort 监听器,防止在共享(会话级)signal 上累加。
      cleanup?: () => void;
    }
  >();
  private abortController: AbortController | null = null;
  /** SSE 握手后服务器返回的 POST 端点（可能是相对路径） */
  private postEndpoint: string | null = null;
  private connectPromise: Promise<void>;
  onNotification?: (notification: JsonRpcNotification) => void;
  onRequest?: (request: JsonRpcRequest) => Promise<JsonRpcResponse>;
  onClose?: () => void;

  constructor(url: string, headers?: Record<string, string>, timeout?: number) {
    this.url = url;
    this.headers = headers || {};
    this.timeout = timeout ?? 30000;
    // 启动 SSE 连接
    this.connectPromise = this.connectSSE();
    // D9：只有 send() 会 await 它。「构造后还没 send 就 close」（manager 连接超时清理恰好
    // 走这条）下 reject 无人接，成了 unhandledRejection。挂一个兜底 handler 只为标记已处理，
    // 真正的错误仍由 send() 里的 await 抛出——别把这行改成 this.connectPromise = ...catch()。
    this.connectPromise.catch(() => {});
  }

  private async connectSSE(): Promise<void> {
    this.abortController = new AbortController();

    const response = await fetch(this.url, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        ...this.headers,
      },
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      throw httpStatusError("MCP SSE 连接失败", response);
    }

    if (!response.body) {
      throw new Error("MCP SSE 响应无 body");
    }

    // 后台读取 SSE 流
    this.readSSEStream(response.body);
  }

  private async readSSEStream(body: ReadableStream<Uint8Array>): Promise<void> {
    // D5：改用共用解析器 parseSSEStream。旧的私有实现要求冒号后必须有空格、
    // 不处理 CRLF、多行 data 直接串联、且事件状态在每个 chunk 清零——
    // 前两条任一命中都会让整条 SSE 传输「HTTP 200 但一个事件都解析不出」。
    try {
      await parseSSEStream(
        body,
        ({ event, data }) => {
          if (!data) return;
          if (event === "endpoint") {
            // 旧 SSE 传输特有握手：服务器告知 POST 端点
            this.postEndpoint = this.resolveEndpoint(data.trim());
          } else if (event === "message") {
            this.handleSSEMessage(data);
          }
        },
        () => this.closed,
      );
    } catch {
      // 连接关闭
    } finally {
      if (!this.closed) {
        this.closed = true;
        // SSE 流意外断开，通知上层
        for (const [, pending] of this.pendingRequests) {
          pending.cleanup?.();
          pending.reject(new Error("SSE 连接断开"));
        }
        this.pendingRequests.clear();
        this.onClose?.();
      }
    }
  }

  /** 将可能的相对路径解析为绝对 URL */
  private resolveEndpoint(endpoint: string): string {
    if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
      return endpoint;
    }
    const base = new URL(this.url);
    return new URL(endpoint, base).toString();
  }

  private handleSSEMessage(data: string): void {
    try {
      const msg = JSON.parse(data);

      // 无 id 的消息是通知
      if (msg.jsonrpc === "2.0" && !("id" in msg) && msg.method) {
        this.onNotification?.(msg as JsonRpcNotification);
        return;
      }

      // 含 id + method 的是服务器发起的请求（G3：elicitation/create 等）
      if (msg.jsonrpc === "2.0" && "id" in msg && msg.method) {
        this.handleServerRequest(msg as JsonRpcRequest);
        return;
      }

      const response = msg as JsonRpcResponse;
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        this.pendingRequests.delete(response.id);
        pending.cleanup?.(); // 成功路径:移除 abort 监听器,防泄漏
        pending.resolve(response);
      }
    } catch {
      // 跳过非 JSON 数据
    }
  }

  /**
   * 处理服务器发起的请求（G3）：调用 onRequest 拿响应，经 POST 端点回传。
   * 未注册 onRequest 时用「方法未找到」(-32601) 应答。
   */
  private handleServerRequest(request: JsonRpcRequest): void {
    const respond = (response: JsonRpcResponse) => {
      if (this.closed) return;
      const endpoint = this.postEndpoint || this.url;
      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.headers },
        body: JSON.stringify(sanitizeStrings(response)),
      }).catch(() => {
        /* 回传失败忽略 */
      });
    };
    dispatchServerRequest(this.onRequest, request, respond);
  }

  async send(request: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse> {
    if (this.closed) {
      throw closedError();
    }

    // 等待 SSE 连接建立（失败 = POST 还没发，确定未送达）
    await this.connectPromise.catch((err) => {
      throw connectFailedError(err);
    });

    const endpoint = this.postEndpoint || this.url;

    return new Promise((resolve, reject) => {
      // 外部取消信号:监听器 + 其清理函数一并登记,任何 settle 路径都能移除监听器。
      // D8：超时 timer 同样由 cleanup 清掉。
      let onAbort: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      };
      this.pendingRequests.set(request.id, { resolve, reject, cleanup });

      if (signal) {
        if (signal.aborted) {
          this.pendingRequests.delete(request.id);
          reject(new Error("用户取消"));
          return;
        }
        onAbort = () => {
          if (this.pendingRequests.has(request.id)) {
            this.pendingRequests.delete(request.id);
            cleanup();
            reject(new Error("用户取消"));
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      // POST 发送请求
      const signals: AbortSignal[] = [AbortSignal.timeout(this.timeout)];
      if (signal) signals.push(signal);
      const combinedSignal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

      fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.headers,
        },
        body: JSON.stringify(sanitizeStrings(request)),
        signal: combinedSignal,
      }).catch((err) => {
        const pending = this.pendingRequests.get(request.id);
        if (pending) {
          this.pendingRequests.delete(request.id);
          pending.cleanup?.(); // POST 失败路径:移除 abort 监听器,防泄漏
          reject(new Error(`MCP SSE POST 失败: ${err.message}`));
        }
      });

      // 超时
      timer = setTimeout(() => {
        const pending = this.pendingRequests.get(request.id);
        if (pending) {
          this.pendingRequests.delete(request.id);
          pending.cleanup?.(); // 超时路径:移除 abort 监听器,防泄漏
          reject(new Error(`MCP SSE 请求超时: ${request.method}`));
        }
      }, this.timeout);
    });
  }

  sendNotification(notification: JsonRpcNotification): void {
    if (this.closed) return;
    const endpoint = this.postEndpoint || this.url;
    fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify(sanitizeStrings(notification)),
    }).catch(() => {});
  }

  close(): void {
    this.closed = true;
    this.abortController?.abort();
    for (const [, pending] of this.pendingRequests) {
      pending.cleanup?.();
      pending.reject(new Error("传输已关闭"));
    }
    this.pendingRequests.clear();
  }
}

/** WebSocket 传输 - 通过 WebSocket 双向通信 */
export class WebSocketTransport implements Transport {
  private ws: WebSocket;
  private pendingRequests = new Map<
    number | string,
    {
      resolve: (resp: JsonRpcResponse) => void;
      reject: (err: Error) => void;
      cleanup?: () => void;
    }
  >();
  private closed = false;
  private timeout: number;
  private connectPromise: Promise<void>;
  onNotification?: (notification: JsonRpcNotification) => void;
  onRequest?: (request: JsonRpcRequest) => Promise<JsonRpcResponse>;
  onClose?: () => void;

  constructor(url: string, headers?: Record<string, string>, timeout?: number) {
    this.timeout = timeout ?? 30000;
    this.ws = new WebSocket(url, { headers } as any);
    this.connectPromise = this.waitForOpen();
    // D9：同 SSETransport，兜底标记已处理，错误仍由 send() 的 await 抛出
    this.connectPromise.catch(() => {});
    this.setupListeners();
  }

  private waitForOpen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve(), { once: true });
      this.ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")), {
        once: true,
      });
    });
  }

  private setupListeners(): void {
    this.ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data as string);

        if (msg.jsonrpc === "2.0" && !("id" in msg) && msg.method) {
          this.onNotification?.(msg as JsonRpcNotification);
          return;
        }

        // D10：含 id + method 的是服务器发起的请求。原先这里没有这一支，请求被当响应查
        // pendingRequests 查不到就静默丢弃——而 client 照样向服务器声明了 elicitation/roots
        // 能力，于是对端永久等待。
        if (msg.jsonrpc === "2.0" && "id" in msg && msg.method) {
          dispatchServerRequest(this.onRequest, msg as JsonRpcRequest, (response) => {
            if (this.closed) return;
            try {
              this.ws.send(JSON.stringify(sanitizeStrings(response)));
            } catch {
              // 连接已断，忽略
            }
          });
          return;
        }

        const response = msg as JsonRpcResponse;
        const pending = this.pendingRequests.get(response.id);
        if (pending) {
          this.pendingRequests.delete(response.id);
          pending.cleanup?.();
          pending.resolve(response);
        }
      } catch {}
    });

    this.ws.addEventListener("close", () => {
      if (!this.closed) {
        this.closed = true;
        for (const [, p] of this.pendingRequests) {
          p.cleanup?.();
          p.reject(new Error("WebSocket 连接断开"));
        }
        this.pendingRequests.clear();
        this.onClose?.();
      }
    });
  }

  async send(request: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse> {
    if (this.closed) throw closedError();
    await this.connectPromise.catch((err) => {
      throw connectFailedError(err);
    });

    return new Promise((resolve, reject) => {
      // D8：timer 与 abort 监听器统一由 cleanup 清理（同 Stdio/SSE）
      let onAbort: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      };
      this.pendingRequests.set(request.id, { resolve, reject, cleanup });

      if (signal) {
        if (signal.aborted) {
          this.pendingRequests.delete(request.id);
          reject(new Error("用户取消"));
          return;
        }
        onAbort = () => {
          if (this.pendingRequests.has(request.id)) {
            this.pendingRequests.delete(request.id);
            cleanup();
            reject(new Error("用户取消"));
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.ws.send(JSON.stringify(sanitizeStrings(request)));

      timer = setTimeout(() => {
        if (this.pendingRequests.has(request.id)) {
          this.pendingRequests.delete(request.id);
          cleanup();
          reject(new Error(`WebSocket 请求超时: ${request.method}`));
        }
      }, this.timeout);
    });
  }

  sendNotification(notification: JsonRpcNotification): void {
    if (!this.closed) this.ws.send(JSON.stringify(sanitizeStrings(notification)));
  }

  close(): void {
    this.closed = true;
    this.ws.close();
    for (const [, p] of this.pendingRequests) {
      p.cleanup?.();
      p.reject(new Error("传输已关闭"));
    }
    this.pendingRequests.clear();
  }
}

/** 进程内传输 - 同进程内存直接通信 */
class InProcessTransportImpl implements Transport {
  private peer: InProcessTransportImpl | undefined;
  private pendingRequests = new Map<
    number | string,
    {
      resolve: (resp: JsonRpcResponse) => void;
      reject: (err: Error) => void;
    }
  >();
  private closed = false;
  onNotification?: (notification: JsonRpcNotification) => void;
  onRequest?: (request: JsonRpcRequest) => Promise<JsonRpcResponse>;
  onClose?: () => void;

  _setPeer(peer: InProcessTransportImpl): void {
    this.peer = peer;
  }

  async send(request: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse> {
    if (this.closed || !this.peer) throw closedError();

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(request.id, { resolve, reject });

      if (signal?.aborted) {
        this.pendingRequests.delete(request.id);
        reject(new Error("用户取消"));
        return;
      }
      signal?.addEventListener(
        "abort",
        () => {
          if (this.pendingRequests.has(request.id)) {
            this.pendingRequests.delete(request.id);
            reject(new Error("用户取消"));
          }
        },
        { once: true },
      );

      queueMicrotask(() => {
        this.peer?.handleIncoming(request);
      });
    });
  }

  handleIncoming(msg: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification): void {
    if ("result" in msg || "error" in msg) {
      const resp = msg as JsonRpcResponse;
      const pending = this.pendingRequests.get(resp.id);
      if (pending) {
        this.pendingRequests.delete(resp.id);
        pending.resolve(resp);
      }
      return;
    }

    if (!("id" in msg)) {
      this.onNotification?.(msg as JsonRpcNotification);
      return;
    }

    // D12：有 id 且无 result/error = 对端发起的请求。原先走到这里直接掉地，连 -32601 都不回。
    if (this.closed) return;
    dispatchServerRequest(this.onRequest, msg as JsonRpcRequest, (response) => {
      if (this.closed) return;
      queueMicrotask(() => {
        this.peer?.handleIncoming(response);
      });
    });
  }

  sendNotification(notification: JsonRpcNotification): void {
    if (this.closed || !this.peer) return;
    // D12：走对端的 handleIncoming 而不是直接调 peer.onNotification，与 send() 同一条路由，
    // 将来在 handleIncoming 里加的逻辑才会对通知生效。
    queueMicrotask(() => {
      this.peer?.handleIncoming(notification);
    });
  }

  close(): void {
    this.closed = true;
    for (const [, p] of this.pendingRequests) {
      p.reject(new Error("传输已关闭"));
    }
    this.pendingRequests.clear();
  }
}

/**
 * 创建一对互联的进程内传输
 * 返回 [clientTransport, serverTransport]
 */
export function createLinkedTransportPair(): [Transport, Transport] {
  const a = new InProcessTransportImpl();
  const b = new InProcessTransportImpl();
  a._setPeer(b);
  b._setPeer(a);
  return [a, b];
}
