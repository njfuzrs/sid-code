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
  /** 连接关闭回调（用于断线检测） */
  onClose?: () => void;
  close(): void;
}

/** Stdio 传输 - 通过子进程的 stdin/stdout 通信 */
export class StdioTransport implements Transport {
  private proc: Subprocess;
  private pendingRequests = new Map<number | string, {
    resolve: (resp: JsonRpcResponse) => void;
    reject: (err: Error) => void;
    // 修:请求 settle 时移除 signal 的 abort 监听器,防止成功/超时路径下监听器在
    // 共享(会话级)signal 上线性累加(每次 MCP 调用泄漏一个)。
    cleanup?: () => void;
  }>();
  private buffer = "";
  private closed = false;
  private timeout: number;
  onNotification?: (notification: JsonRpcNotification) => void;
  onClose?: () => void;

  constructor(command: string, args: string[] = [], env?: Record<string, string>, timeout?: number) {
    this.timeout = timeout ?? 30000;
    this.proc = spawn({
      cmd: [command, ...args],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env as Record<string, string>, ...env },
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

/** SSE 传输 - GET 连接 SSE 流接收响应/通知，POST 发送请求 */
export class SSETransport implements Transport {
  private url: string;
  private headers: Record<string, string>;
  private timeout: number;
  private closed = false;
  private pendingRequests = new Map<number | string, {
    resolve: (resp: JsonRpcResponse) => void;
    reject: (err: Error) => void;
    // 修:请求 settle 时移除 signal 的 abort 监听器,防止在共享(会话级)signal 上累加。
    cleanup?: () => void;
  }>();
  private abortController: AbortController | null = null;
  /** SSE 握手后服务器返回的 POST 端点（可能是相对路径） */
  private postEndpoint: string | null = null;
  private connectPromise: Promise<void>;
  onNotification?: (notification: JsonRpcNotification) => void;
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
  private pendingRequests = new Map<number | string, {
    resolve: (resp: JsonRpcResponse) => void;
    reject: (err: Error) => void;
  }>();
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
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
    });
  }

  private setupListeners(): void {
    this.ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data as string);

        if (msg.jsonrpc === '2.0' && !('id' in msg) && msg.method) {
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

    this.ws.addEventListener('close', () => {
      if (!this.closed) {
        this.closed = true;
        for (const [, p] of this.pendingRequests) {
          p.reject(new Error('WebSocket 连接断开'));
        }
        this.pendingRequests.clear();
        this.onClose?.();
      }
    });
  }

  async send(request: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse> {
    if (this.closed) throw new Error('传输已关闭');
    await this.connectPromise;

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(request.id, { resolve, reject });

      if (signal?.aborted) {
        this.pendingRequests.delete(request.id);
        reject(new Error('用户取消'));
        return;
      }
      signal?.addEventListener('abort', () => {
        if (this.pendingRequests.has(request.id)) {
          this.pendingRequests.delete(request.id);
          reject(new Error('用户取消'));
        }
      }, { once: true });

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
      p.reject(new Error('传输已关闭'));
    }
    this.pendingRequests.clear();
  }
}

/** 进程内传输 - 同进程内存直接通信 */
class InProcessTransportImpl implements Transport {
  private peer: InProcessTransportImpl | undefined;
  private pendingRequests = new Map<number | string, {
    resolve: (resp: JsonRpcResponse) => void;
    reject: (err: Error) => void;
  }>();
  private closed = false;
  onNotification?: (notification: JsonRpcNotification) => void;
  onClose?: () => void;

  _setPeer(peer: InProcessTransportImpl): void {
    this.peer = peer;
  }

  async send(request: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse> {
    if (this.closed || !this.peer) throw new Error('传输已关闭');

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(request.id, { resolve, reject });

      if (signal?.aborted) {
        this.pendingRequests.delete(request.id);
        reject(new Error('用户取消'));
        return;
      }
      signal?.addEventListener('abort', () => {
        if (this.pendingRequests.has(request.id)) {
          this.pendingRequests.delete(request.id);
          reject(new Error('用户取消'));
        }
      }, { once: true });

      queueMicrotask(() => {
        this.peer?.handleIncoming(request);
      });
    });
  }

  handleIncoming(msg: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification): void {
    if ('result' in msg || 'error' in msg) {
      const resp = msg as JsonRpcResponse;
      const pending = this.pendingRequests.get(resp.id);
      if (pending) {
        this.pendingRequests.delete(resp.id);
        pending.resolve(resp);
      }
      return;
    }

    if (!('id' in msg)) {
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
      p.reject(new Error('传输已关闭'));
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
