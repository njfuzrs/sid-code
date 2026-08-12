/**
 * 团队记忆文件监听器（对标 claude-code teamMemorySync/watcher.ts）
 *
 * 监听本地团队记忆目录，文件变更后 debounce 触发同步（push+pull）；启动时先做
 * 一次初始同步。设计要点（沿用 claude-code 的实战教训）：
 *   - fs.watch({recursive:true}) 监听目录而非每文件（避免 N 个 fd）。
 *   - debounce：最后一次写入后等待 debounceMs 再同步，合并连续写入。
 *   - 失败抑制：永久性失败（如共享目录不可用）不无限重试；监听到 unlink
 *     （用户删文件=恢复动作）时清除抑制重试。
 *   - graceful shutdown：停止时 flush 待同步变更（best-effort）。
 *
 * 模块级单例状态：一个进程一份 watcher（团队记忆目录每项目唯一）。
 */

import { type FSWatcher, watch } from "fs";
import { mkdir, stat } from "fs/promises";
import { join } from "path";
import { getLogger } from "../../debug/logger.ts";
import { getTeamMemPath, isTeamMemorySyncAvailable, type TeamMemoryOptions } from "./paths.ts";
import { syncTeamMemory, type TeamMemorySyncResult } from "./sync.ts";

const DEFAULT_DEBOUNCE_MS = 2000;

// ─── watcher 模块级状态 ──────────────────────────────────────────
let watcher: FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let syncInProgress = false;
let hasPendingChanges = false;
let currentSyncPromise: Promise<void> | null = null;
let watcherStarted = false;
let currentOpts: TeamMemoryOptions | null = null;
let currentCwd: string = process.cwd();
let debounceMs = DEFAULT_DEBOUNCE_MS;

/**
 * 同步失败后置位：永久性失败时抑制重试，避免其它成员对共享目录的写入
 * 反复触发监听 → 无限重试（claude-code BQ 实录：一台设备 2.5 天发了 16.7 万次）。
 * 监听到 unlink 时清除（删文件是 too-many/恢复动作）。
 */
let syncSuppressedReason: string | null = null;

/**
 * 抑制态一次性通知回调（比 claude-code 多做的一点）。
 *
 * claude-code 的同步是彻底 fire-and-forget：抑制后只写 debug 日志 + analytics，
 * 用户在 TUI 里完全无感知，本地新写的团队记忆会静默同步不出去。我们保留这个
 * 「不刷屏」的克制（不逐次提示、不做 push 结果回传），但在**首次进入抑制态**时
 * 给上层一次机会告知用户「同步已暂停」——只此一次，恢复（unlink 清除抑制）后
 * 重新武装，避免用户以为团队记忆仍在正常同步。
 *
 * 对齐 src/ui/CLAUDE.md 交互铁律 C（提示渐进衰减）：同一抑制事件只通知一次。
 */
type SuppressionListener = (reason: string) => void;
let suppressionListener: SuppressionListener | null = null;
/** 防重复：同一次抑制态只通知一次，unlink 清除抑制时复位 */
let suppressionNotified = false;

/** 注册抑制态一次性通知回调（app 层接线；未注册时行为与 claude-code 一致：纯静默） */
export function setTeamMemorySuppressionListener(fn: SuppressionListener | null): void {
  suppressionListener = fn;
}

/**
 * 永久性失败 = 不靠重试就会同样失败。
 * disabled / no_shared_dir 属于配置态，重试无意义。io 错误视为可自愈（共享盘
 * 临时不可达），不抑制。
 */
function isPermanentFailure(r: TeamMemorySyncResult): boolean {
  return r.errorType === "disabled" || r.errorType === "no_shared_dir";
}

/** 执行一次同步并跟踪生命周期 */
async function executeSync(): Promise<void> {
  if (!currentOpts) return;
  const log = getLogger();
  syncInProgress = true;
  try {
    const result = await syncTeamMemory(currentOpts, currentCwd);
    if (result.success) {
      hasPendingChanges = false;
    } else {
      log.warn("TEAMMEM", `watcher 同步失败: ${result.error}`);
      if (isPermanentFailure(result) && syncSuppressedReason === null) {
        syncSuppressedReason = result.errorType ?? "unknown";
        log.warn("TEAMMEM", `抑制重试直到下次 unlink 或会话重启 (${syncSuppressedReason})`);
        // 首次进入抑制态：一次性通知上层（恢复后 suppressionNotified 复位重新武装）
        if (!suppressionNotified && suppressionListener) {
          suppressionNotified = true;
          try {
            suppressionListener(syncSuppressedReason);
          } catch {
            /* 通知失败不影响同步 */
          }
        }
      }
    }
  } catch (e: any) {
    log.warn("TEAMMEM", `watcher 同步异常: ${e?.message ?? e}`);
  } finally {
    syncInProgress = false;
    currentSyncPromise = null;
  }
}

/** debounce 同步：等待写入稳定后同步一次 */
function scheduleSync(): void {
  if (syncSuppressedReason !== null) return;
  hasPendingChanges = true;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (syncInProgress) {
      // 上一轮还在跑，重新排程（同步本身是幂等全量，等它完成再来）
      scheduleSync();
      return;
    }
    currentSyncPromise = executeSync();
  }, debounceMs);
}

/**
 * 启动文件监听。fs.watch 在目录上不区分 add/change/unlink（都触发 rename），
 * 为在 unlink 时清除抑制，对带文件名的事件 stat 一次：ENOENT → 视为 unlink。
 */
