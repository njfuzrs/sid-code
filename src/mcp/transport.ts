/**
 * MCP 传输层
 * 支持 stdio（子进程）和 HTTP 两种传输方式
 */

import type { JsonRpcRequest, JsonRpcResponse } from "./types.ts";
import { spawn, type Subprocess } from "bun";

/** 传输接口 */
export interface Transport {
  send(request: JsonRpcRequest): Promise<JsonRpcResponse>;
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

  constructor(command: string, args: string[] = [], env?: Record<string, string>) {
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
        const response = JSON.parse(trimmed) as JsonRpcResponse;
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
      }, 30000);
    });
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

  constructor(url: string, headers?: Record<string, string>) {
    this.url = url;
    this.headers = headers || {};
  }

  async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify(request),
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
