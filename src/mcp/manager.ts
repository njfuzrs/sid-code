/**
 * MCP 管理器
 * 管理多个 MCP 服务器连接，收集所有可用工具
 * 支持：联合类型状态机、工具过滤、Resources/Prompts、差异化重连、健康检查
 * 并发控制：本地/远程分流、pMap 动态调度
 * 工具桥接：annotations 映射、描述截断、大结果处理
 */

import type { MCPServerConfig } from "../config/config.ts";
import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "../tool/types.ts";
import type { MCPToolDefinition, MCPResource, MCPPrompt } from "./types.ts";
import { MCPConnectionStatus } from "./types.ts";
import { MCPClient } from "./client.ts";
import { StdioTransport, HTTPTransport, SSETransport, WebSocketTransport } from "./transport.ts";
import { buildMcpToolName } from "./normalization.ts";
import { expandEnvVars } from "./env-expansion.ts";
import { getLogger } from "../debug/logger.ts";
import { join } from "path";
import { ensureSidTempDir } from "../utils/temp-dir.ts";
import {
  isOAuthEnabled,
  getValidAccessToken,
  performOAuthFlow,
  NeedsAuthorizationError,
} from "./oauth.ts";

/** 重连配置 */
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY = 1000; // ms
/** 健康检查间隔 */
const HEARTBEAT_INTERVAL = 30_000; // ms
/** 工具描述截断上限 */
const MAX_MCP_DESCRIPTION_LENGTH = 2048;
/** 工具结果大小上限 */
const MAX_RESULT_SIZE = 100_000;
/** 本地 stdio 并发上限 */
const LOCAL_BATCH_SIZE = 3;
/** 远程连接并发上限 */
const REMOTE_BATCH_SIZE = 20;
/** Server instructions 截断上限 */
const MAX_INSTRUCTIONS_LENGTH = 2048;

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
  instructions?: string;
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
  instructions?: string;
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
    return buildMcpToolName(this.serverName, this.def.name);
  }

  description(): string {
    const desc = this.def.description ?? '';
    if (desc.length > MAX_MCP_DESCRIPTION_LENGTH) {
      return desc.slice(0, MAX_MCP_DESCRIPTION_LENGTH) + '… [截断]';
    }
    return desc;
  }

  inputSchema(): Record<string, unknown> {
    return this.def.inputSchema;
  }

  readOnly(): boolean {
    return this.def.annotations?.readOnlyHint ?? false;
  }

  isConcurrencySafe(): boolean {
    return this.def.annotations?.readOnlyHint ?? false;
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    try {
      const result = await this.client.callTool(
        this.def.name,
        input as Record<string, unknown>,
        signal,
      );

      const text = result.content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!)
        .join("\n");

      if (text.length > MAX_RESULT_SIZE) {
        const tmpPath = join(ensureSidTempDir(), `mcp-result-${Date.now()}.txt`);
        await Bun.write(tmpPath, text);
        return {
          output: `结果过大 (${text.length} 字符)，已保存到: ${tmpPath}\n\n前 2000 字符预览:\n${text.slice(0, 2000)}`,
          isError: false,
        };
      }

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

/** 简易 pMap：并发控制的 Promise.all */
async function pMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

/** 截断 instructions */
function truncateInstructions(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw.length > MAX_INSTRUCTIONS_LENGTH) {
    return raw.slice(0, MAX_INSTRUCTIONS_LENGTH) + '… [截断]';
  }
  return raw;
}

export class MCPManager {
  private clients = new Map<string, MCPClient>();
  private serverConfigs = new Map<string, MCPServerConfig>();
  private serverStates = new Map<string, ServerState>();
  /** 工具变更时的回调（供外部刷新工具列表） */
  onToolsRefresh?: (serverName: string, tools: Tool[]) => void;
  /**
   * OAuth 需要用户授权时的回调（供 UI 展示授权 URL / 打开浏览器）。
   * 返回的 Promise 由实现方决定何时 resolve（通常立即 resolve，授权在后台完成）。
   * 未设置时，OAuth 流程会把 URL 写入日志，用户需手动打开。
   */
  onOAuthAuthorizationUrl?: (serverName: string, url: string) => void;

