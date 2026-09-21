/**
 * MCP 名称规范化与反向解析
 *
 * API 要求工具名匹配: ^[a-zA-Z0-9_-]{1,64}$
 * （Anthropic / OpenAI function name 都是 64。超了要么 400，要么被服务端截断后
 * 与 registry 对不上——工具在列表里看得见、调用时失败。）
 *
 * `normalizeMcpName` 只清洗单段；64 的硬约束在 `buildMcpToolName` 对**最终全名**
 * 按段分预算。只对最终串 `slice(0, 64)` 会切掉第二个 `__`，`parseMcpToolName`
 * 就拆不出 tool 段。
 */

/** API 工具名长度上限（Anthropic / OpenAI 同口径） */
export const MCP_TOOL_NAME_MAX_LENGTH = 64;

/** API 工具名合法形态 */
export const MCP_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

const MCP_PREFIX = "mcp__";
const MCP_SEP = "__";
/** 去掉前缀和分隔符后，server + tool 两段合计可占用的字符数：64 - 5 - 2 = 57 */
const SEGMENT_BUDGET = MCP_TOOL_NAME_MAX_LENGTH - MCP_PREFIX.length - MCP_SEP.length;

/**
 * 将 MCP Server/Tool 名称规范化为 API 合法字符。
 *
 * 只清洗、不去卡最终全名长度——长度由 {@link buildMcpToolName} 按两段预算切。
 * `maxLength` 留给单段场景（测试 / 将来的 server 级匹配），默认仍 64。
 */
export function normalizeMcpName(name: string, maxLength = MCP_TOOL_NAME_MAX_LENGTH): string {
  let normalized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  normalized = normalized.replace(/_+/g, "_");
  normalized = normalized.replace(/^_|_$/g, "");
  if (normalized.length > maxLength) {
    normalized = normalized.slice(0, maxLength);
  }
  return normalized || "unnamed";
}

/**
 * 在合计 `budget` 内给两段分字符：短的一方尽量完整保留，剩余全给长的；
 * 两段都超则对半切（server 少拿 1 个给 tool，避免 tool 段被切成空）。
 */
function allocateSegmentBudget(server: string, tool: string, budget: number): [string, string] {
  if (server.length + tool.length <= budget) return [server, tool];
  const half = Math.floor(budget / 2);
  if (server.length <= half) return [server, tool.slice(0, budget - server.length)];
  if (tool.length <= half) return [server.slice(0, budget - tool.length), tool];
  return [server.slice(0, half), tool.slice(0, budget - half)];
}

/**
 * 构建全限定 MCP 工具名，保证匹配 `^[a-zA-Z0-9_-]{1,64}$`，且 `parseMcpToolName` 仍能拆出两段。
 */
export function buildMcpToolName(serverName: string, toolName: string): string {
  const [server, tool] = allocateSegmentBudget(
    normalizeMcpName(serverName),
    normalizeMcpName(toolName),
    SEGMENT_BUDGET,
  );
  return `${MCP_PREFIX}${server}${MCP_SEP}${tool}`;
}

/**
 * 从全限定名解析出 serverName 和 toolName
 */
export function parseMcpToolName(fullName: string): {
  serverName: string;
  toolName: string | undefined;
} | null {
  const parts = fullName.split("__");
  const [prefix, serverName, ...toolParts] = parts;
  if (prefix !== "mcp" || !serverName) return null;
  const toolName = toolParts.length > 0 ? toolParts.join("__") : undefined;
  return { serverName, toolName };
}

/**
 * 判断一个工具名是否是 MCP 工具
 */
export function isMcpTool(name: string): boolean {
  return name.startsWith("mcp__");
}
