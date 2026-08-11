/**
 * MCP 名称规范化与反向解析
 * API 要求工具名匹配: ^[a-zA-Z0-9_-]{1,64}$
 */

/**
 * 将 MCP Server/Tool 名称规范化为 API 合法格式
 */
export function normalizeMcpName(name: string): string {
  let normalized = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  normalized = normalized.replace(/_+/g, '_');
  normalized = normalized.replace(/^_|_$/g, '');
  if (normalized.length > 64) {
    normalized = normalized.slice(0, 64);
  }
  return normalized || 'unnamed';
}

/**
 * 构建全限定 MCP 工具名
 */
export function buildMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${normalizeMcpName(serverName)}__${normalizeMcpName(toolName)}`;
}

/**
 * 从全限定名解析出 serverName 和 toolName
 */
export function parseMcpToolName(fullName: string): {
  serverName: string;
  toolName: string | undefined;
} | null {
  const parts = fullName.split('__');
  const [prefix, serverName, ...toolParts] = parts;
  if (prefix !== 'mcp' || !serverName) return null;
  const toolName = toolParts.length > 0 ? toolParts.join('__') : undefined;
  return { serverName, toolName };
}

/**
 * 判断一个工具名是否是 MCP 工具
 */
export function isMcpTool(name: string): boolean {
  return name.startsWith('mcp__');
}
