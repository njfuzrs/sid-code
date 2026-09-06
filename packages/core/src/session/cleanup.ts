/**
 * 会话自动清理
 * 根据配置自动清理过期会话，释放磁盘空间
 */

import { join } from "path";
import { existsSync, unlinkSync, rmSync, statSync } from "fs";
import type { Config } from "../config/config.ts";
import type { SessionFileEntry } from "./utils.ts";
import { getAllSessionFiles, isDeletableExcludeReason } from "./utils.ts";
import { getLogger } from "../debug/logger.ts";
import { sidPaths } from "../config/paths.ts";

/** 会话保留配置 */
export interface SessionRetentionSettings {
  /** 是否启用自动清理 */
  enabled: boolean;
  /** 最大保留时间（如 "30d"） */
  maxAge?: string;
  /** 最大保留数量 */
  maxCount?: number;
  /** 最小保留时间（防止误删，如 "1d"） */
  minRetention?: string;
}

/** 清理结果 */
export interface CleanupResult {
  /** 扫描的会话数 */
  scanned: number;
  /** 删除的会话数 */
  deleted: number;
  /** 跳过的会话数 */
  skipped: number;
  /** 失败的会话数 */
  failed: number;
  /** 删除的会话 ID 列表 */
  deletedIds: string[];
  /** 失败的会话 ID 列表 */
  failedIds: string[];
}

/**
 * 解析时间周期（如 "30d" → 毫秒）
 */
export function parseRetentionPeriod(period: string): number {
  const match = period.match(/^(\d+)([hdwm])$/);
  if (!match) {
    throw new Error(`无效的时间周期格式: ${period}`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case "h":
      return value * 60 * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    case "w":
      return value * 7 * 24 * 60 * 60 * 1000;
    case "m":
      return value * 30 * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`未知的时间单位: ${unit}`);
  }
}

/**
 * 识别待删除会话
 */
