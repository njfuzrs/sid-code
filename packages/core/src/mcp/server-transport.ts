/**
 * MCP 服务端 stdio 传输（G5：sid-code 作为 MCP server 对外）
 *
 * 与客户端侧 `StdioTransport`（transport.ts）语义对称、方向相反：
 *   - 客户端：写 request 到子进程 stdin，从子进程 stdout 读 response（我们是 client）。
 *   - 服务端：从**自身** stdin 读 request，把 response 写回**自身** stdout（我们是 server）。
 *
 * 协议：JSON-RPC 2.0，一行一条消息（newline-delimited JSON，对齐 MCP stdio 规范）。
 * 收到含 id 的请求 → 调 requestHandler 拿结果，写回 response；收到无 id 的通知 → 调
 * notificationHandler（如 `notifications/initialized`，一般忽略）。
 *
 * 关键约束：stdout 只能出 JSON-RPC 消息，任何日志/诊断必须走 stderr，否则会污染协议流
 * 导致对端解析失败（对齐 CC StdioServerTransport 的 stdout 独占约定）。
 */

import type { JsonRpcRequest, JsonRpcResponse } from "./types.ts";
import type { JsonRpcNotification } from "./transport.ts";

export interface ServerTransportHandlers {
  /** 处理含 id 的请求，返回 JSON-RPC 响应（result 或 error 由处理器决定）。 */
  onRequest: (request: JsonRpcRequest) => Promise<JsonRpcResponse>;
  /** 处理无 id 的通知（如 notifications/initialized）。可选，未提供则忽略。 */
  onNotification?: (notification: JsonRpcNotification) => void;
}

/**
 * 服务端 stdio 传输。构造后调用 start() 开始读 stdin 循环，close() 或 stdin EOF 结束。
 */
export class StdioServerTransport {
  private buffer = "";
  private closed = false;
  private handlers: ServerTransportHandlers;
  private stdin: NodeJS.ReadStream;
  private stdout: NodeJS.WriteStream;

  constructor(
    handlers: ServerTransportHandlers,
    io?: { stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream },
  ) {
    this.handlers = handlers;
    this.stdin = io?.stdin ?? process.stdin;
    this.stdout = io?.stdout ?? process.stdout;
  }

  /** 开始监听 stdin。返回一个 Promise，stdin 关闭（EOF）或 close() 调用后 resolve。 */
  start(): Promise<void> {
    return new Promise((resolve) => {
      const onData = (chunk: Buffer | string) => {
        this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        this.processBuffer();
      };
      const onEnd = () => {
        if (!this.closed) {
          this.closed = true;
          this.stdin.off("data", onData);
          resolve();
        }
      };
      this.stdin.on("data", onData);
      this.stdin.once("end", onEnd);
      this.stdin.once("close", onEnd);
      // 确保 stdin 处于流动模式（某些环境默认暂停）
      if (typeof this.stdin.resume === "function") this.stdin.resume();
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let msg: any;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        // 非 JSON 行：无法回 id，只能忽略（协议流被污染时的最保守处理）。
        continue;
      }

      // 无 id + 有 method → 通知
      if (msg && msg.jsonrpc === "2.0" && !("id" in msg) && msg.method) {
        this.handlers.onNotification?.(msg as JsonRpcNotification);
        continue;
      }

      // 有 id + 有 method → 请求
      if (msg && msg.jsonrpc === "2.0" && "id" in msg && msg.method) {
        this.dispatchRequest(msg as JsonRpcRequest);
        continue;
      }
      // 其余（响应等）服务端不处理，忽略。
    }
  }

  private dispatchRequest(request: JsonRpcRequest): void {
    this.handlers
      .onRequest(request)
      .then((response) => this.write(response))
      .catch((err: any) => {
        this.write({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32603, message: `内部错误: ${err?.message ?? err}` },
        });
      });
  }

  /** 写一条 JSON-RPC 消息到 stdout（自动补换行）。 */
  private write(msg: JsonRpcResponse): void {
    if (this.closed) return;
    try {
      this.stdout.write(JSON.stringify(msg) + "\n");
    } catch {
      // 写失败（管道断开等），忽略。
    }
  }

  /** 主动发送通知（无 id，不等响应）。服务端一般不需要，预留给 list_changed 等。 */
  sendNotification(notification: JsonRpcNotification): void {
    if (this.closed) return;
    try {
      this.stdout.write(JSON.stringify(notification) + "\n");
    } catch {
      // 忽略
    }
  }

  close(): void {
    this.closed = true;
  }
}
