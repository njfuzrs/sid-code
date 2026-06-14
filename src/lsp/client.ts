/**
 * LSP Client — 最底层，负责 JSON-RPC over stdio 通信
 *
 * 对标 Claude Code 的 LSPClient：
 * - 通过 stdio 管道与 LSP 服务器通信
 * - JSON-RPC 2.0 请求/响应/通知（Content-Length 帧协议）
 * - 进程生命周期管理
 */

import { spawn, type ChildProcess } from "child_process";
import { getLogger } from "../debug/logger.ts";

export class LSPClient {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private notificationHandlers = new Map<string, Array<(params: unknown) => void>>();
  private buffer = "";
  private contentLength = -1;
  private isStopping = false;
  private serverName: string;

  /** 进程崩溃回调 */
  onCrash?: () => void;

  constructor(serverName: string) {
    this.serverName = serverName;
  }

  /** 进程是否在运行 */
  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  /** 启动 LSP 服务器进程 */
  async start(
    command: string,
    args: string[],
    options: { env?: Record<string, string>; cwd?: string },
  ): Promise<void> {
    const log = getLogger();

    this.isStopping = false;
    this.process = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
      cwd: options.cwd,
    });

    // 等待进程成功 spawn
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => { cleanup(); resolve(); };
      const onError = (err: Error) => { cleanup(); reject(err); };
      const cleanup = () => {
        this.process?.removeListener("spawn", onSpawn);
        this.process?.removeListener("error", onError);
      };
      this.process!.once("spawn", onSpawn);
      this.process!.once("error", onError);
    });

    // 监听 stdout（JSON-RPC 消息）
    this.process.stdout!.on("data", (chunk: Buffer) => {
      this.handleData(chunk.toString());
    });

    // 监听 stderr（调试日志）
    this.process.stderr!.on("data", (chunk: Buffer) => {
      log.debug("LSP", `[${this.serverName}] stderr: ${chunk.toString().trim()}`);
    });

    // 监听进程退出
    this.process.on("exit", (code) => {
      // reject 所有 pending 请求
      const err = new Error(`LSP 进程退出 (code=${code})`);
      for (const [, pending] of this.pendingRequests) pending.reject(err);
      this.pendingRequests.clear();

      if (!this.isStopping) {
        log.warn("LSP", `[${this.serverName}] 进程意外退出，code=${code}`);
        this.onCrash?.();
      }
    });
  }

  /** 发送请求并等待响应 */
  async sendRequest<T = unknown>(method: string, params?: unknown, timeoutMs = 30000): Promise<T> {
    if (!this.process || this.process.killed) {
      throw new Error(`LSP 服务器 ${this.serverName} 未运行`);
    }

    const id = ++this.requestId;
    const message = { jsonrpc: "2.0", id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`LSP 请求超时: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v as T); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      this.writeMessage(message);
    });
  }

  /** 发送通知（无 id，不等响应） */
  sendNotification(method: string, params?: unknown): void {
    if (!this.process || this.process.killed) return;
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  /** 注册通知处理器（支持同一 method 多个处理器） */
  onNotification(method: string, handler: (params: unknown) => void): void {
    const handlers = this.notificationHandlers.get(method) ?? [];
    handlers.push(handler);
    this.notificationHandlers.set(method, handlers);
  }

  /** 停止进程 */
  stop(): void {
    this.isStopping = true;
    if (this.process && !this.process.killed) {
      // 先摘掉 stdout/stderr/exit 监听器,避免进程退出后回调残留(LEAK-6)
      try { this.process.stdout?.removeAllListeners(); } catch { /* ignore */ }
      try { this.process.stderr?.removeAllListeners(); } catch { /* ignore */ }
      try { this.process.removeAllListeners("exit"); } catch { /* ignore */ }
      try { this.process.kill(); } catch {}
    }
    // reject 残留 pending 请求,避免调用方永久挂起
    const err = new Error(`LSP 服务器 ${this.serverName} 已停止`);
    for (const [, pending] of this.pendingRequests) pending.reject(err);
    this.pendingRequests.clear();
    this.process = null;
  }

  // ─── 内部方法 ───

  /** 写入 JSON-RPC 消息（Content-Length 帧协议） */
  private writeMessage(message: unknown): void {
    const json = JSON.stringify(message);
    const contentLength = Buffer.byteLength(json, "utf-8");
    const payload = `Content-Length: ${contentLength}\r\n\r\n${json}`;
    this.process?.stdin?.write(payload);
  }

  /** 处理 stdout 数据（解析 Content-Length 帧） */
  private handleData(data: string): void {
    this.buffer += data;

    while (true) {
      if (this.contentLength < 0) {
        // 寻找头部结束标记
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return; // 头部未完整

        const header = this.buffer.slice(0, headerEnd);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          // 头部损坏，跳过
          this.buffer = this.buffer.slice(headerEnd + 4);
          continue;
        }
        this.contentLength = parseInt(match[1]!, 10);
        this.buffer = this.buffer.slice(headerEnd + 4);
      }

      // 按字节长度截取消息体
      const bodyBytes = Buffer.from(this.buffer, "utf-8");
      if (bodyBytes.length < this.contentLength) return; // 消息体未完整

      const body = bodyBytes.slice(0, this.contentLength).toString("utf-8");
      this.buffer = bodyBytes.slice(this.contentLength).toString("utf-8");
      this.contentLength = -1;

      try {
        const msg = JSON.parse(body);
        this.handleMessage(msg);
      } catch {
        getLogger().error("LSP", `[${this.serverName}] JSON 解析失败`);
      }
    }
  }

  private handleMessage(msg: any): void {
    if (msg.id != null && (msg.result !== undefined || msg.error)) {
      // 响应
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(`LSP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          pending.resolve(msg.result);
        }
      }
    } else if (msg.method && msg.id == null) {
      // 通知
      const handlers = this.notificationHandlers.get(msg.method);
      if (handlers) {
        for (const handler of handlers) {
          try { handler(msg.params); } catch {}
        }
      }
    }
    // 服务器→客户端的请求（msg.method && msg.id != null）暂不处理
  }
}
