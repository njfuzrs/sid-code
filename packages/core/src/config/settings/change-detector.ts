/**
 * Settings 变更检测器
 *
 * 对齐 Spec 15 §4.2：fs.watch（监听目录）+ 稳定性检查 + 删除宽限期 + fanOut 单生产者。
 *
 * - 稳定性检查：编辑器保存可能触发多次 change，等待 ~1s 写入稳定后再处理
 * - 删除宽限期：很多编辑器用 delete-and-recreate 保存，rename 事件先等 ~1.7s
 * - 内部写入抑制：sid-code 自己写文件时跳过通知
 * - fanOut 单生产者：先清缓存再通知，避免 N 个订阅者触发 N 次磁盘读取
 */

import { watch, type FSWatcher } from "fs";
import { dirname, basename } from "path";
import { EventEmitter } from "events";
import { resetSettingsCache } from "./cache.ts";
import { consumeInternalWrite } from "./internal-writes.ts";
import type { SettingSource } from "./constants.ts";
import { getLogger } from "../../debug/logger.ts";

/** 变更事件发射器。事件名 'change'，回调参数为 SettingSource。 */
export const settingsChanged = new EventEmitter();

const FILE_STABILITY_THRESHOLD_MS = 1000; // 等待文件写入稳定
const INTERNAL_WRITE_WINDOW_MS = 5000; // 内部写入识别窗口
const DELETION_GRACE_MS = 1700; // 删除事件宽限期

let watchers: FSWatcher[] = [];
const pendingDeletions = new Map<string, ReturnType<typeof setTimeout>>();
const stabilityTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * 初始化变更检测器——监听所有 settings 文件的变更。
 * @param settingsFiles 文件路径 → 来源 的映射（见 constants.getSettingsFilePaths）
 */
export function initializeChangeDetector(settingsFiles: Map<string, SettingSource>): void {
  cleanup(); // 清理旧监听器

  for (const [filePath, source] of settingsFiles) {
    try {
      const dir = dirname(filePath);
      const filename = basename(filePath);

      const watcher = watch(dir, (eventType, changedFile) => {
        if (changedFile !== filename) return;

        if (eventType === "rename") {
          handlePossibleDeletion(filePath, source);
        } else {
          handleChange(filePath, source);
        }
      });

      watcher.on("error", () => {}); // 静默处理监听错误
      watchers.push(watcher);
    } catch {
      // 目录不存在等情况，静默跳过
    }
  }
}

/** 处理文件变更——带稳定性检查 */
function handleChange(path: string, source: SettingSource): void {
  const existing = stabilityTimers.get(path);
  if (existing) clearTimeout(existing);

  stabilityTimers.set(
    path,
    setTimeout(() => {
      stabilityTimers.delete(path);

      // 内部写入 → 跳过通知
      if (consumeInternalWrite(path, INTERNAL_WRITE_WINDOW_MS)) return;

      // 取消可能的 pending 删除（delete-and-recreate 模式）
      const pendingDelete = pendingDeletions.get(path);
      if (pendingDelete) {
        clearTimeout(pendingDelete);
        pendingDeletions.delete(path);
      }

      fanOut(source);
    }, FILE_STABILITY_THRESHOLD_MS),
  );
}

/** 处理可能的删除——带宽限期（处理 delete-and-recreate 保存模式） */
function handlePossibleDeletion(path: string, source: SettingSource): void {
  if (pendingDeletions.has(path)) return;

  pendingDeletions.set(
    path,
    setTimeout(() => {
      pendingDeletions.delete(path);
      // 宽限期过后仍未重建 → 真正的删除/重建
      if (consumeInternalWrite(path, INTERNAL_WRITE_WINDOW_MS)) return;
      fanOut(source);
    }, DELETION_GRACE_MS),
  );
}

/** fanOut：单生产者模式——先清缓存，再通知订阅者 */
function fanOut(source: SettingSource): void {
  resetSettingsCache();
  getLogger().info("SETTINGS", `检测到 ${source} 变更，缓存已刷新`);
  settingsChanged.emit("change", source);
}

/** 清理所有监听器与定时器 */
export function cleanup(): void {
  for (const w of watchers) {
    try {
      w.close();
    } catch {
      /* ignore */
    }
  }
  watchers = [];
  for (const timer of stabilityTimers.values()) clearTimeout(timer);
  stabilityTimers.clear();
  for (const timer of pendingDeletions.values()) clearTimeout(timer);
  pendingDeletions.clear();
}
