/**
 * 插件 Manifest 加载：从磁盘目录读取 plugin.json 并组装 LoadedPlugin
 */

import { existsSync, realpathSync } from "fs";
import { readFile } from "fs/promises";
import { join, isAbsolute, resolve, sep } from "path";
import { getLogger } from "@sid-code/core/debug/logger.ts";
import type { HooksConfig } from "@sid-code/core/config/config.ts";
import type { PluginManifest, LoadedPlugin, PluginError, PluginComponent } from "./types.ts";
import { validateManifest } from "./validate.ts";
import { buildPluginId } from "./identifier.ts";

/** 默认组件路径 */
const DEFAULT_COMMANDS_DIR = "commands";
const DEFAULT_SKILLS_DIR = "skills";
const DEFAULT_AGENTS_DIR = "agents";
const DEFAULT_HOOKS_FILE = "hooks.json";

/**
 * 从插件目录读取并验证 plugin.json
 * @returns 验证通过返回 manifest，否则返回 null（错误推入 errors）
 */
export async function loadManifest(
  pluginPath: string,
  errors?: PluginError[],
  source?: string,
): Promise<PluginManifest | null> {
  const src = source ?? pluginPath;
  const manifestPath = join(pluginPath, "plugin.json");

  if (!existsSync(manifestPath)) {
    errors?.push({ type: "manifest-not-found", source: src, path: manifestPath });
    return null;
  }

  let parsed: unknown;
  try {
    const raw = await readFile(manifestPath, "utf-8");
    parsed = JSON.parse(raw);
  } catch (err: any) {
    errors?.push({ type: "manifest-parse-error", source: src, parseError: err.message });
    return null;
  }

  const result = validateManifest(parsed);
  if (!result.valid) {
    errors?.push({ type: "manifest-validation-error", source: src, errors: result.errors });
    return null;
  }

  return parsed as PluginManifest;
}

/**
 * 路径是否落在 root 目录内（含 root 本身）。
 * root 须是绝对路径；`startsWith(root + sep)` 而不是 `startsWith(root)`，否则
 * `/plugins/foo-evil` 会被误判为在 `/plugins/foo` 内。
 */
