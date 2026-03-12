/**
 * MCP 客户端
 * 实现 MCP 协议的 initialize / listTools / callTool
 */

import type { Transport } from "./transport.ts";
import type {
  JsonRpcRequest,
  InitializeResult,
  ListToolsResult,
  CallToolResult,
  MCPToolDefinition,
} from "./types.ts";

export class MCPClient {
  private transport: Transport;
  private nextId = 1;
  private initialized = false;
  private serverInfo: InitializeResult | null = null;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /** 初始化 MCP 连接 */
  async initialize(): Promise<InitializeResult> {
    const response = await this.transport.send(this.makeRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "sid-code", version: "0.1.0" },
    }));

    if (response.error) {
      throw new Error(`MCP 初始化失败: ${response.error.message}`);
    }

    this.serverInfo = response.result as InitializeResult;
    this.initialized = true;

    // 发送 initialized 通知
    await this.transport.send({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "notifications/initialized",
    });

    return this.serverInfo;
  }

  /** 列出可用工具 */
  async listTools(): Promise<MCPToolDefinition[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    const response = await this.transport.send(this.makeRequest("tools/list", {}));

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

    const response = await this.transport.send(this.makeRequest("tools/call", {
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

  private makeRequest(method: string, params: Record<string, unknown>): JsonRpcRequest {
    return {
      jsonrpc: "2.0",
      id: this.nextId++,
      method,
      params,
    };
  }
}
