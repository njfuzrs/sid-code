/**
 * MCP 安全策略
 * Denylist/Allowlist 三层门控
 */

import type { MCPServerConfig } from "../config/config.ts";
import type { McpPolicy, McpPolicyEntry, ScopedMcpServerConfig } from "./types.ts";

/**
 * 匹配 URL 通配符（支持 *.example.com/*）
 */
function matchUrlPattern(url: string, pattern: string): boolean {
  const regex = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${regex}$`).test(url);
}

/**
 * 检查 Server 是否匹配某个策略条目
 */
function matchesPolicyEntry(
  name: string,
  config: MCPServerConfig | ScopedMcpServerConfig,
  entry: McpPolicyEntry,
): boolean {
  if (entry.name && entry.name === name) return true;

  if (entry.command && config.command) {
    const configCmd = [config.command, ...(config.args || [])];
    if (JSON.stringify(entry.command) === JSON.stringify(configCmd)) return true;
  }

  if (entry.url && config.url) {
    if (matchUrlPattern(config.url, entry.url)) return true;
  }

  return false;
}

/**
 * 检查 Server 是否在 Denylist 中
 */
function isServerDenied(
  name: string,
  config: MCPServerConfig | ScopedMcpServerConfig,
  denylist?: McpPolicyEntry[],
): boolean {
  if (!denylist?.length) return false;
  return denylist.some((entry) => matchesPolicyEntry(name, config, entry));
}

/**
 * 检查 Server 是否在 Allowlist 中
 */
function isServerInAllowlist(
  name: string,
  config: MCPServerConfig | ScopedMcpServerConfig,
  allowlist: McpPolicyEntry[],
): boolean {
  return allowlist.some((entry) => matchesPolicyEntry(name, config, entry));
}

/**
 * 三层门控：Denylist → Allowlist → 放行
 */
export function isMcpServerAllowed(
  name: string,
  config: MCPServerConfig | ScopedMcpServerConfig,
  policy: McpPolicy,
): boolean {
  // 第一层: Denylist（绝对否决）
  if (isServerDenied(name, config, policy.deniedServers)) return false;

  // 第二层: Allowlist（若定义，必须匹配）
  if (policy.allowedServers) {
    if (policy.allowedServers.length === 0) return false;
    return isServerInAllowlist(name, config, policy.allowedServers);
  }

  return true;
}
