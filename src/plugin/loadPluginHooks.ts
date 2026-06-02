/**
 * 插件 Hooks 加载：收集所有启用插件的 hooks，原子注册到 HookSystem
 *
 * 关键设计：原子交换（对标 Claude Code gh-29767 教训）
 * - 旧 hooks 一直有效，直到新 hooks 准备好替换
 * - 通过 HookSystem.replacePluginHooks() 一次性完成 清除旧 + 注册新
 *
 * 变量替换：hook command 中的 ${PLUGIN_ROOT} 替换为插件磁盘路径。
 */

import { getLogger } from "../debug/logger.ts";
import { memoize } from "../utils/memoize.ts";
import type { HookSystem } from "../hook/system.ts";
import type { HookConfig as LegacyHookConfig, HooksConfig } from "../config/config.ts";
import { registerPluginCache } from "./caches.ts";
import { loadAllPluginsCacheOnly } from "./loader.ts";
import type { LoadedPlugin } from "./types.ts";

/** 对单个 hook 配置做 ${PLUGIN_ROOT} 变量替换 */
function resolveHookVariables(hook: LegacyHookConfig, pluginRoot: string): LegacyHookConfig {
  const sub = (v: string | undefined): string | undefined =>
    v === undefined ? undefined : v.replace(/\$\{PLUGIN_ROOT\}/g, pluginRoot);

  return {
    ...hook,
    command: sub(hook.command),
    url: sub(hook.url),
  };
}

/** 收集单个插件的 hooks（已做变量替换） */
export function collectPluginHooks(plugin: LoadedPlugin): HooksConfig {
  const result: HooksConfig = {};
  if (!plugin.hooksConfig) return result;

  // 内置插件 path 为 "builtin" 哨兵，无需替换
  const pluginRoot = plugin.isBuiltin ? "" : plugin.path;

  for (const [event, hooks] of Object.entries(plugin.hooksConfig)) {
    if (!Array.isArray(hooks)) continue;
    const resolved = hooks.map((h) => resolveHookVariables(h, pluginRoot));
    if (!result[event]) result[event] = [];
    result[event].push(...resolved);
  }
  return result;
}

/**
 * 加载所有插件的 Hooks 并原子注册到 HookSystem。
 * memoize 的是"已加载"状态——重复调用不会重复注册（除非 clear 后再调）。
 *
 * 注意：memoize key 不含 hookSystem 参数（单 slot），同一进程内 hookSystem 固定。
 */
export const loadPluginHooks = memoize(async (hookSystem: HookSystem): Promise<void> => {
  const { enabled } = await loadAllPluginsCacheOnly();

  const allPluginHooks: HooksConfig = {};
  for (const plugin of enabled) {
    const hooks = collectPluginHooks(plugin);
    for (const [event, list] of Object.entries(hooks)) {
      if (!allPluginHooks[event]) allPluginHooks[event] = [];
      allPluginHooks[event].push(...list);
    }
  }

  // 原子交换
  hookSystem.replacePluginHooks(allPluginHooks);

  const total = Object.values(allPluginHooks).reduce((n, l) => n + l.length, 0);
  if (total > 0) {
    getLogger().info("PLUGIN", `注册了 ${total} 个插件 hook`);
  }
});

registerPluginCache(loadPluginHooks.clear);
