/**
 * 插件生命周期操作：安装 / 卸载 / 启用 / 禁用
 *
 * 安装：从本地目录复制（或直接引用）到 ~/.sid-code/plugins/，注册到 installed.json
 * 卸载：从 installed.json 移除（可选删除磁盘目录）
 * 启用/禁用：更新 installed.json 的 enabled 字段
 *
 * 所有操作完成后需调用 clearAllPluginCaches() 让下次加载生效。
 */

import { existsSync } from "fs";
import { cp, rm } from "fs/promises";
import { join, resolve } from "path";
import { getLogger } from "@sid-code/core/debug/logger.ts";
import { loadManifest } from "./manifest.ts";
import {
  readInstalledPlugins,
  registerPlugin,
  unregisterPlugin,
  setPluginEnabled,
  getPluginsDir,
} from "./installed.ts";
import { buildPluginId } from "./identifier.ts";
import { clearAllPluginCaches } from "./caches.ts";
import { resolveDependencyClosure, findReverseDependents } from "./dependency.ts";
import { loadAllPlugins } from "./loader.ts";
import type { PluginError } from "./types.ts";

/** 操作结果 */
export type OperationResult = { ok: true; message: string } | { ok: false; error: string };

/** 时间戳注入（由调用方提供，因 workflow/纯函数约束不在此处用 Date.now） */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 安装本地插件
 * @param sourcePath 本地插件目录路径
 * @param options.copy 是否复制到 plugins 目录（默认 true）。false 则原地引用（开发场景）
 */
export async function installPlugin(
  sourcePath: string,
  options?: { copy?: boolean },
): Promise<OperationResult> {
  const log = getLogger();
  const absSource = resolve(sourcePath);

  if (!existsSync(absSource)) {
    return { ok: false, error: `插件目录不存在: ${absSource}` };
  }

  // 验证 manifest
  const errors: PluginError[] = [];
  const manifest = await loadManifest(absSource, errors, `${absSource}@local`);
  if (!manifest) {
    return {
      ok: false,
      error: `Manifest 验证失败: ${errors.map((e) => JSON.stringify(e)).join("; ")}`,
    };
  }

  // 检查名称冲突
  const registry = await readInstalledPlugins();
  if (registry.plugins[manifest.name]) {
    return { ok: false, error: `插件 "${manifest.name}" 已安装，请先卸载` };
  }

  const copy = options?.copy ?? true;
  let targetPath = absSource;

  if (copy) {
    targetPath = join(getPluginsDir(), manifest.name);
    if (existsSync(targetPath)) {
      return { ok: false, error: `目标目录已存在: ${targetPath}` };
    }
    try {
      await cp(absSource, targetPath, { recursive: true });
    } catch (err: any) {
      return { ok: false, error: `复制插件失败: ${err.message}` };
    }
  }

  // 注册
  await registerPlugin({
    name: manifest.name,
    path: targetPath,
    source: buildPluginId(manifest.name, "local"),
    version: manifest.version,
    installedAt: nowIso(),
    enabled: true,
  });

  clearAllPluginCaches();
  log.info("PLUGIN", `已安装插件: ${manifest.name}@${manifest.version}`);

  // 依赖提示（不阻断安装，仅警告）
  const depWarning = await checkDependencies(manifest.name, manifest.dependencies);
  const msg = `已安装 ${manifest.name}@${manifest.version}` + (depWarning ? `\n${depWarning}` : "");
  return { ok: true, message: msg };
}

/** 检查依赖是否已安装并启用，返回警告字符串（无问题返回空） */
async function checkDependencies(name: string, dependencies?: string[]): Promise<string> {
  if (!dependencies || dependencies.length === 0) return "";
  const registry = await readInstalledPlugins();
  const missing: string[] = [];
  for (const dep of dependencies) {
    const entry = registry.plugins[dep];
    if (!entry) missing.push(`${dep}（未安装）`);
    else if (!entry.enabled) missing.push(`${dep}（已禁用）`);
  }
  if (missing.length === 0) return "";
  return `⚠️ 依赖未满足: ${missing.join(", ")} — ${name} 可能无法正常工作`;
}

