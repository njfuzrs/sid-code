/**
 * Skill 文件监听与热重载（Task 4）
 *
 * 监听 skills 目录的文件变更（SKILL.md 增删改），防抖后触发重载回调。
 * 用 node:fs.watch（递归）实现，避免引入 chokidar 依赖。
 *
 * 注意：fs.watch 的递归模式在 Linux 上历史有兼容问题，这里做了降级处理——
 * 监听失败时静默禁用热重载（不影响主流程），仅记录日志。
 */

import { watch, type FSWatcher } from "node:fs";
import { existsSync } from "node:fs";
import { getLogger } from "../debug/logger.ts";

/** 防抖延迟（毫秒） */
const DEFAULT_DEBOUNCE_MS = 300;

export interface ChangeDetectorOptions {
  /** 防抖延迟 */
  debounceMs?: number;
  /** 变更回调（防抖后触发，参数为发生变化的目录） */
  onChange: (changedDirs: string[]) => void | Promise<void>;
}

export class SkillChangeDetector {
  private watchers: FSWatcher[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingDirs = new Set<string>();
  private debounceMs: number;
  private onChange: ChangeDetectorOptions["onChange"];
  private started = false;

  constructor(options: ChangeDetectorOptions) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.onChange = options.onChange;
  }

  /** 开始监听指定的 skills 目录列表 */
  watchDirs(dirs: string[]): void {
    const log = getLogger();
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      try {
        const watcher = watch(dir, { recursive: true }, (_event, filename) => {
          // 只关心 SKILL.md / .md 文件变更
          if (filename && /\.md$/i.test(String(filename))) {
            this.scheduleReload(dir);
          }
        });
        watcher.on("error", (err) => {
          log.debug("SKILL", `文件监听错误 (${dir}): ${err.message}`);
        });
        this.watchers.push(watcher);
        this.started = true;
      } catch (err: any) {
        // 监听失败不影响主流程，仅降级
        log.debug("SKILL", `无法监听 skills 目录 ${dir}: ${err?.message}`);
      }
    }
  }

  /** 调度一次防抖重载 */
  private scheduleReload(dir: string): void {
    this.pendingDirs.add(dir);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      const dirs = [...this.pendingDirs];
      this.pendingDirs.clear();
      this.debounceTimer = null;
      void this.fireChange(dirs);
    }, this.debounceMs);
  }

  private async fireChange(dirs: string[]): Promise<void> {
    const log = getLogger();
    try {
      await this.onChange(dirs);
      log.info("SKILL", `Skill 热重载触发（${dirs.length} 个目录变更）`);
    } catch (err: any) {
      log.warn("SKILL", `Skill 热重载失败: ${err?.message}`);
    }
  }

  /** 是否已启动监听 */
  isWatching(): boolean {
    return this.started;
  }

  /** 停止所有监听并清理 */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // 忽略关闭错误
      }
    }
    this.watchers = [];
    this.pendingDirs.clear();
    this.started = false;
  }
}
