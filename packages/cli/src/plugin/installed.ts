/**
 * 已安装插件注册表（installed.json）
 *
 * 磁盘格式：~/.sid-code/plugins/installed.json
 * 原子写入：先写 .tmp 再 rename，避免并发写入损坏。
 */

import { existsSync } from "fs";
import { readFile, writeFile, rename, mkdir } from "fs/promises";
import { join } from "path";
import { getLogger } from "@sid-code/core/debug/logger.ts";
import { sidPaths } from "@sid-code/core/config/paths.ts";
import type { InstalledPluginEntry } from "./types.ts";

/** installed.json 格式 */
export interface InstalledPluginsFile {
  version: 1;
  plugins: Record<string, InstalledPluginEntry>;
}

/** 插件根目录 ~/.sid-code/plugins/ */
export function getPluginsDir(): string {
  return sidPaths.plugins();
}

/** installed.json 文件路径 */
export function getInstalledFilePath(): string {
  return join(getPluginsDir(), "installed.json");
}

/** 空注册表 */
function emptyRegistry(): InstalledPluginsFile {
  return { version: 1, plugins: {} };
}

/**
 * 校验 installed.json 里的一条 entry（缺陷 37）。
 *
 * 这个文件是用户可编辑的纯文本（注释里也没有「不要手动编辑」的声明），手工编辑、
 * 旧版本格式、写入中断、磁盘损坏都会产出缺字段的条目。旧实现只校验 `plugins` 是个对象，
 * 每条 entry 一个字段都没查，后续使用处全部直接解引用：
 *
 * - `loader.ts` 的 `existsSync(entry.path)` —— path 为 undefined 时 Node 抛 TypeError；
 * - `plugin.enabled = entry.enabled` —— undefined 被当成 falsy，插件静默变禁用；
 * - `loader.ts` 的 `entry.source.endsWith("@builtin")` —— source 缺失直接 TypeError，
 *   而这行在 `assemblePluginLoadResult` 里，异常穿透到 memoize 曾会永久缓存失败（已由
 *   「失败不缓存」修复，但报错仍然是看不懂的 `Cannot read properties of undefined`）。
 *
 * 校验口径：`InstalledPluginEntry` 声明的 6 个必填字段类型必须对；`external` / `market`
 * 是可选字段，存在时也校验类型（`market` 只查它是不是对象，内部字段由 checkPluginOrigin 用）。
 *
 * @returns null = 合法；否则返回人话原因（用于日志与 PluginLoadResult.errors）
 */
export function installedEntryIssue(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "条目不是对象";
  const e = raw as Record<string, unknown>;
  const stringFields = ["name", "path", "source", "version", "installedAt"] as const;
  for (const field of stringFields) {
    if (typeof e[field] !== "string" || (e[field] as string).length === 0) {
      return `${field} 必须是非空字符串`;
    }
  }
  if (typeof e.enabled !== "boolean") return "enabled 必须是布尔值";
  if (e.external !== undefined && typeof e.external !== "boolean") {
    return "external 必须是布尔值";
  }
  if (e.market !== undefined && (e.market === null || typeof e.market !== "object")) {
    return "market 必须是对象";
  }
  return null;
}

/**
 * 读取已安装插件注册表
 * - 文件不存在返回空注册表
 * - JSON 解析失败记录错误但不抛出（返回空注册表，避免一个坏文件阻断整个启动）
 * - 逐条校验 entry（缺陷 37）：不合格的条目**跳过**（记 warn + 回调），不让它带着
 *   缺字段一路走到 loader 的 `entry.source.endsWith` 变成 TypeError。
 *
 * @param onInvalidEntry 每条不合格条目的回调。loader 用它把原因转成
 *   `PluginLoadResult.errors` 里的 `generic-error`（这样 /plugin 面板能看到，
 *   而不是只在日志里）；不传时只记 warn。
 */
export async function readInstalledPlugins(
  onInvalidEntry?: (key: string, reason: string) => void,
): Promise<InstalledPluginsFile> {
  const filePath = getInstalledFilePath();
  if (!existsSync(filePath)) {
    return emptyRegistry();
  }

  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<InstalledPluginsFile>;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.plugins !== "object" ||
      !parsed.plugins ||
      Array.isArray(parsed.plugins)
    ) {
      getLogger().warn("PLUGIN", `installed.json 格式无效，使用空注册表`);
      return emptyRegistry();
    }

    const plugins: Record<string, InstalledPluginEntry> = {};
    for (const [key, entry] of Object.entries(parsed.plugins)) {
      const issue = installedEntryIssue(entry);
      if (issue) {
        const reason = `installed.json 条目 "${key}" 无效（${issue}），已跳过`;
        getLogger().warn("PLUGIN", reason);
        onInvalidEntry?.(key, reason);
        continue;
      }
      plugins[key] = entry as InstalledPluginEntry;
    }
    return { version: 1, plugins };
  } catch (err: any) {
    getLogger().warn("PLUGIN", `读取 installed.json 失败: ${err.message}`);
    return emptyRegistry();
  }
}

/** 原子写入注册表（先写 .tmp 再 rename） */
export async function writeInstalledPlugins(file: InstalledPluginsFile): Promise<void> {
  const dir = getPluginsDir();
  await mkdir(dir, { recursive: true });

  const filePath = getInstalledFilePath();
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const content = JSON.stringify(file, null, 2);

  await writeFile(tmpPath, content, "utf-8");
  await rename(tmpPath, filePath);
}

/** 注册新安装的插件（读取 → 合并 → 写回） */
export async function registerPlugin(entry: InstalledPluginEntry): Promise<void> {
  const file = await readInstalledPlugins();
  file.plugins[entry.name] = entry;
  await writeInstalledPlugins(file);
  getLogger().info("PLUGIN", `已注册插件: ${entry.name} (${entry.source})`);
}

/** 注销已卸载的插件（读取 → 删除条目 → 写回） */
export async function unregisterPlugin(name: string): Promise<void> {
  const file = await readInstalledPlugins();
  if (file.plugins[name]) {
    delete file.plugins[name];
    await writeInstalledPlugins(file);
    getLogger().info("PLUGIN", `已注销插件: ${name}`);
  }
}

/** 更新指定插件的启用状态 */
export async function setPluginEnabled(name: string, enabled: boolean): Promise<boolean> {
  const file = await readInstalledPlugins();
  const entry = file.plugins[name];
  if (!entry) return false;
  entry.enabled = enabled;
  await writeInstalledPlugins(file);
  return true;
}