/**
 * 卸载插件
 * @param options.deleteFiles 是否删除磁盘目录（默认 false，仅从注册表移除）
 * @param options.force 忽略反向依赖警告强制卸载
 */
export async function uninstallPlugin(
  name: string,
  options?: { deleteFiles?: boolean; force?: boolean },
): Promise<OperationResult> {
  const log = getLogger();
  const registry = await readInstalledPlugins();
  const entry = registry.plugins[name];
  if (!entry) {
    return { ok: false, error: `插件 "${name}" 未安装` };
  }

  // 反向依赖检查
  const { enabled } = await loadAllPlugins();
  const dependents = findReverseDependents(name, enabled);
  if (dependents.length > 0 && !options?.force) {
    return {
      ok: false,
      error: `以下插件依赖 "${name}": ${dependents.join(", ")}。使用 --force 强制卸载`,
    };
  }

  // 删除磁盘目录（仅当目录在 plugins 目录内，避免误删原地引用的开发目录）
  if (options?.deleteFiles) {
    const pluginsDir = getPluginsDir();
    if (entry.path.startsWith(pluginsDir) && existsSync(entry.path)) {
      try {
        await rm(entry.path, { recursive: true, force: true });
      } catch (err: any) {
        log.warn("PLUGIN", `删除插件目录失败: ${err.message}`);
      }
    }
  }

  await unregisterPlugin(name);
  clearAllPluginCaches();
  log.info("PLUGIN", `已卸载插件: ${name}`);
  return { ok: true, message: `已卸载 ${name}` };
}

/** 启用插件（含依赖闭包检查） */
export async function enablePlugin(name: string): Promise<OperationResult> {
  const registry = await readInstalledPlugins();
  const entry = registry.plugins[name];
  if (!entry) {
    return { ok: false, error: `插件 "${name}" 未安装` };
  }
  if (entry.enabled) {
    return { ok: true, message: `插件 "${name}" 已经是启用状态` };
  }

  // 依赖闭包检查
  const enabledNames = new Set(
    Object.values(registry.plugins)
      .filter((p) => p.enabled)
      .map((p) => p.name),
  );
  const resolution = await resolveDependencyClosure(
    name,
    async (id) => {
      const e = registry.plugins[id];
      if (!e) return null;
      const errors: PluginError[] = [];
      const m = await loadManifest(e.path, errors);
      return { dependencies: m?.dependencies };
    },
    enabledNames,
  );

  if (!resolution.ok) {
    if (resolution.reason === "cycle") {
      return { ok: false, error: `检测到循环依赖: ${resolution.chain.join(" → ")}` };
    }
    return {
      ok: false,
      error: `依赖 "${resolution.missing}"（被 ${resolution.requiredBy} 需要）未安装`,
    };
  }

  await setPluginEnabled(name, true);
  clearAllPluginCaches();
  return { ok: true, message: `已启用 ${name}` };
}

/** 禁用插件（含反向依赖警告） */
export async function disablePlugin(
  name: string,
  options?: { force?: boolean },
): Promise<OperationResult> {
  const registry = await readInstalledPlugins();
  const entry = registry.plugins[name];
  if (!entry) {
    return { ok: false, error: `插件 "${name}" 未安装` };
  }
  if (!entry.enabled) {
    return { ok: true, message: `插件 "${name}" 已经是禁用状态` };
  }

  const { enabled } = await loadAllPlugins();
  const dependents = findReverseDependents(name, enabled);
  if (dependents.length > 0 && !options?.force) {
    return {
      ok: false,
      error: `以下插件依赖 "${name}": ${dependents.join(", ")}。使用 --force 强制禁用`,
    };
  }

  await setPluginEnabled(name, false);
  clearAllPluginCaches();
  return { ok: true, message: `已禁用 ${name}` };
}
