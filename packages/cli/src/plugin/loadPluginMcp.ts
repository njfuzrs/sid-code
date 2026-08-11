/**
 * 插件 MCP 服务器加载：解析 manifest.mcpServers，做环境变量替换 + 作用域前缀
 *
 * 环境变量解析链：
 *   1. ${PLUGIN_ROOT}     → 插件磁盘路径
 *   2. ${user_config.X}   → 用户配置值（Phase 2 预留，暂未接入密钥链）
 *   3. ${VAR}             → 系统环境变量（交由 MCPManager 的 expandEnvVars 处理）
 *
 * 作用域前缀：my-server → plugin:my-plugin:my-server，防止与用户配置冲突。
 * 延迟加载：只在 MCPManager 需要时调用，结果填充到 plugin.mcpServers 缓存槽。
 */

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { isAbsolute, join } from "path";
import { getLogger } from "@sid-code/core/debug/logger.ts";
import { memoize } from "@sid-code/shared/utils/memoize.ts";
import type { MCPServerConfig } from "@sid-code/core/config/config.ts";
import { registerPluginCache } from "./caches.ts";
import { loadAllPluginsCacheOnly } from "./loader.ts";
import { addPluginScopeToServers } from "./scope.ts";
import type { LoadedPlugin, PluginError } from "./types.ts";

/** 对配置字符串做 ${PLUGIN_ROOT} 替换（其余 ${VAR} 交给 MCPManager） */
function resolvePluginRoot(value: string, pluginRoot: string): string {
  return value.replace(/\$\{PLUGIN_ROOT\}/g, pluginRoot);
}

/** 对单个 MCP 服务器配置做插件级变量替换 */
function resolvePluginMcpEnvironment(
  config: MCPServerConfig,
  pluginRoot: string,
): MCPServerConfig {
  const resolved: MCPServerConfig = { ...config };

  if (resolved.command) resolved.command = resolvePluginRoot(resolved.command, pluginRoot);
  if (resolved.url) resolved.url = resolvePluginRoot(resolved.url, pluginRoot);
  if (resolved.args) resolved.args = resolved.args.map((a) => resolvePluginRoot(a, pluginRoot));
  if (resolved.env) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(resolved.env)) {
      env[k] = resolvePluginRoot(v, pluginRoot);
    }
    resolved.env = env;
  }

  return resolved;
}

/** 从文件加载 MCP 服务器配置（支持 {mcpServers:{}} 或直接 {name:{}}） */
async function loadMcpServersFromFile(
  filePath: string,
  errors: PluginError[],
  source: string,
): Promise<Record<string, MCPServerConfig>> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const servers = parsed?.mcpServers || parsed?.mcp_servers || parsed;
    if (!servers || typeof servers !== "object") {
      errors.push({ type: "mcp-server-config-invalid", source, serverName: "(file)", error: "配置不是对象" });
      return {};
    }
    return servers as Record<string, MCPServerConfig>;
  } catch (err: any) {
    errors.push({ type: "mcp-server-config-invalid", source, serverName: "(file)", error: err.message });
    return {};
  }
}

/**
 * 加载单个插件的 MCP 服务器配置（带作用域前缀）
 * @returns 解析后的服务器配置，无配置返回 undefined
 */
export async function loadPluginMcpServers(
  plugin: LoadedPlugin,
  errors: PluginError[],
): Promise<Record<string, MCPServerConfig> | undefined> {
  // 内置插件的 mcpServers 已在 getBuiltinPlugins 中加前缀，直接返回
  if (plugin.isBuiltin) {
    return plugin.mcpServers;
  }

  const decl = plugin.manifest.mcpServers;
  if (!decl) return undefined;

  let servers: Record<string, MCPServerConfig>;
  if (typeof decl === "string") {
    const filePath = isAbsolute(decl) ? decl : join(plugin.path, decl);
    if (!existsSync(filePath)) {
      errors.push({
        type: "mcp-server-config-invalid",
        source: plugin.source,
        serverName: "(file)",
        error: `MCP 配置文件不存在: ${filePath}`,
      });
      return undefined;
    }
    servers = await loadMcpServersFromFile(filePath, errors, plugin.source);
  } else {
    servers = decl;
  }

  if (!servers || Object.keys(servers).length === 0) return undefined;

  // 环境变量解析
  const resolved: Record<string, MCPServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    resolved[name] = resolvePluginMcpEnvironment(config, plugin.path);
  }

  // 作用域前缀
  return addPluginScopeToServers(resolved, plugin.name);
}

/**
 * 收集所有启用插件的 MCP 服务器配置（合并为一个对象，供 MCPManager.connectAll）
 * memoized：填充各插件的 mcpServers 缓存槽。
 */
export const collectPluginMcpServers = memoize(
  async (): Promise<Record<string, MCPServerConfig>> => {
    const { enabled } = await loadAllPluginsCacheOnly();
    const errors: PluginError[] = [];
    const all: Record<string, MCPServerConfig> = {};

    for (const plugin of enabled) {
      const servers = await loadPluginMcpServers(plugin, errors);
      if (servers) {
        // 填充缓存槽
        plugin.mcpServers = servers;
        Object.assign(all, servers);
      }
    }

    if (errors.length > 0) {
      const log = getLogger();
      for (const err of errors) {
        log.warn("PLUGIN", `MCP 配置错误 [${err.type === "mcp-server-config-invalid" ? err.source : ""}]`);
      }
    }

    return all;
  },
);

registerPluginCache(collectPluginMcpServers.clear);
