/**
 * MCP 协议类型定义
 * JSON-RPC 2.0 + MCP 扩展类型
 */

/** JSON-RPC 2.0 请求 */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 响应 */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: JsonRpcError;
}

/** JSON-RPC 2.0 错误 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** MCP 服务器能力 */
export interface ServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
}

/** MCP 初始化结果 */
export interface InitializeResult {
  protocolVersion: string;
  capabilities: ServerCapabilities;
  serverInfo: { name: string; version: string };
  instructions?: string;
}

/** MCP Tool Annotations (2025-03-26 规范) */
export interface MCPToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** MCP 工具定义 */
export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: MCPToolAnnotations;
}

/** MCP 工具列表结果 */
export interface ListToolsResult {
  tools: MCPToolDefinition[];
}

/** MCP 工具调用结果 */
export interface CallToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

/** MCP 服务器连接状态 */
export enum MCPConnectionStatus {
  DISCONNECTED = "disconnected",
  CONNECTING = "connecting",
  CONNECTED = "connected",
  RECONNECTING = "reconnecting",
  FAILED = "failed",
  /**
   * D21：需要 OAuth 授权（无可用 token、或交互式授权超时 / 被取消）。
   * 与 FAILED 分开，是为了让 /mcp 面板能区分「点一下授权就能用」和「配置写错了」。
   * half-open 探测只探 FAILED，不探它——探测会再弹一次授权，等于定时骚扰用户。
   */
  NEEDS_AUTH = "needs_auth",
  /** 配置里 enabled:false；connectAll 登记但不建连，面板里照常显示 */
  DISABLED = "disabled",
}

/** MCP 资源定义 */
export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** MCP 资源列表结果 */
export interface ListResourcesResult {
  resources: MCPResource[];
}

/** MCP 资源读取结果 */
export interface ReadResourceResult {
  contents: Array<{
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  }>;
}

/** MCP 提示词定义 */
export interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

/** MCP 提示词列表结果 */
export interface ListPromptsResult {
  prompts: MCPPrompt[];
}

/** MCP 提示词获取结果 */
export interface GetPromptResult {
  description?: string;
  messages: Array<{
    role: "user" | "assistant";
    content: { type: string; text?: string; data?: string; mimeType?: string };
  }>;
}

// ─── 配置 Scope 体系 ───

export type ConfigScope = "user" | "project" | "local" | "dynamic";

/** 带 Scope 标记的 MCP 服务器配置 */
export interface ScopedMcpServerConfig {
  transport: "stdio" | "http" | "http-json" | "sse" | "ws";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  timeout?: number;
  retries?: number;
  includeTools?: string[];
  excludeTools?: string[];
  auth?: "sid-backend";
  scope: ConfigScope;
}

// ─── Elicitation ───

export interface ElicitRequest {
  method: "elicitation/create";
  params: {
    message: string;
    requestedSchema?: Record<string, unknown>;
    url?: string;
  };
}

export interface ElicitResult {
  /**
   * MCP 规范三态：accept = 用户确认并（表单时）提交了 content；
   * decline = 用户明确拒绝 / 当前无法向用户提问；cancel = 用户放弃（关窗 / ESC）。
   */
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

// ─── 安全策略 ───

export interface McpPolicyEntry {
  name?: string;
  command?: string[];
  url?: string;
}

export interface McpPolicy {
  deniedServers?: McpPolicyEntry[];
  allowedServers?: McpPolicyEntry[];
}
