/**
 * MCP 管理器
 * 管理多个 MCP 服务器连接，收集所有可用工具
 * 支持：状态枚举、工具过滤、Resources/Prompts、断线重连、健康检查
 */

import type { MCPServerConfig } from "../config/config.ts";
import type { Tool, ToolResult } from "../tool/types.ts";
import type { MCPToolDefinition, MCPResource, MCPPrompt } from "./types.ts";
import { MCPConnectionStatus } from "./types.ts";
import { MCPClient } from "./client.ts";
import { StdioTransport, HTTPTransport, SSETransport } from "./transport.ts";
import { getLogger } from "../debug/logger.ts";

/** 重连配置 */
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY = 1000; // ms
/** 健康检查间隔 */
const HEARTBEAT_INTERVAL = 30_000; // ms

/** 服务器状态信息 */
export interface MCPServerStatusInfo {
  name: string;
  status: MCPConnectionStatus;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  transport: string;
  error?: string;
  reconnectAttempts?: number;
}

/** 向后兼容 */
export type MCPServerStatus = MCPServerStatusInfo;

/** 单个服务器的运行时状态 */
interface ServerState {
  status: MCPConnectionStatus;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  error?: string;
  reconnectAttempts: number;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  resources: MCPResource[];
  prompts: MCPPrompt[];
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

/** 工具过滤：根据 includeTools/excludeTools 配置过滤工具列表 */
function filterTools(tools: MCPToolDefinition[], config: MCPServerConfig): MCPToolDefinition[] {
  if (config.includeTools?.length) {
    return tools.filter(t => config.includeTools!.includes(t.name));
  }
  if (config.excludeTools?.length) {
    return tools.filter(t => !config.excludeTools!.includes(t.name));
  }
  return tools;
}

export class MCPManager {
  private clients = new Map<string, MCPClient>();
  private serverConfigs = new Map<string, MCPServerConfig>();
  private serverStates = new Map<string, ServerState>();
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
        this.setStatus(name, MCPConnectionStatus.CONNECTING);
        const connectTimeout = config.timeout ?? 30000;
        try {
          log.debug("MCP", `连接服务器: ${name}`, config);
          const tools = await Promise.race([
            this.connect(name, config),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`连接超时 (${connectTimeout}ms)`)), connectTimeout)
            ),
          ]);
          this.setStatus(name, MCPConnectionStatus.CONNECTED);
          log.info("MCP", `${name} 连接成功，注册 ${tools.length} 个工具`);
          return { name, tools };
        } catch (err: any) {
          // 超时或连接失败，清理已创建的 client/transport
          const client = this.clients.get(name);
          if (client) {
            client.close();
            this.clients.delete(name);
          }
          log.error("MCP", `连接 ${name} 失败`, { error: err.message, stack: err.stack });
          this.setStatus(name, MCPConnectionStatus.FAILED, err.message);
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
    const transport = this.createTransport(name, config);
    const timeout = config.timeout ?? 30000;
    const retries = config.retries ?? 2;
    const client = new MCPClient(transport, { timeout, retries });

    // 监听工具变更通知
    client.onToolsChanged = () => this.refreshTools(name);
    // 监听资源变更通知
    client.onResourcesChanged = () => this.refreshResources(name);
    // 监听提示词变更通知
    client.onPromptsChanged = () => this.refreshPrompts(name);
    // 监听断线事件
    client.onDisconnected = () => this.handleDisconnect(name);

    await client.initialize();
    this.clients.set(name, client);

    // 发现工具（带过滤）
    const toolDefs = filterTools(await client.listTools(), config);
    const tools = toolDefs.map((def) => new MCPToolAdapter(client, def, name));
    this.getState(name).toolCount = tools.length;

    // 发现资源
    await this.refreshResources(name);
    // 发现提示词
    await this.refreshPrompts(name);

    // 启动健康检查（仅 stdio/SSE 有状态连接）
    if (config.transport === "stdio" || config.transport === "sse") {
      this.startHeartbeat(name);
    }

    return tools;
  }

  /** 创建传输层 */
  private createTransport(name: string, config: MCPServerConfig) {
    const timeout = config.timeout ?? 30000;

    if (config.transport === "stdio") {
      if (!config.command) {
        throw new Error(`MCP 服务器 ${name} 缺少 command 配置`);
      }
      return new StdioTransport(config.command, config.args, config.env, timeout);
    } else if (config.transport === "http") {
      if (!config.url) {
        throw new Error(`MCP 服务器 ${name} 缺少 url 配置`);
      }
      return new HTTPTransport(config.url, config.headers, timeout);
    } else if (config.transport === "sse") {
      if (!config.url) {
        throw new Error(`MCP 服务器 ${name} 缺少 url 配置`);
      }
      return new SSETransport(config.url, config.headers, timeout);
    } else {
      throw new Error(`MCP 服务器 ${name} 不支持的传输方式: ${config.transport}`);
    }
  }

  // ─── 工具刷新 ───

  private async refreshTools(name: string): Promise<void> {
    const log = getLogger();
    const client = this.clients.get(name);
    const config = this.serverConfigs.get(name);
    if (!client || !config) return;

    log.info("MCP", `${name} 工具列表变更，刷新中...`);
    try {
      const toolDefs = filterTools(await client.listTools(), config);
      const tools = toolDefs.map((def) => new MCPToolAdapter(client, def, name));
      this.getState(name).toolCount = tools.length;
      this.onToolsRefresh?.(name, tools);
      log.info("MCP", `${name} 工具列表已刷新，共 ${tools.length} 个工具`);
    } catch (err: any) {
      log.error("MCP", `${name} 刷新工具列表失败: ${err.message}`);
    }
  }

  // ─── Resources 支持 ───

  private async refreshResources(name: string): Promise<void> {
    const log = getLogger();
    const client = this.clients.get(name);
    if (!client) return;

    try {
      const resources = await client.listResources();
      const state = this.getState(name);
      state.resources = resources;
      state.resourceCount = resources.length;
      if (resources.length > 0) {
        log.info("MCP", `${name} 发现 ${resources.length} 个资源`);
      }
    } catch {
      // 服务器可能不支持 resources，静默忽略
    }
  }

  /** 读取指定服务器的资源 */
  async readResource(serverName: string, uri: string): Promise<string> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP 服务器 ${serverName} 未连接`);
    }
    const result = await client.readResource(uri);
    // 拼接所有文本内容
    return result.contents
      .map(c => c.text ?? (c.blob ? `[二进制数据 ${c.mimeType || "unknown"}]` : ""))
      .join("\n");
  }

  /** 获取所有服务器的资源列表 */
  getAllResources(): Array<{ serverName: string; resource: MCPResource }> {
    const result: Array<{ serverName: string; resource: MCPResource }> = [];
    for (const [name, state] of this.serverStates) {
      for (const resource of state.resources) {
        result.push({ serverName: name, resource });
      }
    }
    return result;
  }

  // ─── Prompts 支持 ───

  private async refreshPrompts(name: string): Promise<void> {
    const log = getLogger();
    const client = this.clients.get(name);
    if (!client) return;

    try {
      const prompts = await client.listPrompts();
      const state = this.getState(name);
      state.prompts = prompts;
      state.promptCount = prompts.length;
      if (prompts.length > 0) {
        log.info("MCP", `${name} 发现 ${prompts.length} 个提示词`);
      }
    } catch {
      // 服务器可能不支持 prompts，静默忽略
    }
  }

  /** 获取指定服务器的提示词内容 */
  async getPrompt(serverName: string, promptName: string, args?: Record<string, string>): Promise<Array<{ role: string; content: string }>> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP 服务器 ${serverName} 未连接`);
    }
    const result = await client.getPrompt(promptName, args);
    return result.messages.map(m => ({
      role: m.role,
      content: m.content.text ?? "",
    }));
  }

  /** 获取所有服务器的提示词列表 */
  getAllPrompts(): Array<{ serverName: string; prompt: MCPPrompt }> {
    const result: Array<{ serverName: string; prompt: MCPPrompt }> = [];
    for (const [name, state] of this.serverStates) {
      for (const prompt of state.prompts) {
        result.push({ serverName: name, prompt });
      }
    }
    return result;
  }

  // ─── 断线重连 ───

  private async handleDisconnect(name: string): Promise<void> {
    const log = getLogger();
    const config = this.serverConfigs.get(name);
    const state = this.getState(name);

    // HTTP 无状态，不需要重连
    if (!config || config.transport === "http") return;
    // 已经在重连或已永久失败
    if (state.status === MCPConnectionStatus.RECONNECTING || state.status === MCPConnectionStatus.FAILED) return;

    log.warn("MCP", `${name} 连接断开，开始重连...`);
    this.setStatus(name, MCPConnectionStatus.RECONNECTING);
    this.stopHeartbeat(name);

    // 清理旧 client
    const oldClient = this.clients.get(name);
    if (oldClient) {
      try { oldClient.close(); } catch {}
      this.clients.delete(name);
    }

    while (state.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      state.reconnectAttempts++;
      const delay = RECONNECT_BASE_DELAY * Math.pow(2, state.reconnectAttempts - 1)
        * (0.7 + Math.random() * 0.6); // ±30% jitter
      log.info("MCP", `${name} 第 ${state.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} 次重连，等待 ${Math.round(delay)}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));

      try {
        const tools = await this.connect(name, config);
        state.reconnectAttempts = 0;
        this.setStatus(name, MCPConnectionStatus.CONNECTED);
        log.info("MCP", `${name} 重连成功，注册 ${tools.length} 个工具`);
        this.onToolsRefresh?.(name, tools);
        return;
      } catch (err: any) {
        log.warn("MCP", `${name} 重连失败: ${err.message}`);
        // 清理失败的 client
        const client = this.clients.get(name);
        if (client) {
          try { client.close(); } catch {}
          this.clients.delete(name);
        }
      }
    }

    // 超过最大重试次数
    log.error("MCP", `${name} 超过最大重连次数 (${MAX_RECONNECT_ATTEMPTS})，标记为失败`);
    this.setStatus(name, MCPConnectionStatus.FAILED, "超过最大重连次数");
  }

  // ─── 健康检查 ───

  private startHeartbeat(name: string): void {
    const state = this.getState(name);
    this.stopHeartbeat(name); // 清理旧的

    state.heartbeatTimer = setInterval(async () => {
      const client = this.clients.get(name);
      if (!client) {
        this.stopHeartbeat(name);
        return;
      }

      const alive = await client.ping();
      if (!alive) {
        const log = getLogger();
        log.warn("MCP", `${name} 健康检查失败，触发重连`);
        this.stopHeartbeat(name);
        this.handleDisconnect(name);
      }
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(name: string): void {
    const state = this.serverStates.get(name);
    if (state?.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = undefined;
    }
  }

  // ─── 状态管理 ───

  private getState(name: string): ServerState {
    let state = this.serverStates.get(name);
    if (!state) {
      state = {
        status: MCPConnectionStatus.DISCONNECTED,
        toolCount: 0,
        resourceCount: 0,
        promptCount: 0,
        reconnectAttempts: 0,
        resources: [],
        prompts: [],
      };
      this.serverStates.set(name, state);
    }
    return state;
  }

  private setStatus(name: string, status: MCPConnectionStatus, error?: string): void {
    const state = this.getState(name);
    state.status = status;
    if (error !== undefined) {
      state.error = error;
    } else if (status === MCPConnectionStatus.CONNECTED) {
      state.error = undefined;
    }
  }

  /** 获取所有服务器状态 */
  getStatus(): MCPServerStatusInfo[] {
    const statuses: MCPServerStatusInfo[] = [];

    for (const [name, config] of this.serverConfigs) {
      const state = this.getState(name);
      statuses.push({
        name,
        status: state.status,
        toolCount: state.toolCount,
        resourceCount: state.resourceCount,
        promptCount: state.promptCount,
        transport: config.transport,
        error: state.error,
        reconnectAttempts: state.reconnectAttempts > 0 ? state.reconnectAttempts : undefined,
      });
    }

    return statuses;
  }

  /** 关闭所有连接 */
  closeAll(): void {
    // 停止所有心跳
    for (const [name] of this.serverStates) {
      this.stopHeartbeat(name);
    }
    for (const [, client] of this.clients) {
      client.close();
    }
    this.clients.clear();
  }
}
