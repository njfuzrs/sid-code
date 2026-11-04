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
 * 深拷贝一份 MCP 服务器配置。
 *
 * 缺陷 39：`addPluginScopeToServers` 原先用 `{ ...config }` 浅拷贝，嵌套的
 * `env` / `headers` / `args` 等仍是同一个引用。这个函数的唯一职责是**作用域隔离**，
 * 浅拷贝让隔离只做到一层：
 * - `manifest.mcpServers` 是 plugin.json 的 JSON.parse 结果，被 `LoadedPlugin.manifest`
 *   持有并缓存在 memoize 里。下游（MCPManager 注入 env、补默认值）一旦原地改，
 *   改的是 manifest 对象本身，一次加载的副作用污染后续所有读者；
 * - 两个插件声明同一个外部配置文件时，scoped config 会共享同一个 `env` 对象，
 *   一个插件的改动影响另一个。
 *
 * 只深拷已知的容器字段（其余都是标量），不引入通用的深拷贝工具。
 */
function cloneMcpServerConfig(config: MCPServerConfig): MCPServerConfig {
  return {
    ...config,
    ...(config.args ? { args: [...config.args] } : {}),
    ...(config.env ? { env: { ...config.env } } : {}),
    ...(config.headers ? { headers: { ...config.headers } } : {}),
    ...(config.includeTools ? { includeTools: [...config.includeTools] } : {}),
    ...(config.excludeTools ? { excludeTools: [...config.excludeTools] } : {}),
    // oauth 只含标量字段（见 MCPServerConfig / MCPOAuthConfig），浅拷贝已足够
    ...(config.oauth ? { oauth: { ...config.oauth } } : {}),
  };
}

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
    scoped[scopedName] = cloneMcpServerConfig(config);
  }
  return scoped;
}

/** 判断一个 MCP 服务器名是否为插件作用域 */
export function isPluginScopedServer(serverName: string): boolean {
  return serverName.startsWith(PLUGIN_MCP_PREFIX);
}
