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
import { isAbsolute, join, relative, resolve } from "path";
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
import type { InstalledPluginEntry, PluginError } from "./types.ts";
import { formatPluginError } from "./types.ts";
import { refreshPluginRuntime } from "./runtime-refresh.ts";
import { evaluatePluginOrigin } from "@sid-code/core/config/plugin-only-policy.ts";

/** 操作结果 */
export type OperationResult =
  | {
      ok: true;
      message: string;
      /**
       * 操作后是否已把运行时刷新成功（缺陷 34）。
       * 未注册刷新器（headless / CLI 子命令 / 测试）或刷新失败时为 false，
       * 命令层据此决定是否提示「运行 /reload-plugins 使其生效」。
       */
      runtimeRefreshed?: boolean;
    }
  | { ok: false; error: string };

/** 时间戳注入（由调用方提供，因 workflow/纯函数约束不在此处用 Date.now） */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * target 是否严格位于 dir 之内（不含 dir 本身）。
 *
 * 判据用 `path.relative`，不用字符串 `startsWith`：后者没有分隔符边界，
 * `/plugins` 会命中 `/plugins-backup/foo` 与 `/pluginsEVIL`（缺陷 31，后者是
 * `uninstall --delete-files` 的 `rm -rf` 目标）。先 resolve 规范化再比，
 * 防 `plugins/../plugins-backup` 这类写法绕过。
 */
function isStrictlyInside(dir: string, target: string): boolean {
  const rel = relative(resolve(dir), resolve(target));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * 在注册表里找到 id 对应的键：id 可能是键名、插件名或完整 source。
 * 依赖声明两种写法都支持（见 dependency.ts 的说明），注册表本身按键名索引。
 */
function findRegistryKey(
  registry: { plugins: Record<string, InstalledPluginEntry> },
  id: string,
): string | undefined {
  if (registry.plugins[id]) return id;
  for (const [key, entry] of Object.entries(registry.plugins)) {
    if (entry.name === id || entry.source === id) return key;
  }
  return undefined;
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

  // 企业策略锁定时本地目录安装一律拒绝（P5）。在落盘之前拒，而不是装好了再在加载时拦 ——
  // 后者会让 installed.json 里躺着一条永远加载不了的记录。
  const decision = evaluatePluginOrigin({ kind: "local" });
  if (!decision.allowed) return { ok: false, error: decision.reason };

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
  // 缺陷 34：清缓存只保证「下次加载」生效；hooks / skills / MCP / 命令都要显式重投影。
  const runtimeRefreshed = await refreshPluginRuntime();
  return { ok: true, message: msg, runtimeRefreshed };
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
    // 走结构化错误：生命周期操作的失败要能按类型归因（OperationResult 仍是字符串契约）
    return {
      ok: false,
      error: formatPluginError({ type: "plugin-not-found", source: name, pluginId: name }),
    };
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
    // 缺陷 31：判据必须是「目录边界」，不能是裸字符串前缀。
    // `startsWith("/…/plugins")` 会放行 `/…/plugins-backup/foo` 与 `/…/pluginsEVIL`——
    // 前者正是用户备份插件目录时最自然的命名，而这里执行的是 rm -rf（不可逆）。
    if (isStrictlyInside(pluginsDir, entry.path) && existsSync(entry.path)) {
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
  // 缺陷 34：禁用 / 卸载后 hooks 与命令必须立刻从运行时撤掉，而不是等重启
  const runtimeRefreshed = await refreshPluginRuntime();
  return { ok: true, message: `已卸载 ${name}`, runtimeRefreshed };
}

/** 启用插件（含依赖闭包检查） */
export async function enablePlugin(name: string): Promise<OperationResult> {
  const registry = await readInstalledPlugins();
  const entry = registry.plugins[name];
  if (!entry) {
    return {
      ok: false,
      error: formatPluginError({ type: "plugin-not-found", source: name, pluginId: name }),
    };
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
      // 依赖声明允许写插件名或完整 source（name@local），注册表按键名索引 —— 统一走 findRegistryKey
      const key = findRegistryKey(registry, id);
      if (!key) return null;
      const e = registry.plugins[key]!;
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

  // 缺陷 32：closure 是按依赖顺序排好的待启用列表（依赖在前、根在后），必须真的落盘。
  // 旧实现算完就丢，只 setPluginEnabled(name)，于是「A 依赖已安装但被禁用的 B」会报启用成功，
  // 而 B 仍禁用；下次加载 verifyAndDemote 发现 A 的依赖不满足，又把 A 静默降级回 disabled ——
  // 用户看到的是「启用成功、重启后又是禁用」，且没有任何消息解释原因。
  const enabledDeps: string[] = [];
  for (const id of resolution.closure) {
    const key = findRegistryKey(registry, id);
    if (!key) continue; // 闭包解析已保证能找到；防御性跳过
    const depEntry = registry.plugins[key]!;
    if (depEntry.enabled) continue;
    if (await setPluginEnabled(key, true)) enabledDeps.push(key);
  }

  clearAllPluginCaches();
  // runtimeRefreshed 由 refreshPluginRuntime 返回；依赖列表去掉根（closure 最后一个）后再展示
  const runtimeRefreshed = await refreshPluginRuntime();
  const deps = enabledDeps.filter((k) => k !== name);
  const depNote = deps.length > 0 ? `（同时启用依赖: ${deps.join(", ")}）` : "";
  return { ok: true, message: `已启用 ${name}${depNote}`, runtimeRefreshed };
}

/** 禁用插件（含反向依赖警告） */
export async function disablePlugin(
  name: string,
  options?: { force?: boolean },
): Promise<OperationResult> {
  const registry = await readInstalledPlugins();
  const entry = registry.plugins[name];
  if (!entry) {
    return {
      ok: false,
      error: formatPluginError({ type: "plugin-not-found", source: name, pluginId: name }),
    };
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
  // 缺陷 34：禁用必须立刻撤掉该插件的 hooks / skills / MCP 工具。
  // 只清缓存的话，replacePluginHooks 没人调，旧 hook 仍然注册着、仍然会触发 ——
  // 用户以为禁用了，它还在跑（博客 §11.5 那个 bug 的镜像）。
  const runtimeRefreshed = await refreshPluginRuntime();
  return { ok: true, message: `已禁用 ${name}`, runtimeRefreshed };
}
