/**
 * MCP 安全策略
 * Denylist/Allowlist 三层门控
 */

import type { MCPServerConfig } from "../config/config.ts";
import type { McpPolicy, McpPolicyEntry, ScopedMcpServerConfig } from "./types.ts";
import { expandConfigEnvVars } from "./env-expansion.ts";

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
  rawConfig: MCPServerConfig | ScopedMcpServerConfig,
  policy: McpPolicy,
): boolean {
  // D2：拿「实际会用的那个值」过闸，不拿模板过闸。
  // createTransport 建连前会对 command/args/url 做 ${VAR} 展开；若这里匹配原文模板，
  // `"url": "${EVIL_URL}"` 能穿过 denylist，合法站点写成模板又会被 allowlist 误拦。
  // 展开结果只用于匹配、不外传，避免展开后的密钥进日志。
  const config = expandForPolicy(rawConfig);

  // 第一层: Denylist（绝对否决）
  if (isServerDenied(name, config, policy.deniedServers)) return false;

  // 第二层: Allowlist（若定义，必须匹配）
  if (policy.allowedServers) {
    if (policy.allowedServers.length === 0) return false;
    return isServerInAllowlist(name, config, policy.allowedServers);
  }

  return true;
}

/** 按 createTransport 的同一规则展开参与策略匹配的字段（副本，不改原配置；D4 收成单一入口） */
function expandForPolicy(
  config: MCPServerConfig | ScopedMcpServerConfig,
): MCPServerConfig | ScopedMcpServerConfig {
  return expandConfigEnvVars(config).config;
}
