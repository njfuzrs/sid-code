/**
 * MCP 传输层
 * 支持 stdio（子进程）、HTTP 和 SSE 三种传输方式
 */

import type { JsonRpcRequest, JsonRpcResponse } from "./types.ts";
import { spawn, type Subprocess } from "bun";

/** JSON-RPC 通知（无 id） */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

/** 传输接口 */
export interface Transport {
  send(request: JsonRpcRequest): Promise<JsonRpcResponse>;
  /** 发送通知（无 id，不等响应） */
  sendNotification?(notification: JsonRpcNotification): void;
  /** 通知回调（处理无 id 的 JSON-RPC 消息） */
  onNotification?: (notification: JsonRpcNotification) => void;
  close(): void;
}

/** Stdio 传输 - 通过子进程的 stdin/stdout 通信 */
export class StdioTransport implements Transport {
  private proc: Subprocess;
  private pendingRequests = new Map<number | string, {
    resolve: (resp: JsonRpcResponse) => void;
    reject: (err: Error) => void;
  }>();
  private buffer = "";
  private closed = false;
  private timeout: number;
  onNotification?: (notification: JsonRpcNotification) => void;

  constructor(command: string, args: string[] = [], env?: Record<string, string>, timeout?: number) {
    this.timeout = timeout ?? 30000;
    this.proc = spawn({
      cmd: [command, ...args],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env as Record<string, string>, ...env },
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
          pending.resolve(response);
        }
      } catch {
        // 跳过非 JSON 行
      }
    }
  }

  async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (this.closed) {
      throw new Error("传输已关闭");
    }

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(request.id, { resolve, reject });

      const data = JSON.stringify(request) + "\n";
      const writer = this.proc.stdin.getWriter();
      writer.write(new TextEncoder().encode(data));
      writer.releaseLock();

      // 超时
      setTimeout(() => {
        if (this.pendingRequests.has(request.id)) {
          this.pendingRequests.delete(request.id);
          reject(new Error(`MCP 请求超时: ${request.method}`));
        }
      }, this.timeout);
    });
  }

  sendNotification(notification: JsonRpcNotification): void {
    if (this.closed) return;
    const data = JSON.stringify(notification) + "\n";
    const writer = this.proc.stdin.getWriter();
    writer.write(new TextEncoder().encode(data));
    writer.releaseLock();
  }

  close(): void {
    this.closed = true;
    this.proc.kill();
    for (const [, pending] of this.pendingRequests) {
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

  async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.timeout),
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
  }>();
  private abortController: AbortController | null = null;
  /** SSE 握手后服务器返回的 POST 端点（可能是相对路径） */
  private postEndpoint: string | null = null;
  private connectPromise: Promise<void>;
  onNotification?: (notification: JsonRpcNotification) => void;

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
        pending.resolve(response);
      }
    } catch {
      // 跳过非 JSON 数据
    }
  }

  async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (this.closed) {
      throw new Error("传输已关闭");
    }

    // 等待 SSE 连接建立
    await this.connectPromise;

    const endpoint = this.postEndpoint || this.url;

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(request.id, { resolve, reject });

      // POST 发送请求
      fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.headers,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeout),
      }).catch((err) => {
        if (this.pendingRequests.has(request.id)) {
          this.pendingRequests.delete(request.id);
          reject(new Error(`MCP SSE POST 失败: ${err.message}`));
        }
      });

      // 超时
      setTimeout(() => {
        if (this.pendingRequests.has(request.id)) {
          this.pendingRequests.delete(request.id);
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
      body: JSON.stringify(notification),
    }).catch(() => {});
  }

  close(): void {
    this.closed = true;
    this.abortController?.abort();
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error("传输已关闭"));
    }
    this.pendingRequests.clear();
  }
}
