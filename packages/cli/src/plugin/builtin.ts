/**
 * 内置插件注册表
 *
 * 对标 Claude Code 的 builtinPlugins.ts，用 Map 注册表支持动态注册。
 * 内置插件随 CLI 分发，path 为 "builtin" 哨兵值，标识符为 name@builtin。
 */

import type { SkillDefinition } from "@sid-code/core/skill/types.ts";
import type { MCPServerConfig, HooksConfig } from "@sid-code/core/config/config.ts";
import type { LoadedPlugin } from "./types.ts";
import { buildPluginId } from "./identifier.ts";
import { addPluginScopeToServers } from "./scope.ts";

/** 内置插件定义 */
export interface BuiltinPluginDefinition {
  name: string;
  description: string;
  version?: string;
  /** 可以提供 Skills（直接以定义形式提供，无磁盘路径） */
  skills?: SkillDefinition[];
  /** 可以提供 Hooks */
  hooks?: HooksConfig;
  /** 可以提供 MCP 服务器 */
  mcpServers?: Record<string, MCPServerConfig>;
  /** 动态可用性检查（如只在 macOS 上可用） */
  isAvailable?: () => boolean;
  /** 默认启用状态（默认 true） */
  defaultEnabled?: boolean;
}

const BUILTIN_PLUGINS = new Map<string, BuiltinPluginDefinition>();

/** 注册一个内置插件（重复注册同名会覆盖） */
export function registerBuiltinPlugin(def: BuiltinPluginDefinition): void {
  BUILTIN_PLUGINS.set(def.name, def);
}

/** 取消注册（主要供测试使用） */
export function unregisterBuiltinPlugin(name: string): void {
  BUILTIN_PLUGINS.delete(name);
}

/** 获取内置插件定义（供组件加载器读取 skills 等） */
export function getBuiltinPluginDefinition(name: string): BuiltinPluginDefinition | undefined {
  return BUILTIN_PLUGINS.get(name);
}

/**
 * 获取所有内置插件，转换为 LoadedPlugin 格式。
 *
 * 启用状态优先级（高 → 低）：
 *   1. enabledOverrides 中的显式设置（来自 installed.json）
 *   2. 插件定义的 defaultEnabled
 *   3. 兜底值 true（默认启用）
 *
 * @param enabledOverrides 来自 installed.json 的显式启用/禁用覆盖（按插件名）
 */
export function getBuiltinPlugins(
  enabledOverrides?: Record<string, boolean>,
): LoadedPlugin[] {
  const result: LoadedPlugin[] = [];

  for (const [name, def] of BUILTIN_PLUGINS) {
    // 动态可用性检查
    if (def.isAvailable && !def.isAvailable()) continue;

    const enabled = enabledOverrides?.[name] ?? def.defaultEnabled ?? true;
    const source = buildPluginId(name, "builtin");

    result.push({
      name,
      manifest: {
        name,
        version: def.version ?? "0.0.0",
        description: def.description,
      },
      path: "builtin", // 哨兵值，内置插件无磁盘路径
      source,
      enabled,
      isBuiltin: true,
      commandsPaths: [],
      skillsPaths: [],
      agentsPaths: [],
      hooksConfig: def.hooks,
      mcpServers: def.mcpServers
        ? addPluginScopeToServers(def.mcpServers, name)
        : undefined,
    });
  }

  return result;
}

/** 列出所有已注册内置插件名（供调试） */
export function listBuiltinPluginNames(): string[] {
  return [...BUILTIN_PLUGINS.keys()];
}
