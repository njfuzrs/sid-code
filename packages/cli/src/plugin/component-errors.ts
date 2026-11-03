/**
 * 组件级加载失败收集器。
 *
 * 组件（命令/Skill/Agent）是延迟加载的：它们不参与 loadAllPlugins 的组装，
 * 失败也就进不了 PluginLoadResult.errors。没有这个收集器时，一个文件读失败
 * 只留一行 logger.warn，/plugin 面板与 /reload-plugins 输出里都看不到。
 */
import { registerPluginCache } from "./caches.ts";
import type { PluginError } from "./types.ts";

const errors: PluginError[] = [];

/**
 * 记录一条组件级加载失败。
 *
 * 刻意不在这里打日志：调用点原本已有一条 warn（保留它），这里再打一遍就是双份。
 * 本收集器只负责「让失败可见」——最终由 /plugin list 与 /reload-plugins 展示。
 */
export function recordComponentLoadError(err: PluginError): void {
  errors.push(err);
}

/** 读取当前收集到的组件级失败（返回副本，调用方改不动内部数组） */
export function listComponentLoadErrors(): PluginError[] {
  return [...errors];
}

/** 清空（/reload-plugins 的 clearAllPluginCaches 会通过注册表自动调用） */
export function clearComponentLoadErrors(): void {
  errors.length = 0;
}

registerPluginCache(clearComponentLoadErrors);
