/**
 * 插件作用域前缀工具
 *
 * 防止插件提供的组件与用户手动配置的组件冲突：
 * - MCP 服务器：my-server → plugin:my-plugin:my-server
 * - 命令/Skill：deploy → my-plugin:deploy（在 loadPluginCommands 中处理）
 */

import type { MCPServerConfig } from "@sid-code/core/config/config.ts";

/** MCP 服务器作用域前缀 */
export const PLUGIN_MCP_PREFIX = "plugin:";

/**
 * 给一组 MCP 服务器配置添加插件作用域前缀
 * my-server → plugin:my-plugin:my-server
 */
export function addPluginScopeToServers(
  servers: Record<string, MCPServerConfig>,
  pluginName: string,
): Record<string, MCPServerConfig> {
  const scoped: Record<string, MCPServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    const scopedName = `${PLUGIN_MCP_PREFIX}${pluginName}:${name}`;
    scoped[scopedName] = { ...config };
  }
  return scoped;
}

/** 判断一个 MCP 服务器名是否为插件作用域 */
export function isPluginScopedServer(serverName: string): boolean {
  return serverName.startsWith(PLUGIN_MCP_PREFIX);
}
