/**
 * MCP 管理器
 * 管理多个 MCP 服务器连接，收集所有可用工具
 */

import type { MCPServerConfig } from "../config/config.ts";
import type { Tool, ToolResult } from "../tool/types.ts";
import type { MCPToolDefinition } from "./types.ts";
import { MCPClient } from "./client.ts";
import { StdioTransport, HTTPTransport } from "./transport.ts";

/** MCP 工具适配器 - 将 MCP 工具适配为内部 Tool 接口 */
class MCPToolAdapter implements Tool {
  private client: MCPClient;
  private def: MCPToolDefinition;
  private serverName: string;

  constructor(client: MCPClient, def: MCPToolDefinition, serverName: string) {
    this.client = client;
    this.def = def;
    this.serverName = serverName;
  }

  name(): string {
    return `mcp__${this.serverName}__${this.def.name}`;
  }

  description(): string {
    return this.def.description;
  }

  inputSchema(): Record<string, unknown> {
    return this.def.inputSchema;
  }

  async execute(input: unknown): Promise<ToolResult> {
    try {
      const result = await this.client.callTool(
        this.def.name,
        input as Record<string, unknown>,
      );

      const text = result.content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!)
        .join("\n");

      return {
        output: text || "(无输出)",
        isError: result.isError,
      };
    } catch (err: any) {
      return {
        output: `MCP 工具调用失败: ${err.message}`,
        isError: true,
      };
    }
  }
}

export class MCPManager {
  private clients = new Map<string, MCPClient>();

  /** 连接所有配置的 MCP 服务器 */
  async connectAll(servers: Record<string, MCPServerConfig>): Promise<Tool[]> {
    const allTools: Tool[] = [];

    const entries = Object.entries(servers);
    if (entries.length === 0) return allTools;

    // 并行连接所有服务器
    const results = await Promise.allSettled(
      entries.map(async ([name, config]) => {
        try {
          const tools = await this.connect(name, config);
          return { name, tools };
        } catch (err: any) {
          console.error(`[MCP] 连接 ${name} 失败: ${err.message}`);
          return { name, tools: [] as Tool[] };
        }
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        allTools.push(...result.value.tools);
      }
    }

    return allTools;
  }

  /** 连接单个 MCP 服务器 */
  async connect(name: string, config: MCPServerConfig): Promise<Tool[]> {
    let transport;

    if (config.transport === "stdio") {
      if (!config.command) {
        throw new Error(`MCP 服务器 ${name} 缺少 command 配置`);
      }
      transport = new StdioTransport(config.command, config.args, config.env);
    } else if (config.transport === "http") {
      if (!config.url) {
        throw new Error(`MCP 服务器 ${name} 缺少 url 配置`);
      }
      transport = new HTTPTransport(config.url, config.headers);
    } else {
      throw new Error(`MCP 服务器 ${name} 不支持的传输方式: ${config.transport}`);
    }

    const client = new MCPClient(transport);
    await client.initialize();
    this.clients.set(name, client);

    const toolDefs = await client.listTools();
    return toolDefs.map((def) => new MCPToolAdapter(client, def, name));
  }

  /** 关闭所有连接 */
  closeAll(): void {
    for (const [, client] of this.clients) {
      client.close();
    }
    this.clients.clear();
  }
}
