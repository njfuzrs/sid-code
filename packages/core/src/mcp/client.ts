/**
 * MCP 客户端
 * 实现 MCP 协议的 initialize / listTools / callTool / listResources / readResource / listPrompts / getPrompt / ping
 * 支持重试、通知处理、工具/资源/提示词变更监听、断线检测
 */

import type { Transport, JsonRpcNotification } from "./transport.ts";
import { computeBackoffMs } from "../config/network-profile.ts";
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
import { getRawVersion } from "@sid-code/shared/version.ts";
import { getLogger } from "../debug/logger.ts";
import { basename } from "path";

/**
 * 客户端声明的 MCP 协议版本（G6-5）。
 * 2025-03-26 是 Streamable HTTP + tool annotations 的规范版本，与 G4 配套。
 */
export const CLIENT_PROTOCOL_VERSION = "2025-03-26";

/** MCPClient 配置选项 */
export interface MCPClientOptions {
  timeout?: number;   // 请求超时毫秒，默认 30000
  retries?: number;   // 重试次数，默认 2
}

/** 服务器请求处理器类型（method → handler） */
type RequestHandler = (params: unknown) => Promise<unknown>;

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
  /** 服务器请求处理器注册表（method → handler）(G3 Elicitation 接线) */
  private requestHandlers = new Map<string, RequestHandler>();

  constructor(transport: Transport, options?: MCPClientOptions) {
    this.transport = transport;
    this.retries = options?.retries ?? 2;

    // 监听通知
    this.transport.onNotification = (notification: JsonRpcNotification) => {
      this.handleNotification(notification);
    };

    // G3 接线：监听服务器发起的请求（elicitation/create 等），路由到 requestHandlers
    this.transport.onRequest = async (request: import("./types.ts").JsonRpcRequest) => {
      const handler = this.requestHandlers.get(request.method);
      if (!handler) {
        return { jsonrpc: "2.0" as const, id: request.id, error: { code: -32601, message: `方法未找到: ${request.method}` } };
      }
      try {
        const result = await handler(request.params);
        return { jsonrpc: "2.0" as const, id: request.id, result };
      } catch (err: any) {
        return { jsonrpc: "2.0" as const, id: request.id, error: { code: -32603, message: err?.message ?? "内部错误" } };
      }
    };

    // 监听传输层断线
    if (this.transport.onClose) {
      this.transport.onClose = () => {
        this.onDisconnected?.();
      };
    }
  }

  /**
   * 注册服务器请求处理器（G3 Elicitation 接线）。
   * 同一 method 只保留最后注册的 handler（如 elicitation/create）。
   * @returns 取消注册函数
   */
  onRequestMethod(method: string, handler: RequestHandler): () => void {
    this.requestHandlers.set(method, handler);
    return () => {
      if (this.requestHandlers.get(method) === handler) {
        this.requestHandlers.delete(method);
      }
    };
  }

  /** 是否已注册某 method 的请求处理器（用于 initialize 声明 capability） */
  private hasRequestHandler(method: string): boolean {
    return this.requestHandlers.has(method);
  }

  /**
   * G6-2：惰性注册 roots/list 请求处理器，返回当前工作目录作为唯一 root。
   * 服务器在声明 roots 能力后可发 roots/list 询问客户端可访问的根目录。
   * 幂等：已注册则跳过。
   */
  private ensureRootsHandler(): void {
    if (this.requestHandlers.has("roots/list")) return;
    this.onRequestMethod("roots/list", async () => {
      const cwd = process.cwd();
      return { roots: [{ uri: `file://${cwd}`, name: basename(cwd) || cwd }] };
    });
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
    // G3：注册了 elicitation/create 处理器时向服务器声明 elicitation 能力，
    // 服务器据此才会发起 elicitation 请求（未声明则服务器不应发）。
    const capabilities: Record<string, unknown> = {};
    if (this.hasRequestHandler("elicitation/create")) {
      capabilities.elicitation = {};
    }
    // G6-2：默认声明 roots 能力并注册 roots/list 处理器（返回 CWD），
    // 否则服务器发 roots/list 会收到 -32601。惰性注册，避免重复。
    this.ensureRootsHandler();
    capabilities.roots = {};

    // G6-4：clientInfo 版本号从 package.json 读真实值（此前硬编码 0.1.0，与二进制脱节）。
    const response = await this.sendWithRetry(this.makeRequest("initialize", {
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      capabilities,
      clientInfo: { name: "sid-code", version: getRawVersion() },
    }));

    if (response.error) {
      throw new Error(`MCP 初始化失败: ${response.error.message}`);
    }

    this.serverInfo = response.result as InitializeResult;
    this.initialized = true;

    // G6-5：协议版本协商——比对服务器返回的 protocolVersion，不一致仅 warn，不强制断开（宽容）。
    const serverProto = this.serverInfo?.protocolVersion;
    if (serverProto && serverProto !== CLIENT_PROTOCOL_VERSION) {
      getLogger().warn(
        "MCP",
        `协议版本不一致：client=${CLIENT_PROTOCOL_VERSION}, server=${serverProto}（继续连接，宽容处理）`,
      );
    }

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
          // 配置-5：退避改用 network-profile 的 computeBackoffMs（与 loop/fallback 层同一实现，
          // 指数退避 + jitter），不再就地 `1000 * 2^attempt`。基数 1s、上限 30s 保持原有量级。
          const delay = computeBackoffMs(attempt, 1_000, 30_000);
          await new Promise(resolve => setTimeout(resolve, delay));
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
