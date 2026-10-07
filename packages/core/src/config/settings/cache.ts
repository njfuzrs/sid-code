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

/**
 * Level 2: 单来源缓存。
 * 值是带 errors 的 ParsedSettings（不是裸 SettingsJson）：L1、L3 都带 errors，
 * 中间层只存 settings 会让 L2 命中时诊断恒为空（见 settings.ts getSettingsForSource）。
 */
const perSourceCache = new Map<SettingSource, ParsedSettings>();

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

/** 失效单个文件的解析缓存（补丁写入后强制下次重新读盘） */
export function clearCachedParsedFile(path: string): void {
  parseFileCache.delete(path);
}

/** 获取单来源缓存（undefined = 未缓存；null = 缓存了"该来源无设置"） */
export function getCachedSource(source: SettingSource): ParsedSettings | undefined {
  return perSourceCache.get(source);
}

/** 设置单来源缓存 */
export function setCachedSource(source: SettingSource, value: ParsedSettings): void {
  perSourceCache.set(source, value);
}

/**
 * 失效单来源缓存（删除键，使下次读取重新读盘）。
 * 与 setCachedSource(source, null) 的区别：null 是"已缓存且该来源无设置"，会被
 * getCachedSource 当命中返回；delete 才是"未缓存",触发重新读盘。补丁写入后必须用这个——
 * 否则同会话内后续 read-then-patch 会读到 null、从空对象起步，覆盖掉前一次补丁的字段。
 */
export function clearCachedSource(source: SettingSource): void {
  perSourceCache.delete(source);
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

/**
 * HC24：ConfigChange hook 拦截变更时，把单来源缓存回退到变更前的快照。
 * 会话级合并缓存一并失效，下次 getSettings 用回退后的单来源值重新合并——
 * 不回退 L1 的话合并结果仍是磁盘上的新值，拦截形同虚设。
 * 只作用于内存：磁盘文件保持用户写入的新内容，下次外部修改（或重启）会重新判定。
 */
export function restoreSourceSnapshot(source: SettingSource, snapshot: ParsedSettings): void {
  perSourceCache.set(source, snapshot);
  sessionSettingsCache = null;
}

/**
 * 两份设置之间顶层键的差异（新增 / 删除 / 值变化），供 ConfigChange 的 changed_keys。
 * 只比顶层：CC 的 changed_keys 也是字段级粒度，深比较到叶子对 matcher 没有用处。
 */
export function diffTopLevelKeys(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): string[] {
  const a = before ?? {};
  const b = after ?? {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();
}
