/**
 * MCP 传输层
 * 支持 stdio（子进程）、HTTP 和 SSE 三种传输方式
 */

import type { JsonRpcRequest, JsonRpcResponse } from "./types.ts";
import { spawn, type Subprocess } from "bun";
import { sanitizeStrings } from "../llm/sanitize-unicode.ts";

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
    if (!this.onRequest) {
      respond({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: `方法未找到: ${request.method}` },
      });
      return;
    }
    this.onRequest(request)
      .then(respond)
      .catch((err) => {
        respond({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32603, message: `内部错误: ${err?.message ?? err}` },
        });
      });
  }

  async send(request: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse> {
    if (this.closed) {
      throw new Error("传输已关闭");
    }

    return new Promise((resolve, reject) => {
      // 外部取消信号:监听器 + 其清理函数一并登记,任何 settle 路径都能移除监听器。
      let onAbort: (() => void) | undefined;
      const cleanup = () => {
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
            reject(new Error("用户取消"));
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      const data = JSON.stringify(request) + "\n";
      this.proc.stdin.write(data);
      this.proc.stdin.flush();

      // 超时
      setTimeout(() => {
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
  onNotification?: (notification: JsonRpcNotification) => void;

  constructor(url: string, headers?: Record<string, string>, timeout?: number) {
    this.url = url;
    this.headers = headers || {};
    this.timeout = timeout ?? 30000;
  }

  async send(request: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse> {
    const signals: AbortSignal[] = [AbortSignal.timeout(this.timeout)];
    if (signal) signals.push(signal);
    const combinedSignal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

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
      throw new Error(`MCP HTTP 错误: ${response.status}`);
    }

    return (await response.json()) as JsonRpcResponse;
  }

  close(): void {
    // HTTP 传输无需关闭
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
      throw new Error("传输已关闭");
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
      throw new Error(`MCP Streamable HTTP 错误: ${response.status}`);
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
    if (!this.onRequest) {
      respond({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: `方法未找到: ${request.method}` },
      });
      return;
    }
    this.onRequest(request)
      .then(respond)
      .catch((err) => {
        respond({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32603, message: `内部错误: ${err?.message ?? err}` },
        });
      });
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
    this.closed = true;
    this.sessionId = null;
    this.onClose?.();
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
      throw new Error(`MCP SSE 连接失败: ${response.status}`);
    }

    if (!response.body) {
      throw new Error("MCP SSE 响应无 body");
    }

    // 后台读取 SSE 流
    this.readSSEStream(response.body);
  }

  private async readSSEStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (!this.closed) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let eventType = "";
        let eventData = "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            eventData += line.slice(6);
          } else if (line === "") {
            // 空行表示事件结束
            if (eventType === "endpoint" && eventData) {
              // 服务器告知 POST 端点
              this.postEndpoint = this.resolveEndpoint(eventData.trim());
            } else if (eventType === "message" && eventData) {
              this.handleSSEMessage(eventData);
            }
            eventType = "";
            eventData = "";
          }
        }
      }
    } catch {
      // 连接关闭
    } finally {
      reader.releaseLock();
      if (!this.closed) {
        this.closed = true;
        // SSE 流意外断开，通知上层
        for (const [, pending] of this.pendingRequests) {
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
    if (!this.onRequest) {
      respond({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: `方法未找到: ${request.method}` },
      });
      return;
    }
    this.onRequest(request)
      .then(respond)
      .catch((err) => {
        respond({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32603, message: `内部错误: ${err?.message ?? err}` },
        });
      });
  }

  async send(request: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse> {
    if (this.closed) {
      throw new Error("传输已关闭");
    }

    // 等待 SSE 连接建立
    await this.connectPromise;

    const endpoint = this.postEndpoint || this.url;

    return new Promise((resolve, reject) => {
      // 外部取消信号:监听器 + 其清理函数一并登记,任何 settle 路径都能移除监听器。
      let onAbort: (() => void) | undefined;
      const cleanup = () => {
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
      setTimeout(() => {
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
    }
  >();
  private closed = false;
  private timeout: number;
  private connectPromise: Promise<void>;
  onNotification?: (notification: JsonRpcNotification) => void;
  onClose?: () => void;

  constructor(url: string, headers?: Record<string, string>, timeout?: number) {
    this.timeout = timeout ?? 30000;
    this.ws = new WebSocket(url, { headers } as any);
    this.connectPromise = this.waitForOpen();
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

        const response = msg as JsonRpcResponse;
        const pending = this.pendingRequests.get(response.id);
        if (pending) {
          this.pendingRequests.delete(response.id);
          pending.resolve(response);
        }
      } catch {}
    });

    this.ws.addEventListener("close", () => {
      if (!this.closed) {
        this.closed = true;
        for (const [, p] of this.pendingRequests) {
          p.reject(new Error("WebSocket 连接断开"));
        }
        this.pendingRequests.clear();
        this.onClose?.();
      }
    });
  }

  async send(request: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse> {
    if (this.closed) throw new Error("传输已关闭");
    await this.connectPromise;

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

      this.ws.send(JSON.stringify(sanitizeStrings(request)));

      setTimeout(() => {
        if (this.pendingRequests.has(request.id)) {
          this.pendingRequests.delete(request.id);
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
  onClose?: () => void;

  _setPeer(peer: InProcessTransportImpl): void {
    this.peer = peer;
  }

  async send(request: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse> {
    if (this.closed || !this.peer) throw new Error("传输已关闭");

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
  }

  sendNotification(notification: JsonRpcNotification): void {
    if (this.closed || !this.peer) return;
    queueMicrotask(() => {
      this.peer?.onNotification?.(notification);
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
