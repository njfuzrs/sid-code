/**
 * 插件 Manifest 加载：从磁盘目录读取 plugin.json 并组装 LoadedPlugin
 */

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join, isAbsolute } from "path";
import { getLogger } from "@sid-code/core/debug/logger.ts";
import type { HooksConfig } from "@sid-code/core/config/config.ts";
import type { PluginManifest, LoadedPlugin, PluginError } from "./types.ts";
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

/** 将组件路径声明（string | string[] | undefined）规范化为绝对路径数组 */
function resolveComponentPaths(
  decl: string | string[] | undefined,
  pluginPath: string,
  defaultDir: string,
): string[] {
  // 未声明时使用默认目录（仅当默认目录存在）
  if (decl === undefined) {
    const defaultPath = join(pluginPath, defaultDir);
    return existsSync(defaultPath) ? [defaultPath] : [];
  }

  const list = Array.isArray(decl) ? decl : [decl];
  return list.map((p) => (isAbsolute(p) ? p : join(pluginPath, p)));
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

  // 解析组件路径
  const commandsPaths = resolveComponentPaths(manifest.commands, pluginPath, DEFAULT_COMMANDS_DIR);
  const skillsPaths = resolveComponentPaths(manifest.skills, pluginPath, DEFAULT_SKILLS_DIR);
  const agentsPaths = resolveComponentPaths(manifest.agents, pluginPath, DEFAULT_AGENTS_DIR);

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
  const hooksPath = isAbsolute(hooksFile) ? hooksFile : join(pluginPath, hooksFile);

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
