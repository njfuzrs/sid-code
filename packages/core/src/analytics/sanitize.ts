// src/analytics/sanitize.ts
// 工具名 / 文件路径脱敏——用于分析,防止 PII/配置信息泄露
//
// 对应 spec 17 §4.3。

import { PROTECTED_PREFIX } from "./privacy.ts";

/**
 * 脱敏工具名用于分析。
 * MCP 工具名格式:mcp__<server>__<tool>
 * 脱敏规则:MCP 工具 → "mcp_tool",内置工具保持原名。
 */
export function sanitizeToolName(toolName: string): string {
  if (toolName.startsWith("mcp__")) {
    return "mcp_tool";
  }
  // 内置工具(read, write, edit, bash, grep, glob)保持原名
  return toolName;
}

/**
 * 为 MCP 工具生成分析用的详细信息。
 * 返回 _PROTECTED_* 字段,仅特权后端可见。
 */
export function mcpToolDetailsForAnalytics(
  toolName: string,
  serverName?: string,
): Record<string, string> {
  if (!toolName.startsWith("mcp__")) return {};

  // 解析 mcp__<server>__<tool> 格式
  const parts = toolName.split("__");
  const server = parts[1] ?? "unknown";
  const tool = parts[2] ?? "unknown";

  return {
    [`${PROTECTED_PREFIX}mcp_server`]: server,
    [`${PROTECTED_PREFIX}mcp_tool`]: tool,
    ...(serverName ? { [`${PROTECTED_PREFIX}mcp_server_name`]: serverName } : {}),
  };
}

/**
 * 从文件路径中安全提取扩展名。
 * 扩展名超过 10 字符 → "other"(防止哈希文件名泄露)。
 */
export function safeFileExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot === -1) return "none";

  const ext = filePath.slice(lastDot + 1).toLowerCase();
  if (ext.length === 0 || ext.length > 10) return "other";
  return ext;
}