function isInsideRoot(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * 把 plugin.json 里声明的相对路径解析为插件目录内的绝对路径。
 *
 * 安全语义（缺陷 21）：第三方插件的组件路径不能把加载范围延伸到插件目录之外。
 * - 绝对路径一律拒绝 —— 插件声明绝对路径没有任何正当用途
 * - 相对路径 `resolve` 后必须仍在插件根目录内（`..` 逃逸一律拒绝）
 *
 * @returns 合规时返回绝对路径；越界/绝对路径返回 null（调用方负责 push path-escape）
 */
export function resolvePathInsidePlugin(pluginPath: string, declared: string): string | null {
  if (!declared || isAbsolute(declared)) return null;
  const root = resolve(pluginPath);
  const resolved = resolve(root, declared);
  return isInsideRoot(root, resolved) ? resolved : null;
}

/**
 * 解析并校验一个组件路径声明；越界时 push path-escape 并跳过该项。
 *
 * 为什么还比对 realpath：上面的 `resolve` 只能拦住字面量 `..`，拦不住插件目录内
 * 一个指向外部的符号链接（`ln -s /etc cmds`）。真实路径存在时再比一次，堵住这条路。
 */
function checkPathsInsidePlugin(
  pluginPath: string,
  declared: string | string[],
  component: PluginComponent,
  source: string,
  errors: PluginError[],
): string[] {
  const list = Array.isArray(declared) ? declared : [declared];
  const result: string[] = [];
  for (const p of list) {
    const resolved = typeof p === "string" ? resolvePathInsidePlugin(pluginPath, p) : null;
    if (resolved === null) {
      errors.push({ type: "path-escape", source, path: String(p), component });
      continue;
    }
    if (escapesViaSymlink(resolve(pluginPath), resolved)) {
      errors.push({ type: "path-escape", source, path: p, component });
      continue;
    }
    result.push(resolved);
  }
  return result;
}

/** 目标存在时，用 realpath 复核是否仍在插件目录（已 realpath）内 */
function escapesViaSymlink(root: string, target: string): boolean {
  if (!existsSync(target)) return false;
  try {
    const realRoot = realpathSync(root);
    const realTarget = realpathSync(target);
    return !isInsideRoot(realRoot, realTarget);
  } catch {
    // realpath 失败（权限等）→ 不在这里判死，交给后续读取报错
    return false;
  }
}

/**
 * 将组件路径声明（string | string[] | undefined）规范化为绝对路径数组。
 * 声明项越界时 push path-escape 并跳过；未声明时走默认目录（不受本校验影响）。
 */
function resolveComponentPaths(
  decl: string | string[] | undefined,
  pluginPath: string,
  defaultDir: string,
  component: PluginComponent,
  source: string,
  errors: PluginError[],
): string[] {
  // 未声明时使用默认目录（仅当默认目录存在）
  if (decl === undefined) {
    const defaultPath = join(pluginPath, defaultDir);
    return existsSync(defaultPath) ? [defaultPath] : [];
  }

  return checkPathsInsidePlugin(pluginPath, decl, component, source, errors);
}

/**
 * 从磁盘目录组装一个 LoadedPlugin（不加载实际组件，只解析路径与 manifest）
 *
 * @param pluginPath 插件目录绝对路径
 * @param sourceKind 标识符后缀（local / inline）
 * @param enabled    启用状态
 */
export async function loadPluginFromDirectory(
  pluginPath: string,
  sourceKind: string,
  enabled: boolean,
  errors: PluginError[],
): Promise<LoadedPlugin | null> {
  const manifest = await loadManifest(pluginPath, errors, `${pluginPath}@${sourceKind}`);
  if (!manifest) return null;

  const source = buildPluginId(manifest.name, sourceKind);

  // 解析组件路径（越界项 push path-escape 后跳过，不影响其他合法项）
  const commandsPaths = resolveComponentPaths(
    manifest.commands,
    pluginPath,
    DEFAULT_COMMANDS_DIR,
    "commands",
    source,
    errors,
  );
  const skillsPaths = resolveComponentPaths(
    manifest.skills,
    pluginPath,
    DEFAULT_SKILLS_DIR,
    "skills",
    source,
    errors,
  );
  const agentsPaths = resolveComponentPaths(
    manifest.agents,
    pluginPath,
    DEFAULT_AGENTS_DIR,
    "agents",
    source,
    errors,
  );

  // 加载 hooks 配置（如果声明）
  const hooksConfig = await loadHooksConfig(manifest, pluginPath, source, errors);

  return {
    name: manifest.name,
    manifest,
    path: pluginPath,
    source,
    enabled,
    isBuiltin: false,
    commandsPaths,
    skillsPaths,
    agentsPaths,
    hooksConfig,
    // mcpServers 是延迟填充的缓存槽，组装时留空
    mcpServers: undefined,
  };
}

/** 加载 hooks.json（若插件声明了 hooks 字段或默认文件存在） */
async function loadHooksConfig(
  manifest: PluginManifest,
  pluginPath: string,
  source: string,
  errors: PluginError[],
): Promise<HooksConfig | undefined> {
  const hooksFile = manifest.hooks ?? DEFAULT_HOOKS_FILE;
  // 显式声明的 hooks 文件同样要限制在插件目录内（缺陷 21）；默认文件是常量，无需校验
  let hooksPath: string;
  if (manifest.hooks !== undefined) {
    const resolved = resolvePathInsidePlugin(pluginPath, hooksFile);
    if (resolved === null || escapesViaSymlink(resolve(pluginPath), resolved)) {
      errors.push({ type: "path-escape", source, path: hooksFile, component: "hooks" });
      return undefined;
    }
    hooksPath = resolved;
  } else {
    hooksPath = join(pluginPath, hooksFile);
  }

  // 默认文件不存在时静默跳过；显式声明但不存在时报错
  if (!existsSync(hooksPath)) {
    if (manifest.hooks) {
      errors.push({ type: "hook-load-failed", source, error: `hooks 文件不存在: ${hooksPath}` });
    }
    return undefined;
  }

  try {
    const raw = await readFile(hooksPath, "utf-8");
    const parsed = JSON.parse(raw);
    // 支持 { "hooks": {...} } 或直接 { eventName: [...] }
    const hooks = parsed && typeof parsed === "object" && parsed.hooks ? parsed.hooks : parsed;
    if (!hooks || typeof hooks !== "object") {
      errors.push({ type: "hook-load-failed", source, error: "hooks 配置必须是对象" });
      return undefined;
    }
    return hooks as HooksConfig;
  } catch (err: any) {
    errors.push({ type: "hook-load-failed", source, error: err.message });
    getLogger().warn("PLUGIN", `加载 hooks 失败 (${source}): ${err.message}`);
    return undefined;
  }
}
