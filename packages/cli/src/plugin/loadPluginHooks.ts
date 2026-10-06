/**
 * 插件 Hooks 加载：收集所有启用插件的 hooks，原子注册到 HookSystem
 *
 * 关键设计：原子交换（对标 Claude Code gh-29767 教训）
 * - 旧 hooks 一直有效，直到新 hooks 准备好替换
 * - 通过 HookSystem.replacePluginHooks() 一次性完成 清除旧 + 注册新
 *
 * 路径变量：**不做字符串替换**。原先这里把 command 里的 `${PLUGIN_ROOT}` 替换成插件磁盘路径，
 * 那是往 shell 串里拼路径（与 H14 同型：路径含 `$(...)` 会被 sh 执行）。现在每个插件把自己的根目录
 * 交给归一化层，runner 导出为环境变量 CLAUDE_PLUGIN_ROOT / PLUGIN_ROOT / CLAUDE_PLUGIN_DATA，
 * shell 形式由 sh 从环境展开，exec 形式（有 args）由 runner 做纯字符串替换。
 */

import { join } from "node:path";
import { getLogger } from "@sid-code/core/debug/logger.ts";
import { memoize } from "@sid-code/shared/utils/memoize.ts";
import { getSidHome } from "@sid-code/core/config/paths.ts";
import type { HookSystem } from "@sid-code/core/hook/system.ts";
import type { HooksConfig } from "@sid-code/core/config/config.ts";
import { registerPluginCache } from "./caches.ts";
import { loadAllPluginsCacheOnly } from "./loader.ts";
import type { LoadedPlugin } from "./types.ts";

/** 一个插件的 hooks 层（交给 HookSystem.replacePluginHooks） */
export interface PluginHookLayer {
  name: string;
  hooks: HooksConfig;
  /** 插件根目录；内置插件（path 为 "builtin" 哨兵）没有 */
  pluginRoot?: string;
  /** 插件持久数据目录（CC 的 CLAUDE_PLUGIN_DATA），~/.sid-code/plugins/data/<name> */
  pluginData?: string;
}

/** 插件持久数据目录（对齐 CC：跨插件更新保留）。只给路径，目录由插件脚本按需创建 */
export function pluginDataDir(pluginName: string): string {
  return join(getSidHome(), "plugins", "data", pluginName.replace(/[^A-Za-z0-9._-]/g, "_"));
}

/** 收集单个插件的 hooks 层（原样形状，不做任何变量替换） */
export function collectPluginHooks(plugin: LoadedPlugin): PluginHookLayer | null {
  if (!plugin.hooksConfig) return null;
  return {
    name: plugin.name,
    hooks: plugin.hooksConfig,
    ...(plugin.isBuiltin ? {} : { pluginRoot: plugin.path }),
    pluginData: pluginDataDir(plugin.name),
  };
}

/**
 * 加载所有插件的 Hooks 并原子注册到 HookSystem。
 * memoize 的是"已加载"状态——重复调用不会重复注册（除非 clear 后再调）。
 *
 * 注意：memoize key 不含 hookSystem 参数（单 slot），同一进程内 hookSystem 固定。
 */
export const loadPluginHooks = memoize(async (hookSystem: HookSystem): Promise<void> => {
  const { enabled } = await loadAllPluginsCacheOnly();

  const layers: PluginHookLayer[] = [];
  for (const plugin of enabled) {
    const layer = collectPluginHooks(plugin);
    if (layer) layers.push(layer);
  }

  // 原子交换
  const diagnostics = hookSystem.replacePluginHooks(layers);
  for (const d of diagnostics) {
    getLogger().warn("PLUGIN", `插件 hook 已跳过 ${d.path}: ${d.message}`);
  }

  const total = hookSystem.getAllHooks().filter((h) => h.source === "plugin").length;
  if (total > 0) {
    getLogger().info("PLUGIN", `注册了 ${total} 个插件 hook`);
  }
});

registerPluginCache(loadPluginHooks.clear);