  /** 连接所有配置的 MCP 服务器（本地/远程分流并发控制） */
  async connectAll(servers: Record<string, MCPServerConfig>): Promise<Tool[]> {
    const log = getLogger();
    const allTools: Tool[] = [];

    const entries = Object.entries(servers).filter(
      ([, config]) => config.enabled !== false,
    );
    const skipped = Object.keys(servers).length - entries.length;
    if (skipped > 0) {
      log.info("MCP", `跳过 ${skipped} 个已禁用的 MCP 服务器`);
    }

    if (entries.length === 0) return allTools;

    log.info("MCP", `开始连接 ${entries.length} 个 MCP 服务器`);

    const local = entries.filter(([, c]) => c.transport === "stdio");
    const remote = entries.filter(([, c]) => c.transport !== "stdio");

    const connectOne = async ([name, config]: [string, MCPServerConfig]): Promise<Tool[]> => {
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
        return tools;
      } catch (err: any) {
        const client = this.clients.get(name);
        if (client) {
          client.close();
          this.clients.delete(name);
        }
        log.error("MCP", `连接 ${name} 失败`, { error: err.message, stack: err.stack });
        this.setStatus(name, MCPConnectionStatus.FAILED, err.message);
        return [];
      }
    };

    const [localResults, remoteResults] = await Promise.all([
      pMap(local, connectOne, LOCAL_BATCH_SIZE),
      pMap(remote, connectOne, REMOTE_BATCH_SIZE),
    ]);

    for (const tools of [...localResults, ...remoteResults]) {
      allTools.push(...tools);
    }