async function startFileWatcher(teamDir: string): Promise<void> {
  if (watcherStarted) return;
  watcherStarted = true;
  const log = getLogger();

  try {
    await mkdir(teamDir, { recursive: true });
    watcher = watch(teamDir, { persistent: false, recursive: true }, (_event, filename) => {
      if (filename === null) {
        scheduleSync();
        return;
      }
      // 忽略两类不参与同步的本地文件（避免自触发循环）：
      //   - .team-memory-sync.json：同步状态 manifest，每轮同步都写
      //   - MEMORY.md：本地索引，由 saveTeamMemory / syncTeamMemory 收尾重建。
      //     它本就被 readEntries 排除在同步之外，重建它触发的那一轮同步是纯空转。
      if (
        typeof filename === "string" &&
        (filename.includes(".team-memory-sync.json") || filename.endsWith("MEMORY.md"))
      ) {
        return;
      }
      if (syncSuppressedReason !== null) {
        // 抑制态下：仅 unlink（文件消失）可清除抑制并重试
        void stat(join(teamDir, filename.toString())).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== "ENOENT") return;
          if (syncSuppressedReason !== null) {
            log.info("TEAMMEM", `unlink 清除了抑制 (原因: ${syncSuppressedReason})`);
            syncSuppressedReason = null;
            suppressionNotified = false; // 复位：下次再进入抑制态时可再通知一次
          }
          scheduleSync();
        });
        return;
      }
      scheduleSync();
    });
    watcher.on("error", (err) => {
      log.warn("TEAMMEM", `fs.watch 错误: ${err?.message ?? err}`);
    });
    log.debug("TEAMMEM", `监听团队记忆目录 ${teamDir}`);
  } catch (err: any) {
    // fs.watch 可能同步抛 ENOENT/EACCES；watcherStarted 已置位，notify 仍可手动触发
    log.warn("TEAMMEM", `监听 ${teamDir} 失败: ${err?.message ?? err}`);
  }
}

/**
 * 启动团队记忆同步系统。
 * 早退条件：未启用 / 共享目录不可用。
 * 先做一次初始同步（在 watcher 启动前，其磁盘写入不会触发 scheduleSync），
 * 再无条件启动 watcher（即使共享目录暂为空，新写入也能被捕获）。
 */
export async function startTeamMemoryWatcher(
  opts: TeamMemoryOptions,
  cwd: string = process.cwd(),
): Promise<void> {
  if (!isTeamMemorySyncAvailable(opts)) return;

  const log = getLogger();
  currentOpts = opts;
  currentCwd = cwd;
  debounceMs =
    typeof opts.debounceMs === "number" && opts.debounceMs >= 0
      ? opts.debounceMs
      : DEFAULT_DEBOUNCE_MS;

  // 初始同步（先于 watcher，避免其写入自触发）
  try {
    const result = await syncTeamMemory(opts, cwd);
    if (result.success && (result.pulled || result.pushed)) {
      log.info("TEAMMEM", `初始同步：拉 ${result.pulled} / 推 ${result.pushed}`);
    }
  } catch (e: any) {
    log.warn("TEAMMEM", `初始同步失败: ${e?.message ?? e}`);
  }

  await startFileWatcher(getTeamMemPath(cwd));
}

/**
 * 团队记忆文件写入时显式调用（如 save_memory / write 工具命中团队记忆路径后）。
 * fs.watch 可能漏掉「与 watcher 启动同 tick 的写入」或合并连续写入，显式排程兜底。
 */
export async function notifyTeamMemoryWrite(): Promise<void> {
  if (!currentOpts) return;
  scheduleSync();
}

/**
 * 停止 watcher 并 flush 待同步变更。
 * best-effort：在 graceful shutdown 预算内执行，超时会被 process.exit 截断。
 */
export async function stopTeamMemoryWatcher(): Promise<void> {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (watcher) {
    try {
      watcher.close();
    } catch {
      /* ignore */
    }
    watcher = null;
  }
  // 等待进行中的同步
  if (currentSyncPromise) {
    try {
      await currentSyncPromise;
    } catch {
      /* ignore */
    }
  }
  // flush 已 debounce 但未同步的变更
  if (hasPendingChanges && currentOpts && syncSuppressedReason === null) {
    try {
      await syncTeamMemory(currentOpts, currentCwd);
    } catch {
      /* best-effort */
    }
  }
  watcherStarted = false;
}

/**
 * 仅供测试：重置模块状态。
 */
export function _resetWatcherStateForTesting(opts?: {
  currentOpts?: TeamMemoryOptions | null;
  currentCwd?: string;
  skipWatcher?: boolean;
  syncSuppressedReason?: string | null;
  debounceMs?: number;
}): void {
  if (watcher) {
    try {
      watcher.close();
    } catch {
      /* ignore */
    }
  }
  watcher = null;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  syncInProgress = false;
  hasPendingChanges = false;
  currentSyncPromise = null;
  watcherStarted = opts?.skipWatcher ?? false;
  syncSuppressedReason = opts?.syncSuppressedReason ?? null;
  suppressionNotified = false;
  suppressionListener = null;
  currentOpts = opts?.currentOpts ?? null;
  currentCwd = opts?.currentCwd ?? process.cwd();
  debounceMs = opts?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
}

/** 仅供测试：在指定目录启动真实 fs.watch */
export function _startFileWatcherForTesting(dir: string): Promise<void> {
  return startFileWatcher(dir);
}

/** 仅供测试：暴露当前抑制原因 */
export function _getSuppressedReasonForTesting(): string | null {
  return syncSuppressedReason;
}