export async function identifySessionsToDelete(
  allFiles: SessionFileEntry[],
  retentionConfig: SessionRetentionSettings,
  currentSessionId?: string,
  protectedSessionIds?: readonly string[],
): Promise<SessionFileEntry[]> {
  const toDelete: SessionFileEntry[] = [];
  const now = Date.now();

  // 过滤出有效会话（排除损坏文件）
  const validSessions = allFiles.filter((entry) => entry.sessionInfo !== null);

  // 按最后更新时间排序（最新的在前）
  validSessions.sort((a, b) => {
    const aTime = new Date(a.sessionInfo!.lastUpdated).getTime();
    const bTime = new Date(b.sessionInfo!.lastUpdated).getTime();
    return bTime - aTime;
  });

  // 计算时间截止点
  let cutoffDate: number | null = null;
  if (retentionConfig.maxAge) {
    const maxAgeMs = parseRetentionPeriod(retentionConfig.maxAge);
    cutoffDate = now - maxAgeMs;
  }

  // 计算最小保留时间
  let minRetentionDate: number | null = null;
  if (retentionConfig.minRetention) {
    const minRetentionMs = parseRetentionPeriod(retentionConfig.minRetention);
    minRetentionDate = now - minRetentionMs;
  }

  // 应用清理策略
  for (let i = 0; i < validSessions.length; i++) {
    const entry = validSessions[i];
    const session = entry.sessionInfo!;
    const lastUpdated = new Date(session.lastUpdated).getTime();

    // 跳过当前会话
    if (currentSessionId && session.id === currentSessionId) {
      continue;
    }

    // ─────────────────────────────────────────────────────────────
    // D3：跳过**被恢复的会话**。
    //
    // 为什么 currentSessionId 保护不到它：`config.sessionId` 恒是本进程新生成的 id
    // （config.ts 两处赋值都是 generateSessionId()），resume 流程刻意不改写它
    // （trajectory / PID / crash marker 仍用新 id 避免跨进程冲突，只让
    // SessionStore.currentFile 指向旧 jsonl）。于是保护机制看的是「本进程新 id」，
    // 而那个 id 对应的文件此刻还不存在 —— 保护它毫无意义；真正需要保护的
    // 「被恢复会话的旧 id」不在名单里。
    //
    // 后果是真实的：启动时自动清理是 fire-and-forget（不 await），与 await 的
    // restoreSession 并发跑，相对时序完全由事件循环决定。被恢复的会话若落在淘汰名单里
    // （实测本机 51 个文件 > maxCount 50，最旧会话 16 天已超 minRetention=1d），
    // 会在恢复读取的同时被 unlinkSync —— 删在读之前则用户历史永久消失，
    // 删在读之后则续写走「无 jsonl 新建续写文件」兜底，历史碎片成两个文件。
    // ─────────────────────────────────────────────────────────────
    if (protectedSessionIds && protectedSessionIds.includes(session.id)) {
      continue;
    }

    // 跳过最小保留时间内的会话
    if (minRetentionDate && lastUpdated > minRetentionDate) {
      continue;
    }

    // 基于时间的清理
    if (cutoffDate && lastUpdated < cutoffDate) {
      toDelete.push(entry);
      continue;
    }

    // 基于数量的清理
    if (retentionConfig.maxCount && i >= retentionConfig.maxCount) {
      toDelete.push(entry);
      continue;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // D4：损坏文件此前走一条**完全没有保护的旁路** ——
  // `filter(sessionInfo === null)` 后直接 push，绕过 currentSessionId / minRetention /
  // maxAge / maxCount 全部条件。两个独立的问题叠在一起：
  //
  //   1. **判损面比名字宽得多**：`sessionInfo: null` 有 6 种成因，其中「空会话」
  //      「子代理会话」明确不是损坏，「读文件抛异常」可能是瞬时故障（并发写入 /
  //      NFS 抖动）。一次读失败就永久删用户数据，代价与成因严重不匹配。
  //      → 现在只删 isDeletableExcludeReason 白名单内的成因（missing-fields / parse-error）。
  //   2. **连真损坏的文件也不该绕过 minRetention**：minRetention 是防误删的最后兜底，
  //      而「刚写到一半的当前会话」被读到半行时恰好呈现为损坏。
  //      → 现在真损坏文件同样要过 minRetention 与 currentSessionId。
  //
  // 与 D3 叠加时这一条尤其重要：清理与恢复并发读同一个文件可能读到半行 →
  // 判成损坏 → 旧逻辑无条件删除一个**完全健康**的会话。
  // ─────────────────────────────────────────────────────────────
  const log = getLogger();
  for (const entry of allFiles) {
    if (entry.sessionInfo !== null) continue;

    if (!isDeletableExcludeReason(entry.excludeReason)) {
      log.debug(
        "CLEANUP",
        `跳过非损坏的排除项（${entry.excludeReason ?? "unknown"}）: ${entry.fileName}`,
      );
      continue;
    }

    // 损坏文件解析不出 id，无法与 currentSessionId 比对 id；改用文件名匹配
    // （会话文件名恒为 `<id>.jsonl`，见 store.ts 落盘路径），保护正在写入的当前会话。
    const nameGuards = [currentSessionId, ...(protectedSessionIds ?? [])].filter(
      (id): id is string => !!id,
    );
    if (nameGuards.some((id) => entry.fileName.startsWith(id))) {
      log.debug("CLEANUP", `跳过受保护会话的损坏判定: ${entry.fileName}`);
      continue;
    }

    // minRetention 兜底：损坏文件同样受最小保留期保护。解析不出 lastUpdated，
    // 退回文件 mtime —— 这正是「刚被写坏/正在被写」的最好判据。
    if (minRetentionDate !== null) {
      try {
        const mtime = statSync(join(entry.dirPath, entry.fileName)).mtimeMs;
        if (mtime > minRetentionDate) {
          log.debug("CLEANUP", `跳过 minRetention 内的损坏文件: ${entry.fileName}`);
          continue;
        }
      } catch {
        // 连 stat 都失败 → 无法证明它过了最小保留期 → 保守不删。
        continue;
      }
    }

    toDelete.push(entry);
  }

  return toDelete;
}

/**
 * 删除会话及关联资源
 *
 * P0：此前只删 sessions/{id}.jsonl 与 summaries/，**完全不碰 trajectories/sessions/{id}/**，
 * 导致轨迹目录沦为孤儿数据持续堆积（实测 95MB）。这里做对称清理：交互会话被清理时，
 * 连带删除同 id 的 trajectory 目录。
 *
 * 保守边界（避免误删评测/训练资产）：
 * - 只删与被清理「交互会话」**同 id** 的 trajectory 目录。SWE-bench / SFT 等无头评测入口
 *   通常不写 SessionStore（不会出现在 sessions/ 目录），其 id 不会进入本清理流程，天然隔离。
 * - resume 场景下 trajectory 写在本进程新 id 下（见 Bug3 桥接），与旧会话 id 不同，
 *   此处删不到；这类轨迹由 TraceCollector 的 LRU（maxSessionsRetained）兜底回收，不在此强删。
 * - 删除走 best-effort，失败仅告警不抛——清理不是关键路径。
 */
async function deleteSessionArtifacts(
  sessionId: string,
  sessionFileName: string,
  config: Config,
  dirPath?: string,
): Promise<void> {
  const log = getLogger();

  // P0-1：会话按项目分目录后，用条目自带的 dirPath 定位；回退根目录兼容未迁移的平铺文件。
  const sessionDir = dirPath || sidPaths.sessions();
  const sessionPath = join(sessionDir, sessionFileName);
  if (existsSync(sessionPath)) {
    unlinkSync(sessionPath);
    log.debug("CLEANUP", `已删除会话文件: ${sessionFileName}`);
  }

  // 删除摘要文件（与会话文件同项目目录下的 summaries/）
  const summaryDir = join(sessionDir, "summaries");
  const summaryPath = join(summaryDir, `${sessionId}.json`);
  if (existsSync(summaryPath)) {
    unlinkSync(summaryPath);
    log.debug("CLEANUP", `已删除摘要文件: ${sessionId}.json`);
  }

  // P0-1：清理同 id 的 sidechain 文件（`<id>-<agentId>.jsonl`，与主会话同目录）。
  try {
    const { cleanupSidechainsInDir } = await import("./sidechain.ts");
    const removed = cleanupSidechainsInDir(sessionDir, sessionId);
    if (removed > 0) log.debug("CLEANUP", `已删除 sidechain: ${removed} 个 (${sessionId})`);
  } catch (err: any) {
    log.warn("CLEANUP", `删除 sidechain 失败（不阻断）: ${sessionId} - ${err?.message}`);
  }

  // P0：对称清理同 id 的 trajectory 目录（trajectories/sessions/{id}/）。
  // outputDir 优先取 trace 配置覆盖，回退到默认 trajectories 根目录。
  try {
    const trajRoot = config.trace?.outputDir ?? sidPaths.trajectories();
    const trajDir = join(trajRoot, "sessions", sessionId);
    if (existsSync(trajDir)) {
      rmSync(trajDir, { recursive: true, force: true });
      log.debug("CLEANUP", `已删除轨迹目录: trajectories/sessions/${sessionId}`);
    }
  } catch (err: any) {
    log.warn("CLEANUP", `删除轨迹目录失败（不阻断）: ${sessionId} - ${err?.message}`);
  }
}

/**
 * 清理过期会话
 */
export async function cleanupExpiredSessions(
  config: Config,
  retentionConfig: SessionRetentionSettings,
  currentSessionId?: string,
  protectedSessionIds?: readonly string[],
): Promise<CleanupResult> {
  const log = getLogger();

  if (!retentionConfig.enabled) {
    log.debug("CLEANUP", "会话清理未启用");
    return {
      scanned: 0,
      deleted: 0,
      skipped: 0,
      failed: 0,
      deletedIds: [],
      failedIds: [],
    };
  }

  const sessionDir = sidPaths.sessions();

  if (!existsSync(sessionDir)) {
    log.debug("CLEANUP", "会话目录不存在");
    return {
      scanned: 0,
      deleted: 0,
      skipped: 0,
      failed: 0,
      deletedIds: [],
      failedIds: [],
    };
  }

  // 扫描所有会话文件
  const allFiles = await getAllSessionFiles(sessionDir, currentSessionId);
  const scanned = allFiles.length;

  // 识别待删除会话
  const toDelete = await identifySessionsToDelete(
    allFiles,
    retentionConfig,
    currentSessionId,
    protectedSessionIds,
  );

  const result: CleanupResult = {
    scanned,
    deleted: 0,
    skipped: scanned - toDelete.length,
    failed: 0,
    deletedIds: [],
    failedIds: [],
  };

  // 删除会话
  for (const entry of toDelete) {
    try {
      if (entry.sessionInfo) {
        await deleteSessionArtifacts(entry.sessionInfo.id, entry.fileName, config, entry.dirPath);
        result.deleted++;
        result.deletedIds.push(entry.sessionInfo.id);
      } else {
        // 损坏文件，直接删除（P0-1：用条目自带 dirPath 定位所在项目目录）
        const sessionPath = join(entry.dirPath || sessionDir, entry.fileName);
        if (existsSync(sessionPath)) {
          unlinkSync(sessionPath);
          result.deleted++;
        }
      }
    } catch (error: any) {
      log.error("CLEANUP", `删除会话失败: ${entry.fileName}`, error);
      result.failed++;
      if (entry.sessionInfo) {
        result.failedIds.push(entry.sessionInfo.id);
      }
    }
  }

  if (result.deleted > 0) {
    log.info(
      "CLEANUP",
      `会话清理完成: 扫描 ${result.scanned} 个，删除 ${result.deleted} 个，跳过 ${result.skipped} 个，失败 ${result.failed} 个`,
    );
  }

  return result;
}

/**
 * 从配置中获取保留设置
 */
export function getRetentionSettings(config: Config): SessionRetentionSettings {
  const settings = config.sessionRetention || {};
  return {
    enabled: settings.enabled ?? true,
    maxAge: settings.maxAge || "30d",
    maxCount: settings.maxCount || 50,
    minRetention: settings.minRetention || "1d",
  };
}
