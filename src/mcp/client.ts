/**
 * MCP 客户端
 * 实现 MCP 协议的 initialize / listTools / callTool / listResources / readResource / listPrompts / getPrompt / ping
 * 支持重试、通知处理、工具/资源/提示词变更监听、断线检测
 */

import type { Transport, JsonRpcNotification } from "./transport.ts";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  InitializeResult,
  ListToolsResult,
  CallToolResult,
  MCPToolDefinition,
  ListResourcesResult,
  ReadResourceResult,
  MCPResource,
  ListPromptsResult,
  GetPromptResult,
  MCPPrompt,
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
  /** 资源列表变更回调 */
  onResourcesChanged?: () => void;
  /** 提示词列表变更回调 */
  onPromptsChanged?: () => void;
  /** 连接断开回调 */
  onDisconnected?: () => void;

  /** 通用通知处理器注册表（method → handlers） */
  private notificationHandlers = new Map<string, Array<(params: unknown) => void>>();

  constructor(transport: Transport, options?: MCPClientOptions) {
    this.transport = transport;
    this.retries = options?.retries ?? 2;

    // 监听通知
    this.transport.onNotification = (notification: JsonRpcNotification) => {
      this.handleNotification(notification);
    };

    // 监听传输层断线
    if (this.transport.onClose) {
      this.transport.onClose = () => {
        this.onDisconnected?.();
      };
    }
  }

  /**
   * 注册通用 MCP 通知处理器（支持同一 method 多个处理器）。
   * 用于 IDE 通知（selection_changed / at_mentioned 等）。
   * @returns 取消注册函数
   */
  onNotification(method: string, handler: (params: unknown) => void): () => void {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = [];
      this.notificationHandlers.set(method, handlers);
    }
    handlers.push(handler);

    return () => {
      const list = this.notificationHandlers.get(method);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      }
    };
  }

  /** 处理服务器通知 */
  private handleNotification(notification: JsonRpcNotification): void {
    switch (notification.method) {
      case "notifications/tools/list_changed":
        this.onToolsChanged?.();
        break;
      case "notifications/resources/list_changed":
        this.onResourcesChanged?.();
        break;
      case "notifications/prompts/list_changed":
        this.onPromptsChanged?.();
        break;
    }

    // 分发到通用通知处理器（IDE 选区 / @提及等）
    const handlers = this.notificationHandlers.get(notification.method);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(notification.params);
        } catch {
          // 单个处理器失败不影响其他处理器
        }
      }
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
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    const response = await this.sendWithRetry(this.makeRequest("tools/call", {
      name,
      arguments: args,
    }), signal);

    if (response.error) {
      throw new Error(`调用工具失败: ${response.error.message}`);
    }

    return response.result as CallToolResult;
  }

  // ─── Resources ───

  /** 列出可用资源 */
  async listResources(): Promise<MCPResource[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    const response = await this.sendWithRetry(this.makeRequest("resources/list", {}));

    if (response.error) {
      // -32601 Method not found 表示服务器不支持，返回空
      if (response.error.code === -32601) return [];
      throw new Error(`列出资源失败: ${response.error.message}`);
    }

    const result = response.result as ListResourcesResult;
    return result.resources || [];
  }

  /** 读取资源 */
  async readResource(uri: string): Promise<ReadResourceResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    const response = await this.sendWithRetry(this.makeRequest("resources/read", { uri }));

    if (response.error) {
      throw new Error(`读取资源失败: ${response.error.message}`);
    }

    return response.result as ReadResourceResult;
  }

  // ─── Prompts ───

  /** 列出可用提示词 */
  async listPrompts(): Promise<MCPPrompt[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    const response = await this.sendWithRetry(this.makeRequest("prompts/list", {}));

    if (response.error) {
      // -32601 Method not found 表示服务器不支持，返回空
      if (response.error.code === -32601) return [];
      throw new Error(`列出提示词失败: ${response.error.message}`);
    }

    const result = response.result as ListPromptsResult;
    return result.prompts || [];
  }

  /** 获取提示词内容 */
  async getPrompt(name: string, args?: Record<string, string>): Promise<GetPromptResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    const params: Record<string, unknown> = { name };
    if (args) params.arguments = args;

    const response = await this.sendWithRetry(this.makeRequest("prompts/get", params));

    if (response.error) {
      throw new Error(`获取提示词失败: ${response.error.message}`);
    }

    return response.result as GetPromptResult;
  }

  // ─── 健康检查 ───

  /** ping 服务器，返回是否存活 */
  async ping(): Promise<boolean> {
    try {
      const response = await this.transport.send(this.makeRequest("ping", {}));
      // -32601 Method not found 也算存活（服务器不支持 ping 但连接正常）
      if (response.error && response.error.code !== -32601) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** 关闭连接 */
  close(): void {
    this.transport.close();
  }

  /** 带重试的发送：指数退避 + ±30% 随机抖动 */
  private async sendWithRetry(request: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      // 检查是否已取消
      if (signal?.aborted) {
        throw new Error("用户取消");
      }

      try {
        return await this.transport.send(request, signal);
      } catch (err: any) {
        // 用户取消不重试
        if (signal?.aborted) {
          throw new Error("用户取消");
        }
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
