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
}

/** MCP 工具定义 */
export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** MCP 工具列表结果 */
export interface ListToolsResult {
  tools: MCPToolDefinition[];
}

/** MCP 工具调用结果 */
export interface CallToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}
