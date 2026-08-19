/**
 * 文件编辑意图声明（并发冲突检测 Phase 1）
 *
 * 每个会话在开始编辑文件时，向共享存储声明意图。
 * 其他会话在 Edit/Write 前检查是否有冲突。
 *
 * 存储结构：~/.sid-code/file-intents/<sessionId>.json
 * 每个会话一个文件，包含该会话正在关注的所有文件列表。
 *
 * 设计决策：
 * - 按 sessionId 一文件（不是按被编辑文件一文件）——避免锁文件爆炸
 * - intent 不是 lock——不阻塞其他会话，只用于检测和告警
 * - 自动过期——lastAccessAt 超过 5 分钟未更新的 intent 视为过期（防止崩溃残留）
 */

import { writeFileSync, readFileSync, readdirSync, unlinkSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { sidPaths } from "../config/paths.ts";
import { isProcessAlive } from "./concurrent.ts";
import { getLogger } from "../debug/logger.ts";

/** 文件操作类型 */
export type FileOperation = "read" | "edit" | "write";

/** 单个文件的编辑意图 */
export interface FileIntent {
  /** 文件绝对路径（NFC 归一化） */
  path: string;
  /** 声明时间戳 */
  declaredAt: number;
  /** 最近一次 Read/Edit/Write 时间 */
  lastAccessAt: number;
  /** 最近一次操作类型 */
  operation: FileOperation;
}

/** 会话的文件意图集合 */
export interface SessionFileIntents {
  sessionId: string;
  pid: number;
  cwd: string;
  files: Record<string, FileIntent>;
}

/** 过期时间：5 分钟（毫秒） */
const INTENT_EXPIRY_MS = 5 * 60 * 1000;

function intentsDir(): string {
  return sidPaths.fileIntents();
}

function intentPath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(intentsDir(), `${safe}.json`);
}

/**
 * 声明文件编辑意图。
 *
 * @param sessionId 当前会话 ID
 * @param pid 当前进程 PID
 * @param cwd 当前工作目录
 * @param filePath 文件绝对路径（会被 NFC 归一化）
 * @param operation 操作类型
 */
export function declareFileIntent(
  sessionId: string,
  pid: number,
  cwd: string,
  filePath: string,
  operation: FileOperation,
): void {
  try {
    mkdirSync(intentsDir(), { recursive: true });

    const normalizedPath = filePath.normalize("NFC");
    const now = Date.now();
    const path = intentPath(sessionId);

    let intents: SessionFileIntents = {
      sessionId,
      pid,
      cwd,
      files: {},
    };

    // 读取现有 intents
    if (existsSync(path)) {
      try {
        intents = JSON.parse(readFileSync(path, "utf-8"));
      } catch {
        // 损坏的文件，覆盖
      }
    }

    // 更新或新增文件意图
    const existing = intents.files[normalizedPath];
    intents.files[normalizedPath] = {
      path: normalizedPath,
      declaredAt: existing?.declaredAt ?? now,
      lastAccessAt: now,
      operation,
    };

    writeFileSync(path, JSON.stringify(intents, null, 2));
  } catch (err: any) {
    // 声明失败不应阻塞操作，但需可观测
    getLogger().warn("FILE-INTENT", `声明文件意图失败: ${err?.message ?? err}`);
  }
}

/**
 * 清理会话的所有文件意图。
 * 在会话退出时调用。
 */
export function clearFileIntent(sessionId: string): void {
  try {
    const path = intentPath(sessionId);
    if (existsSync(path)) {
      unlinkSync(path);
    }
  } catch (err: any) {
    getLogger().warn("FILE-INTENT", `清理文件意图失败: ${err?.message ?? err}`);
  }
}

/**
 * 查询所有活跃会话的文件意图。
 *
 * @returns 按 sessionId 索引的意图集合（已过滤 stale 和过期）
 */
export function queryAllFileIntents(): Record<string, SessionFileIntents> {
  const dir = intentsDir();
  if (!existsSync(dir)) return {};

  const result: Record<string, SessionFileIntents> = {};
  const now = Date.now();

  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return {};
  }

  for (const file of files) {
    const full = join(dir, file);
    let intents: SessionFileIntents;
    try {
      intents = JSON.parse(readFileSync(full, "utf-8"));
    } catch {
      // 损坏的文件，清理
      try {
        unlinkSync(full);
      } catch {
        /* 忽略 */
      }
      continue;
    }

    // 检查进程是否存活
    if (!isProcessAlive(intents.pid)) {
      try {
        unlinkSync(full);
      } catch {
        /* 忽略 */
      }
      continue;
    }

    // 过滤过期的文件意图
    const activeFiles: Record<string, FileIntent> = {};
    for (const [path, intent] of Object.entries(intents.files)) {
      if (now - intent.lastAccessAt < INTENT_EXPIRY_MS) {
        activeFiles[path] = intent;
      }
    }

    if (Object.keys(activeFiles).length > 0) {
      result[intents.sessionId] = {
        ...intents,
        files: activeFiles,
      };
    }
  }

  return result;
}

/**
 * 查询特定文件的编辑意图。
 *
 * @param targetFile 目标文件绝对路径（会被 NFC 归一化）
 * @param excludeSessionId 排除的会话 ID（通常是当前会话自己）
 * @returns 声明了该文件的其他会话列表
 */
export function queryFileIntents(
  targetFile: string,
  excludeSessionId?: string,
): Array<{
  sessionId: string;
  pid: number;
  cwd: string;
  intent: FileIntent;
}> {
  const normalizedPath = targetFile.normalize("NFC");
  const allIntents = queryAllFileIntents();
  const conflicts: Array<{
    sessionId: string;
    pid: number;
    cwd: string;
    intent: FileIntent;
  }> = [];

  for (const [sessionId, sessionIntents] of Object.entries(allIntents)) {
    if (excludeSessionId && sessionId === excludeSessionId) {
      continue;
    }

    const intent = sessionIntents.files[normalizedPath];
    if (intent) {
      conflicts.push({
        sessionId,
        pid: sessionIntents.pid,
        cwd: sessionIntents.cwd,
        intent,
      });
    }
  }

  return conflicts;
}
