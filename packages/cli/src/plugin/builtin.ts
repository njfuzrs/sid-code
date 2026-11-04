/**
 * 内置插件注册表
 *
 * 对标 Claude Code 的 builtinPlugins.ts，用 Map 注册表支持动态注册。
 * 内置插件随 CLI 分发，path 为 "builtin" 哨兵值，标识符为 name@builtin。
 *
 * ⚠️ 缺陷 40（能力盘点的口径，别再看错）：**当前生产环境没有任何注册者**。
 * `registerBuiltinPlugin` 的调用点只有测试；`index.ts` 那一处是 re-export 不是调用。
 * 所以 `getBuiltinPlugins()` 在生产恒返回空数组，`LoadedPlugin.isBuiltin` 恒为 false，
 * 下游所有 `isBuiltin` 分支都是「等这一层被填内容才会走」的预留分支。
 *
 * 这是**有意保留的扩展点**（对齐 CC 的 `initBuiltinPlugins()` 空实现），不删的理由是
 * `registerBuiltinPlugin` 属于公开的插件扩展 API（`plugin/index.ts` 有导出）。但盘点
 * 能力时必须按「空注册表」记账，不能因为它被 loader 调用过就记成「在跑」——
 * 判据是**数写入点**，不是数读取点。
 *
 * 因此任何注册都必须在 `loadAllPlugins()` 第一次调用**之前**完成：loader 的结果被
 * memoize 缓存，之后再注册的插件不会出现在已缓存的加载结果里（缺陷 38a）。
 */

import type { SkillDefinition } from "@sid-code/core/skill/types.ts";
import type { MCPServerConfig, HooksConfig } from "@sid-code/core/config/config.ts";
import { getLogger } from "@sid-code/core/debug/logger.ts";
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

/**
 * 注册一个内置插件。
 *
 * 缺陷 38：**先到者占名，重复注册不回写**（与同仓另两个注册表一致）：
 * - `command/registry.ts` 的 `registerAlias`：保留先注册者 + warn（注释标了 P0-3，
 *   是修过的 bug）；
 * - `plugin/loader.ts` 的 `mergePluginSources`：先到者占名 + 报 `duplicate-name`。
 *
 * 旧实现是后到者静默覆盖（last-write-wins）。读前两个文件学到「这个仓拒绝静默覆盖」
 * 的人，会对这里做出错误假设——同名注册通常意味着标识符撞车，应当告警而不是让
 * 后注册者把前一个悄悄顶掉。
 *
 * @returns 是否真的写入了（同名已存在时返回 false，调用方可据此判断）
 */
export function registerBuiltinPlugin(def: BuiltinPluginDefinition): boolean {
  const existing = BUILTIN_PLUGINS.get(def.name);
  if (existing) {
    if (existing !== def) {
      getLogger().warn(
        "PLUGIN",
        `内置插件 "${def.name}" 已注册，忽略本次重复注册（保留先注册者，不做 last-write-wins 覆盖）`,
      );
    }
    return false;
  }
  BUILTIN_PLUGINS.set(def.name, def);
  return true;
}

/**
 * 取消注册。
 *
 * 生产环境无调用者。保留供测试使用：`builtin.test.ts` 依赖它清理模块级全局 Map
 * （缺陷 38b——测试间污染的唯一防线就是测试自己记得 unregister + 清 memoize 缓存）。
 */
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
export function getBuiltinPlugins(enabledOverrides?: Record<string, boolean>): LoadedPlugin[] {
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
      mcpServers: def.mcpServers ? addPluginScopeToServers(def.mcpServers, name) : undefined,
    });
  }

  return result;
}

/** 列出所有已注册内置插件名（供调试） */
export function listBuiltinPluginNames(): string[] {
  return [...BUILTIN_PLUGINS.keys()];
}
