/**
 * MCP 管理器
 * 管理多个 MCP 服务器连接，收集所有可用工具
 */

import type { MCPServerConfig } from "../config/config.ts";
import type { Tool, ToolResult } from "../tool/types.ts";
import type { MCPToolDefinition } from "./types.ts";
import { MCPClient } from "./client.ts";
import { StdioTransport, HTTPTransport, SSETransport } from "./transport.ts";
import { getLogger } from "../debug/logger.ts";

/** 服务器状态信息 */
export interface MCPServerStatus {
  name: string;
  connected: boolean;
  connecting: boolean;
  toolCount: number;
  transport: string;
  error?: string;
}

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
  private serverConfigs = new Map<string, MCPServerConfig>();
  private serverToolCounts = new Map<string, number>();
  private serverErrors = new Map<string, string>();
  /** 正在连接中的服务器 */
  private connecting = new Set<string>();
  /** 工具变更时的回调（供外部刷新工具列表） */
  onToolsRefresh?: (serverName: string, tools: Tool[]) => void;

  /** 连接所有配置的 MCP 服务器 */
  async connectAll(servers: Record<string, MCPServerConfig>): Promise<Tool[]> {
    const log = getLogger();
    const allTools: Tool[] = [];

    // 过滤 enabled === false 的服务器
    const entries = Object.entries(servers).filter(
      ([, config]) => config.enabled !== false,
    );
    const skipped = Object.keys(servers).length - entries.length;
    if (skipped > 0) {
      log.info("MCP", `跳过 ${skipped} 个已禁用的 MCP 服务器`);
    }

    if (entries.length === 0) return allTools;

    log.info("MCP", `开始连接 ${entries.length} 个 MCP 服务器`);

    // 并行连接所有服务器（每个服务器有独立超时保护）
    const results = await Promise.allSettled(
      entries.map(async ([name, config]) => {
        this.serverConfigs.set(name, config);
        this.connecting.add(name);
        const connectTimeout = config.timeout ?? 30000;
        try {
          log.debug("MCP", `连接服务器: ${name}`, config);
          const tools = await Promise.race([
            this.connect(name, config),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`连接超时 (${connectTimeout}ms)`)), connectTimeout)
            ),
          ]);
          this.connecting.delete(name);
          log.info("MCP", `${name} 连接成功，注册 ${tools.length} 个工具`);
          this.serverToolCounts.set(name, tools.length);
          return { name, tools };
        } catch (err: any) {
          this.connecting.delete(name);
          // 超时或连接失败，清理已创建的 client/transport
          const client = this.clients.get(name);
          if (client) {
            client.close();
            this.clients.delete(name);
          }
          log.error("MCP", `连接 ${name} 失败`, { error: err.message, stack: err.stack });
          this.serverErrors.set(name, err.message);
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
    const timeout = config.timeout ?? 30000;
    const retries = config.retries ?? 2;
    let transport;

    if (config.transport === "stdio") {
      if (!config.command) {
        throw new Error(`MCP 服务器 ${name} 缺少 command 配置`);
      }
      transport = new StdioTransport(config.command, config.args, config.env, timeout);
    } else if (config.transport === "http") {
      if (!config.url) {
        throw new Error(`MCP 服务器 ${name} 缺少 url 配置`);
      }
      transport = new HTTPTransport(config.url, config.headers, timeout);
    } else if (config.transport === "sse") {
      if (!config.url) {
        throw new Error(`MCP 服务器 ${name} 缺少 url 配置`);
      }
      transport = new SSETransport(config.url, config.headers, timeout);
    } else {
      throw new Error(`MCP 服务器 ${name} 不支持的传输方式: ${config.transport}`);
    }

    const client = new MCPClient(transport, { timeout, retries });

    // 监听工具变更通知
    client.onToolsChanged = async () => {
      const log = getLogger();
      log.info("MCP", `${name} 工具列表变更，刷新中...`);
      try {
        const toolDefs = await client.listTools();
        const tools = toolDefs.map((def) => new MCPToolAdapter(client, def, name));
        this.serverToolCounts.set(name, tools.length);
        this.onToolsRefresh?.(name, tools);
        log.info("MCP", `${name} 工具列表已刷新，共 ${tools.length} 个工具`);
      } catch (err: any) {
        log.error("MCP", `${name} 刷新工具列表失败: ${err.message}`);
      }
    };

    await client.initialize();
    this.clients.set(name, client);

    const toolDefs = await client.listTools();
    return toolDefs.map((def) => new MCPToolAdapter(client, def, name));
  }

  /** 获取所有服务器状态 */
  getStatus(): MCPServerStatus[] {
    const statuses: MCPServerStatus[] = [];

    for (const [name, config] of this.serverConfigs) {
      const connected = this.clients.has(name);
      const isConnecting = this.connecting.has(name);
      const error = this.serverErrors.get(name);
      statuses.push({
        name,
        connected,
        connecting: isConnecting,
        toolCount: this.serverToolCounts.get(name) ?? 0,
        transport: config.transport,
        error,
      });
    }

    return statuses;
  }

  /** 关闭所有连接 */
  closeAll(): void {
    for (const [, client] of this.clients) {
      client.close();
    }
    this.clients.clear();
  }
}
