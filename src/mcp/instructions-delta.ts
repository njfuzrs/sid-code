/**
 * MCP 指令增量通知
 * 当 MCP Server 在对话过程中连接成功时，instructions 以增量方式注入
 */

import type { MCPServerStatusInfo } from "./manager.ts";

/**
 * 获取新连接的 MCP Server instructions（尚未通知过的）
 */
export function getMcpInstructionsDelta(
  serverStatuses: MCPServerStatusInfo[],
  announcedServers: Set<string>,
): { added: string[]; blocks: string[] } | null {
  const connected = serverStatuses.filter(
    s => s.status === 'connected' && s.instructions && !announcedServers.has(s.name)
  );
  if (connected.length === 0) return null;

  return {
    added: connected.map(s => s.name),
    blocks: connected.map(s => `## ${s.name}\n${s.instructions}`),
  };
}

/**
 * 构建 MCP 指令 System Prompt section
 */
export function buildMcpInstructionsSection(
  serverStatuses: MCPServerStatusInfo[],
): string {
  const connected = serverStatuses.filter(
    s => s.status === 'connected' && s.instructions
  );
  if (connected.length === 0) return '';

  const blocks = connected.map(
    s => `## ${s.name}\n${s.instructions}`
  ).join('\n\n');

  return `# MCP Server Instructions\n\n以下 MCP 服务器提供了使用说明，请在使用对应工具时遵循这些指令：\n\n${blocks}`;
}
