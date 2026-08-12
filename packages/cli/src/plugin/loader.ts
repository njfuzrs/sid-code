/**
 * 插件发现与加载核心（两层加载策略）
 *
 * - loadAllPluginsCacheOnly：零磁盘扫描偏好，启动关键路径用
 * - loadAllPlugins：完整加载（读 plugin.json、验证目录），REPL 挂载后后台执行
 *
 * 加载来源优先级（从低到高，先到者占据插件名）：
 *   1. 内置插件（@builtin，path = "builtin"）
 *   2. 已安装插件（@local，~/.sid-code/plugins/{name}/）
 *   3. 会话级插件（@inline，--plugin-dir 指定）
 */

import { existsSync } from "fs";
import { resolve } from "path";
import { getLogger } from "@sid-code/core/debug/logger.ts";
import { memoize } from "@sid-code/shared/utils/memoize.ts";
import { registerPluginCache } from "./caches.ts";
import type { LoadedPlugin, PluginError, PluginLoadResult } from "./types.ts";
import { readInstalledPlugins } from "./installed.ts";
import { loadPluginFromDirectory } from "./manifest.ts";
import { getBuiltinPlugins } from "./builtin.ts";
import { verifyAndDemote } from "./dependency.ts";

/** 会话级插件目录（由 CLI --plugin-dir 设置，进程内全局） */
let inlinePluginDirs: string[] = [];

/** 设置会话级插件目录（在加载前由 cli.ts 调用） */
export function setInlinePluginDirs(dirs: string[]): void {
  inlinePluginDirs = dirs.map((d) => resolve(d));
}

/** 获取会话级插件目录 */
export function getInlinePluginDirs(): string[] {
  return [...inlinePluginDirs];
}

/**
 * 加载已安装插件（从 installed.json + 磁盘目录）
 */
async function loadInstalledPlugins(errors: PluginError[]): Promise<LoadedPlugin[]> {
  const registry = await readInstalledPlugins();
  const plugins: LoadedPlugin[] = [];

  for (const [, entry] of Object.entries(registry.plugins)) {
    if (!existsSync(entry.path)) {
      errors.push({
        type: "path-not-found",
        source: entry.source,
        path: entry.path,
        component: "commands",
      });
      continue;
    }
    const plugin = await loadPluginFromDirectory(entry.path, "local", entry.enabled, errors);
    if (plugin) {
      // installed.json 中的 enabled 状态优先
      plugin.enabled = entry.enabled;
      plugins.push(plugin);
    }
  }

  return plugins;
}

/** 加载会话级插件（--plugin-dir） */
async function loadInlinePlugins(errors: PluginError[]): Promise<LoadedPlugin[]> {
  const plugins: LoadedPlugin[] = [];
  for (const dir of inlinePluginDirs) {
    if (!existsSync(dir)) {
      errors.push({
        type: "path-not-found",
        source: `${dir}@inline`,
        path: dir,
        component: "commands",
      });
      continue;
    }
    const plugin = await loadPluginFromDirectory(dir, "inline", true, errors);
    if (plugin) plugins.push(plugin);
  }
  return plugins;
}

/**
 * 合并所有插件来源，去重（先到者优先：内置 → 已安装 → 会话级）。
 * 注意优先级反过来理解：内置插件最先放入，后来同名的会被记为 duplicate-name 跳过，
 * 但会话级（inline）应能覆盖内置以便调试 → 顺序为 builtin 在前、已安装其次、inline 最后，
 * 同名时保留先放入者并对后者报 duplicate。为兼顾"inline 可覆盖"，inline 放最前。
 */
function mergePluginSources(
  builtin: LoadedPlugin[],
  installed: LoadedPlugin[],
  inline: LoadedPlugin[],
  errors: PluginError[],
): LoadedPlugin[] {
  const byName = new Map<string, LoadedPlugin>();
  // inline 优先级最高（调试场景可覆盖内置/已安装），其次已安装，最后内置
  for (const plugin of [...inline, ...installed, ...builtin]) {
    const existing = byName.get(plugin.name);
    if (existing) {
      errors.push({
        type: "duplicate-name",
        source: plugin.source,
        existingSource: existing.source,
      });
      continue;
    }
    byName.set(plugin.name, plugin);
  }
  return [...byName.values()];
}

/** 按 enabled 字段分类 */
function applyEnabledState(plugins: LoadedPlugin[]): {
  enabled: LoadedPlugin[];
  disabled: LoadedPlugin[];
} {
  const enabled: LoadedPlugin[] = [];
  const disabled: LoadedPlugin[] = [];
  for (const p of plugins) {
    if (p.enabled) enabled.push(p);
    else disabled.push(p);
  }
  return { enabled, disabled };
}

/**
 * 组装插件加载结果（核心流程）
 * @param fullLoad 是否完整加载（当前两种路径共用磁盘扫描，差异保留给未来缓存优化）
 */
async function assemblePluginLoadResult(_fullLoad: boolean): Promise<PluginLoadResult> {
  const errors: PluginError[] = [];

  // 1. 读取已安装注册表（用于内置插件的启用覆盖）
  const registry = await readInstalledPlugins();
  const builtinOverrides: Record<string, boolean> = {};
  for (const [name, entry] of Object.entries(registry.plugins)) {
    if (entry.source.endsWith("@builtin")) {
      builtinOverrides[name] = entry.enabled;
    }
  }

  // 2. 各来源加载
  const installedPlugins = await loadInstalledPlugins(errors);
  const inlinePlugins = await loadInlinePlugins(errors);
  const builtinPlugins = getBuiltinPlugins(builtinOverrides);

  // 3. 合并去重
  const merged = mergePluginSources(builtinPlugins, installedPlugins, inlinePlugins, errors);

  // 4. 启用/禁用分类
  const { enabled, disabled } = applyEnabledState(merged);

  // 5. 依赖验证（固定点降级）
  const demoted = verifyAndDemote(enabled, disabled);
  errors.push(...demoted.errors);

  return { enabled: demoted.enabled, disabled: demoted.disabled, errors };
}

/**
 * 缓存加载：用于启动关键路径（getCommands / getAgentDefinitions 等）。
 * 与 loadAllPlugins 共享 memoize slot 语义——首次调用任一即填充。
 */
export const loadAllPluginsCacheOnly = memoize(async (): Promise<PluginLoadResult> => {
  return assemblePluginLoadResult(false);
});

/**
 * 完整加载：可能触发磁盘 I/O（读取 plugin.json、验证目录）。
 * 完成后预热 cache-only 的 memoize，保证两者一致。
 */
export const loadAllPlugins = memoize(async (): Promise<PluginLoadResult> => {
  const result = await assemblePluginLoadResult(true);
  // 预热 cache-only memoize
  loadAllPluginsCacheOnly.cache.set(undefined, Promise.resolve(result));

  if (result.errors.length > 0) {
    const log = getLogger();
    log.warn(
      "PLUGIN",
      `插件加载完成，${result.enabled.length} 启用 / ${result.disabled.length} 禁用 / ${result.errors.length} 错误`,
    );
  }
  return result;
});

// 注册缓存清除（供 clearAllPluginCaches）
registerPluginCache(loadAllPlugins.clear);
registerPluginCache(loadAllPluginsCacheOnly.clear);
