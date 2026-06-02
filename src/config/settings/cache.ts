/**
 * Settings 三级缓存
 *
 * 对齐 Spec 15 §4.1：确保启动后的每次读取都是纯内存操作。
 * - Level 1: 会话级合并缓存（最终合并结果）
 * - Level 2: 单来源缓存（每个 source 的独立设置）
 * - Level 3: 文件解析缓存（每个文件路径的解析结果）
 *
 * 缓存失效采用单生产者模式：只在变更检测的 fanOut 中统一清缓存，
 * 不在每个订阅者中清，避免 N 次重复磁盘读取。
 */

import type { SettingsJson } from "./types.ts";
import type { SettingSource } from "./constants.ts";
import type { ValidationError } from "./validation.ts";

/** 文件解析结果 */
export interface ParsedSettings {
  settings: SettingsJson | null;
  errors: ValidationError[];
}

/** 合并后的会话级结果 */
export interface MergedSettings {
  settings: SettingsJson;
  errors: ValidationError[];
}

/** Level 1: 会话级合并缓存 */
let sessionSettingsCache: MergedSettings | null = null;

/** Level 2: 单来源缓存 */
const perSourceCache = new Map<SettingSource, SettingsJson | null>();

/** Level 3: 文件解析缓存 */
const parseFileCache = new Map<string, ParsedSettings>();

/** 获取会话级合并缓存 */
export function getSessionCache(): MergedSettings | null {
  return sessionSettingsCache;
}

/** 设置会话级合并缓存 */
export function setSessionCache(value: MergedSettings | null): void {
  sessionSettingsCache = value;
}

/** 获取文件解析缓存 */
export function getCachedParsedFile(path: string): ParsedSettings | null {
  return parseFileCache.get(path) ?? null;
}

/** 设置文件解析缓存 */
export function setCachedParsedFile(path: string, value: ParsedSettings): void {
  parseFileCache.set(path, value);
}

/** 获取单来源缓存（undefined = 未缓存；null = 缓存了"该来源无设置"） */
export function getCachedSource(
  source: SettingSource,
): SettingsJson | null | undefined {
  return perSourceCache.has(source) ? perSourceCache.get(source) : undefined;
}

/** 设置单来源缓存 */
export function setCachedSource(
  source: SettingSource,
  value: SettingsJson | null,
): void {
  perSourceCache.set(source, value);
}

/**
 * 全部清除——由 fanOut（变更检测器）统一调用。
 * 也用于测试隔离。
 */
export function resetSettingsCache(): void {
  sessionSettingsCache = null;
  perSourceCache.clear();
  parseFileCache.clear();
}
