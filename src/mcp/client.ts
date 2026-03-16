/**
 * MCP 客户端
 * 实现 MCP 协议的 initialize / listTools / callTool
 * 支持重试、通知处理、工具变更监听
 */

import type { Transport, JsonRpcNotification } from "./transport.ts";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  InitializeResult,
  ListToolsResult,
  CallToolResult,
  MCPToolDefinition,
} from "./types.ts";

/** MCPClient 配置选项 */
export interface MCPClientOptions {
  timeout?: number;   // 请求超时毫秒，默认 30000
  retries?: number;   // 重试次数，默认 2
}

export class MCPClient {
  private transport: Transport;
  private nextId = 1;
  private initialized = false;
  private serverInfo: InitializeResult | null = null;
  private retries: number;

  /** 工具列表变更回调 */
  onToolsChanged?: () => void;

  constructor(transport: Transport, options?: MCPClientOptions) {
    this.transport = transport;
    this.retries = options?.retries ?? 2;

    // 监听通知
    this.transport.onNotification = (notification: JsonRpcNotification) => {
      this.handleNotification(notification);
    };
  }

  /** 处理服务器通知 */
  private handleNotification(notification: JsonRpcNotification): void {
    if (notification.method === "notifications/tools/list_changed") {
      this.onToolsChanged?.();
    }
  }

  /** 初始化 MCP 连接 */
  async initialize(): Promise<InitializeResult> {
    const response = await this.sendWithRetry(this.makeRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "sid-code", version: "0.1.0" },
    }));

    if (response.error) {
      throw new Error(`MCP 初始化失败: ${response.error.message}`);
    }

    this.serverInfo = response.result as InitializeResult;
    this.initialized = true;

    // 发送 initialized 通知（无 id，不等响应）
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    };
    if (this.transport.sendNotification) {
      this.transport.sendNotification(notification);
    } else {
      // 降级：用 send 发送（带 id），忽略响应
      this.transport.send({
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "notifications/initialized",
      }).catch(() => {});
    }

    return this.serverInfo;
  }

  /** 列出可用工具 */
  async listTools(): Promise<MCPToolDefinition[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    const response = await this.sendWithRetry(this.makeRequest("tools/list", {}));

    if (response.error) {
      throw new Error(`列出工具失败: ${response.error.message}`);
    }

    const result = response.result as ListToolsResult;
    return result.tools || [];
  }

  /** 调用工具 */
  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    const response = await this.sendWithRetry(this.makeRequest("tools/call", {
      name,
      arguments: args,
    }));

    if (response.error) {
      throw new Error(`调用工具失败: ${response.error.message}`);
    }

    return response.result as CallToolResult;
  }

  /** 关闭连接 */
  close(): void {
    this.transport.close();
  }

  /** 带重试的发送：指数退避 + ±30% 随机抖动 */
  private async sendWithRetry(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.transport.send(request);
      } catch (err: any) {
        lastError = err;
        if (attempt < this.retries) {
          const baseDelay = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s...
          const jitter = baseDelay * (0.7 + Math.random() * 0.6); // ±30%
          await new Promise(resolve => setTimeout(resolve, jitter));
        }
      }
    }

    throw lastError!;
  }

  private makeRequest(method: string, params: Record<string, unknown>): JsonRpcRequest {
    return {
      jsonrpc: "2.0",
      id: this.nextId++,
      method,
      params,
    };
  }
}
