/**
 * 配置预加载
 * 在模块加载期间并行启动配置文件的异步读取
 * loadConfig() 时直接消费结果，避免重复读取
 */

import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

let configPromise: Promise<string | null> | null = null;

/**
 * 启动配置文件的异步读取
 * 在模块加载期间并行执行，loadConfig() 时直接消费结果
 */
export function startConfigPreload(): void {
  if (configPromise) return; // 已启动，不重复
  const configPath = join(homedir(), ".sid-code", "config.yaml");
  configPromise = readFile(configPath, "utf-8").catch(() => null);
}

/**
 * 获取预加载的配置内容
 * 如果预加载已完成，立即返回；否则等待完成
 * 如果未启动预加载，返回 null
 */
export async function getPreloadedConfig(): Promise<string | null> {
  if (!configPromise) return null;
  return configPromise;
}

/** 重置预加载状态（供测试使用） */
export function resetPreload(): void {
  configPromise = null;
}
