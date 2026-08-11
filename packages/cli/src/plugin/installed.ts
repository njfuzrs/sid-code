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
 * 读取已安装插件注册表
 * - 文件不存在返回空注册表
 * - JSON 解析失败记录错误但不抛出（返回空注册表，避免一个坏文件阻断整个启动）
 */
export async function readInstalledPlugins(): Promise<InstalledPluginsFile> {
  const filePath = getInstalledFilePath();
  if (!existsSync(filePath)) {
    return emptyRegistry();
  }

  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<InstalledPluginsFile>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.plugins !== "object" || !parsed.plugins) {
      getLogger().warn("PLUGIN", `installed.json 格式无效，使用空注册表`);
      return emptyRegistry();
    }
    return { version: 1, plugins: parsed.plugins };
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
