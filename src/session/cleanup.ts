/**
 * 会话自动清理
 * 根据配置自动清理过期会话，释放磁盘空间
 */

import { join } from "path";
import { existsSync, unlinkSync, rmSync } from "fs";
import type { Config } from "../config/config.ts";
import type { SessionFileEntry } from "./utils.ts";
import { getAllSessionFiles } from "./utils.ts";
import { getLogger } from "../debug/logger.ts";
import { sidHomePath, sidPaths } from "../config/paths.ts";

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
  currentSessionId?: string
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

  // 添加损坏文件
  const corruptedFiles = allFiles.filter((entry) => entry.sessionInfo === null);
  toDelete.push(...corruptedFiles);

  return toDelete;
}

/**
 * 删除会话及关联资源
 */
async function deleteSessionArtifacts(
  sessionId: string,
  sessionFileName: string,
  config: Config
): Promise<void> {
  const log = getLogger();

  // 删除会话文件
  const sessionDir = sidPaths.sessions();
  const sessionPath = join(sessionDir, sessionFileName);
  if (existsSync(sessionPath)) {
    unlinkSync(sessionPath);
    log.debug("CLEANUP", `已删除会话文件: ${sessionFileName}`);
  }

  // 删除摘要文件
  const summaryDir = join(sessionDir, "summaries");
  const summaryPath = join(summaryDir, `${sessionId}.json`);
  if (existsSync(summaryPath)) {
    unlinkSync(summaryPath);
    log.debug("CLEANUP", `已删除摘要文件: ${sessionId}.json`);
  }

  // 删除关联资源（如果有项目哈希）
  // 注意：这里假设项目哈希存储在配置中
  // 实际实现可能需要从会话数据中读取
  const projectHash = config.projectHash;
  if (projectHash) {
    const tmpDir = sidHomePath("tmp", projectHash);

    // 删除日志文件
    const logPath = join(tmpDir, "logs", `session-${sessionId}.jsonl`);
    if (existsSync(logPath)) {
      unlinkSync(logPath);
      log.debug("CLEANUP", `已删除日志文件: session-${sessionId}.jsonl`);
    }

    // 删除工具输出目录
    const toolOutputDir = join(tmpDir, "tool-outputs", `session-${sessionId}`);
    if (existsSync(toolOutputDir)) {
      rmSync(toolOutputDir, { recursive: true, force: true });
      log.debug("CLEANUP", `已删除工具输出目录: session-${sessionId}`);
    }

    // 删除会话临时目录
    const sessionTmpDir = join(tmpDir, sessionId);
    if (existsSync(sessionTmpDir)) {
      rmSync(sessionTmpDir, { recursive: true, force: true });
      log.debug("CLEANUP", `已删除会话临时目录: ${sessionId}`);
    }
  }
}

/**
 * 清理过期会话
 */
export async function cleanupExpiredSessions(
  config: Config,
  retentionConfig: SessionRetentionSettings,
  currentSessionId?: string
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
    currentSessionId
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
        await deleteSessionArtifacts(
          entry.sessionInfo.id,
          entry.fileName,
          config
        );
        result.deleted++;
        result.deletedIds.push(entry.sessionInfo.id);
      } else {
        // 损坏文件，直接删除
        const sessionPath = join(sessionDir, entry.fileName);
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
      `会话清理完成: 扫描 ${result.scanned} 个，删除 ${result.deleted} 个，跳过 ${result.skipped} 个，失败 ${result.failed} 个`
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