    return allTools;
  }

  /** 连接单个 MCP 服务器 */
  async connect(name: string, config: MCPServerConfig): Promise<Tool[]> {
    // OAuth 服务器：连接前确保拿到有效 token；首连/凭据失效时触发交互式授权
    if (isOAuthEnabled(config) && config.transport !== "stdio") {
      await this.ensureOAuthToken(name, config);
    }

    try {
      return await this.doConnect(name, config);
    } catch (err: any) {
      // 401 / 需授权：触发一次交互式 OAuth 后重连
      if (isOAuthEnabled(config) && config.transport !== "stdio" && this.isAuthError(err)) {
        getLogger().info("MCP", `${name} 返回未授权，启动 OAuth 授权流程`);
        await this.runOAuthFlow(name, config);
        return await this.doConnect(name, config);
      }
      throw err;
    }
  }

  /** 实际建立连接（创建传输 + 初始化 + 发现工具/资源/提示词 + 健康检查） */
  private async doConnect(name: string, config: MCPServerConfig): Promise<Tool[]> {
    const transport = await this.createTransport(name, config);
    const timeout = config.timeout ?? 30000;
    const retries = config.retries ?? 2;
    const client = new MCPClient(transport, { timeout, retries });

    client.onToolsChanged = () => this.refreshTools(name);
    client.onResourcesChanged = () => this.refreshResources(name);
    client.onPromptsChanged = () => this.refreshPrompts(name);
    client.onDisconnected = () => this.handleDisconnect(name);

    const initResult = await client.initialize();
    this.clients.set(name, client);

    // 保存 Server instructions
    const state = this.getState(name);
    state.instructions = truncateInstructions(initResult.instructions);

    // 发现工具（带过滤）
    const toolDefs = filterTools(await client.listTools(), config);
    const tools = toolDefs.map((def) => new MCPToolAdapter(client, def, name));
    state.toolCount = tools.length;

    // 发现资源
    await this.refreshResources(name);
    // 发现提示词
    await this.refreshPrompts(name);

    // 启动健康检查（仅有状态连接）
    if (config.transport === "stdio" || config.transport === "sse" || config.transport === "ws") {
      this.startHeartbeat(name);
    }

    return tools;
  }

  /** 判断错误是否为「未授权」（401 / NeedsAuthorizationError） */
  private isAuthError(err: unknown): boolean {
    if (err instanceof NeedsAuthorizationError) return true;
    const msg = (err as Error)?.message ?? "";
    return /\b401\b/.test(msg) || /unauthorized/i.test(msg);
  }

  /**
   * 确保 OAuth 服务器有可用 token。
   * 已有有效 token（或可静默刷新）→ 直接返回；首连无凭据 → 触发交互式授权。
   */
  private async ensureOAuthToken(name: string, config: MCPServerConfig): Promise<void> {
    try {
      await getValidAccessToken(name, config);
    } catch (err) {
      if (err instanceof NeedsAuthorizationError) {
        await this.runOAuthFlow(name, config);
      } else {
        throw err;
      }
    }
  }

  /** 执行交互式 OAuth 授权流程（展示/打开授权 URL，等待用户完成） */
  private async runOAuthFlow(name: string, config: MCPServerConfig): Promise<void> {
    const log = getLogger();
    await performOAuthFlow(
      name,
      config,
      (url) => {
        if (this.onOAuthAuthorizationUrl) {
          this.onOAuthAuthorizationUrl(name, url);
        } else {
          log.info("MCP", `请在浏览器打开以下 URL 完成 ${name} 的 OAuth 授权:\n${url}`);
        }
      },
    );
  }

  /** 创建传输层 */
  private async createTransport(name: string, config: MCPServerConfig) {
    const timeout = config.timeout ?? 30000;

    // OAuth 服务器：注入 access token 为 Authorization 头（优先于静态 authToken）
    let oauthHeader: Record<string, string> | undefined;
    if (isOAuthEnabled(config) && config.transport !== "stdio") {
      try {
        const token = await getValidAccessToken(name, config);
        oauthHeader = { Authorization: `Bearer ${token}` };
      } catch (err) {
        // 拿不到 token 时不注入——交给 connect 的 401 重试逻辑触发授权
        if (!(err instanceof NeedsAuthorizationError)) {
          getLogger().warn("MCP", `${name} 获取 OAuth token 失败: ${(err as Error).message}`);
        }
      }
    }

    // IDE 动态注册场景：authToken 注入为 Authorization 头（对标 Claude Code sse-ide/ws-ide）
    const headers: Record<string, string> | undefined =
      oauthHeader || config.authToken || config.headers
        ? {
            ...config.headers,
            ...(config.authToken ? { Authorization: `Bearer ${config.authToken}` } : {}),
            ...oauthHeader, // OAuth token 优先级最高
          }
        : undefined;

    if (config.transport === "stdio") {
      if (!config.command) {
        throw new Error(`MCP 服务器 ${name} 缺少 command 配置`);
      }
      // 环境变量展开 command 和 args
      const { expanded: cmd } = expandEnvVars(config.command);
      const args = config.args?.map(a => expandEnvVars(a).expanded) ?? [];
      return new StdioTransport(cmd, args, config.env, timeout);
    } else if (config.transport === "http") {
      if (!config.url) {
        throw new Error(`MCP 服务器 ${name} 缺少 url 配置`);
      }
      const { expanded: url } = expandEnvVars(config.url);
      return new HTTPTransport(url, headers, timeout);
    } else if (config.transport === "sse") {
      if (!config.url) {
        throw new Error(`MCP 服务器 ${name} 缺少 url 配置`);
      }
      const { expanded: url } = expandEnvVars(config.url);
      return new SSETransport(url, headers, timeout);
    } else if (config.transport === "ws") {
      if (!config.url) {
        throw new Error(`MCP 服务器 ${name} 缺少 url 配置`);
      }
      const { expanded: url } = expandEnvVars(config.url);
      return new WebSocketTransport(url, headers, timeout);
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

  // ─── 断线重连（差异化策略） ───

  private async handleDisconnect(name: string): Promise<void> {
    const log = getLogger();
    const config = this.serverConfigs.get(name);
    const state = this.getState(name);

    if (!config || config.transport === "http") return;
    if (state.status === MCPConnectionStatus.RECONNECTING || state.status === MCPConnectionStatus.FAILED) return;

    this.stopHeartbeat(name);

    // 清理旧 client
    const oldClient = this.clients.get(name);
    if (oldClient) {
      try { oldClient.close(); } catch {}
      this.clients.delete(name);
    }

    // stdio: 不自动重连（子进程崩溃通常是配置错误）
    if (config.transport === "stdio") {
      log.warn("MCP", `${name} 子进程退出，标记为失败（stdio 不自动重连）`);
      this.setStatus(name, MCPConnectionStatus.FAILED, "子进程退出");
      return;
    }

    // 远程（SSE/WS/HTTP）: 指数退避自动重连
    log.warn("MCP", `${name} 连接断开，开始重连...`);
    this.setStatus(name, MCPConnectionStatus.RECONNECTING);

    while (state.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      state.reconnectAttempts++;
      const delay = RECONNECT_BASE_DELAY * Math.pow(2, state.reconnectAttempts - 1)
        * (0.7 + Math.random() * 0.6);
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
        const client = this.clients.get(name);
        if (client) {
          try { client.close(); } catch {}
          this.clients.delete(name);
        }
      }
    }

    log.error("MCP", `${name} 超过最大重连次数 (${MAX_RECONNECT_ATTEMPTS})，标记为失败`);
    this.setStatus(name, MCPConnectionStatus.FAILED, "超过最大重连次数");
  }

  // ─── 健康检查 ───

  private startHeartbeat(name: string): void {
    const state = this.getState(name);
    this.stopHeartbeat(name);

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
        instructions: state.instructions,
      });
    }

    return statuses;
  }

  /** 获取所有已连接服务器的 instructions（供 System Prompt 注入） */
  getServerInstructions(): Array<{ name: string; instructions: string }> {
    const result: Array<{ name: string; instructions: string }> = [];
    for (const [name, state] of this.serverStates) {
      if (state.status === MCPConnectionStatus.CONNECTED && state.instructions) {
        result.push({ name, instructions: state.instructions });
      }
    }
    return result;
  }

  /** 关闭所有连接 */
  closeAll(): void {
    for (const [name] of this.serverStates) {
      this.stopHeartbeat(name);
    }
    for (const [, client] of this.clients) {
      client.close();
    }
    this.clients.clear();
  }

  /** 断开指定名称的单个服务器连接（清理 client / state / config） */
  disconnect(name: string): void {
    this.stopHeartbeat(name);
    const client = this.clients.get(name);
    if (client) {
      try { client.close(); } catch {}
      this.clients.delete(name);
    }
    this.serverStates.delete(name);
    this.serverConfigs.delete(name);
  }

  /**
   * 重连插件作用域的 MCP 服务器（用于 /reload-plugins）。
   *
   * 1. 断开所有现存的 plugin: 前缀服务器（旧插件 MCP）
   * 2. 连接传入的新插件 MCP 服务器
   *
   * @param pluginServers 新的插件 MCP 服务器配置（已带 plugin:name:server 前缀）
   * @returns 新连接产生的工具列表
   */
  async reconnectPluginServers(
    pluginServers: Record<string, MCPServerConfig>,
  ): Promise<Tool[]> {
    // 1. 断开所有旧的插件作用域服务器
    const oldPluginServers = [...this.serverConfigs.keys()].filter((n) => n.startsWith("plugin:"));
    for (const name of oldPluginServers) {
      this.disconnect(name);
    }

    // 2. 连接新的插件服务器
    if (Object.keys(pluginServers).length === 0) return [];
    return this.connectAll(pluginServers);
  }

  // ─── 运行时动态增删（IDE 发现 / 用户手动管理 / Bridge 场景） ───

  /**
   * 运行时添加一个 MCP 服务器
   * 用于 IDE 发现后动态注册、用户手动添加等场景。
   * 幂等：同名服务器已存在时先移除再重连，避免连接泄漏。
   */
  async addServer(name: string, config: MCPServerConfig): Promise<Tool[]> {
    const log = getLogger();

    // 同名已存在 → 先清理
    if (this.clients.has(name) || this.serverConfigs.has(name)) {
      this.disconnect(name);
    }

    this.serverConfigs.set(name, config);
    this.setStatus(name, MCPConnectionStatus.CONNECTING);

    const connectTimeout = config.timeout ?? 30000;
    try {
      const tools = await Promise.race([
        this.connect(name, config),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`连接超时 (${connectTimeout}ms)`)), connectTimeout),
        ),
      ]);
      this.setStatus(name, MCPConnectionStatus.CONNECTED);
      log.info("MCP", `动态注册 ${name} 成功，注册 ${tools.length} 个工具`);
      this.onToolsRefresh?.(name, tools);
      return tools;
    } catch (err: any) {
      this.setStatus(name, MCPConnectionStatus.FAILED, err.message);
      const client = this.clients.get(name);
      if (client) {
        try { client.close(); } catch {}
        this.clients.delete(name);
      }
      log.error("MCP", `动态注册 ${name} 失败: ${err.message}`);
      return [];
    }
  }

  /**
   * 运行时移除一个 MCP 服务器
   * 用于 IDE 断开、用户手动移除等场景。清理所有状态后通知外部刷新（空工具列表）。
   */
  async removeServer(name: string): Promise<void> {
    this.disconnect(name);
    // 通知外部该服务器的工具全部移除
    this.onToolsRefresh?.(name, []);
  }

  /** 检查指定服务器是否已连接 */
  isConnected(name: string): boolean {
    return this.serverStates.get(name)?.status === MCPConnectionStatus.CONNECTED
      && this.clients.has(name);
  }

  /**
   * 直接调用指定服务器的工具（不经过 ToolRegistry）。
   * 用于 IDE RPC（openDiff / closeAllDiffTabs 等）等场景。
   * @returns 工具输出文本；服务器未连接或调用失败返回 null
   */
  async callServerTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ output: string; isError?: boolean } | null> {
    const client = this.clients.get(serverName);
    if (!client) return null;

    const result = await client.callTool(toolName, args, signal);
    const text = result.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");

    return { output: text || "", isError: result.isError };
  }

  /** 获取指定服务器的 MCPClient（供 IDE 通知处理器注册等场景） */
  getClient(serverName: string): MCPClient | undefined {
    return this.clients.get(serverName);
  }

  /**
   * 手动触发指定服务器的 OAuth 授权（供 /mcp authenticate 命令）。
   * 跑完交互式授权流程后重连，把真实工具刷新出来。
   * @returns 授权并重连后注册的工具列表
   * @throws 服务器未配置 OAuth、或非远程传输时抛错
   */
  async authenticate(name: string): Promise<Tool[]> {
    const config = this.serverConfigs.get(name);
    if (!config) {
      throw new Error(`未找到 MCP 服务器 "${name}"`);
    }
    if (!isOAuthEnabled(config)) {
      throw new Error(`MCP 服务器 "${name}" 未配置 OAuth（在配置中添加 oauth 字段）`);
    }
    if (config.transport === "stdio") {
      throw new Error(`stdio 传输的服务器 "${name}" 不支持 OAuth`);
    }

    // 先断开现有连接
    this.disconnect(name);
    this.serverConfigs.set(name, config);

    // 跑授权流程
    await this.runOAuthFlow(name, config);

    // 重连并刷新工具
    this.setStatus(name, MCPConnectionStatus.CONNECTING);
    const tools = await this.doConnect(name, config);
    this.setStatus(name, MCPConnectionStatus.CONNECTED);
    this.onToolsRefresh?.(name, tools);
    return tools;
  }

  /** 列出所有配置了 OAuth 的服务器名 */
  listOAuthServers(): string[] {
    const result: string[] = [];
    for (const [name, config] of this.serverConfigs) {
      if (isOAuthEnabled(config)) result.push(name);
    }
    return result;
  }
}
