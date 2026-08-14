/**
 * PID 文件管理 + 心跳残留扫描模块
 *
 * 目标：补充 crash-marker 无法覆盖的场景：
 * - SIGKILL (kill -9)：没有 uncaughtException，crash-marker 无法落盘
 * - segfault / OOM killer：进程被内核直接终止
 * - 进程 hang：心跳超时但进程仍在
 *
 * 设计原则：
 * - 与 crash-marker 风格一致：同步写、try-catch 绝不抛异常
 * - PID 文件：启动时写，正常退出时删；残留 = 异常退出
 * - 心跳扫描：检测有心跳无 crash.json 的会话 → 疑似 hang
 *
 * 对标 claude-code：claude-code 无此模块（its ecosystem manage process lifecycle differently），
 * 此为 sid-code 独有创新。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { sidPaths } from "../config/paths.ts";

// ─── 类型定义 ───

/** PID 文件条目 */
export interface PidEntry {
  /** 进程 ID */
  pid: number;
  /** 会话 ID */
  session_id: string;
  /** 进程启动时间（ISO 8601） */
  start_time: string;
  /** 进程标题 */
  process_title: string;
}

/** 心跳残留会话 */
export interface StaleHeartbeatSession {
  /** 会话 ID */
  session_id: string;
  /** 最后心跳时间（ISO 8601） */
  last_heartbeat_ts: string;
  /** 进程是否仍存活 */
  is_process_alive: boolean;
}

/**
 * 心跳残留会话的分类结果。
 *
 * 之所以要分类：这两类的**处置方式相反**。真 hang 是「现在就有个进程卡着」，值得告警；
 * 未正常收尾是「历史残留」，除了顺手补个 cost 什么都不用做。混在一条 WARN 里报，
 * 真 hang 会被几十条残留淹没，等于告警作废。
 */
export interface StaleHeartbeatClassification {
  /** 进程仍存活但心跳停止 → 真 hang，值得告警 */
  hang: StaleHeartbeatSession[];
  /** 进程已退出、只是没清 heartbeat → 未正常收尾（残留），非故障 */
  unfinished: StaleHeartbeatSession[];
}

// ─── 路径常量 ───

/** 基础路径：~/.sid-code/trajectories/ */
function baseDir(): string {
  return sidPaths.trajectories();
}

/** PID 文件目录 */
function pidsDir(): string {
  return join(baseDir(), ".pids");
}

/** Sessions 目录 */
function sessionsDir(): string {
  return join(baseDir(), "sessions");
}

// ─── PID 文件管理 ───

/**
 * 同步写入 PID 文件到 ~/.sid-code/trajectories/.pids/{pid}.json。
 *
 * 使用同步写入（writeFileSync），与 crash-marker 风格一致，
 * 确保在进程启动早期就能落盘。
 */
export function write(sessionId: string): boolean {
  try {
    if (!existsSync(pidsDir())) {
      mkdirSync(pidsDir(), { recursive: true });
    }

    const entry: PidEntry = {
      pid: process.pid,
      session_id: sessionId,
      start_time: new Date().toISOString(),
      process_title: process.title || process.argv0 || "unknown",
    };

    const filePath = join(pidsDir(), `${process.pid}.json`);
    writeFileSync(filePath, JSON.stringify(entry, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * 扫描 .pids/ 目录，返回进程已不存在的孤儿 PID 条目。
 * 按文件修改时间升序排列（最早在先），最多返回 10 个。
 *
 * 使用 process.kill(pid, 0) 检测进程是否存活：
 * - ESERV 错误 → 进程不存在
 * - 无错误 → 进程存在
 * - EPERM 错误 → 进程存在但无权限（视为存活）
 */
export function findOrphanPids(): PidEntry[] {
  try {
    if (!existsSync(pidsDir())) return [];

    const files = readdirSync(pidsDir(), { withFileTypes: true });
    const orphans: Array<{ entry: PidEntry; mtime: number }> = [];

    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".json")) continue;

      const filePath = join(pidsDir(), f.name);
      try {
        const raw = readFileSync(filePath, "utf-8");
        const entry = JSON.parse(raw) as PidEntry;

        // 检测进程是否存在
        try {
          process.kill(entry.pid, 0); // 信号 0 = 不发送信号，仅检查是否存在
          // 进程存在 → 不是孤儿
        } catch (err: any) {
          // ESRCH = 进程不存在
          if (err.code === "ESRCH") {
            // 获取文件修改时间用于排序
            const { statSync } = require("node:fs") as typeof import("node:fs");
            try {
              const stat = statSync(filePath);
              orphans.push({ entry, mtime: stat.mtimeMs });
            } catch {
              orphans.push({ entry, mtime: 0 });
            }
          }
          // EPERM = 无权限（进程可能属于其他用户），视为存在
        }
      } catch {
        // 文件损坏或无法解析，跳过
      }
    }

    // 按时间升序（最老的在前）
    orphans.sort((a, b) => a.mtime - b.mtime);
    return orphans.slice(0, 10).map((o) => o.entry);
  } catch {
    return [];
  }
}

/**
 * 正常退出时删除对应 session 的 PID 文件。
 *
 * 由于 PID 文件以 pid 命名，cleanup 需要遍历 .pids/ 目录
 * 找到 session_id 匹配的文件并删除。
 */
export function cleanup(sessionId: string): void {
  try {
    if (!existsSync(pidsDir())) return;

    const files = readdirSync(pidsDir(), { withFileTypes: true });

    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".json")) continue;

      const filePath = join(pidsDir(), f.name);
      try {
        const raw = readFileSync(filePath, "utf-8");
        const entry = JSON.parse(raw) as PidEntry;
        if (entry.session_id === sessionId) {
          unlinkSync(filePath);
          break; // 一个 session 应该只有一个 PID 文件
        }
      } catch {
        // 文件损坏，跳过
      }
    }
  } catch {
    // 静默失败
  }
}

// ─── 心跳残留扫描 ───

/**
 * 扫描 sessions/ 目录，找出有心跳文件但无 crash.json 的会话。
 *
 * 有心跳无 crash.json 有两种**性质完全不同**的成因，本函数只做原始扫描、不分类：
 * 1. 进程已退出但未清理 heartbeat → 「未正常收尾」（残留，不是故障）
 * 2. 进程仍存活但心跳停止 → 真 hang（需要人看一眼）
 *
 * 判断标准：最后心跳时间 > 30 秒前 → stale。
 *
 * ⚠️ 想要「疑似 hang」结论的调用方请用 `classifyStaleHeartbeats()`，不要直接把本函数
 * 的返回长度当 hang 数报警——`is_process_alive` 字段从一开始就有，但从不参与过滤，
 * 结果是启动诊断把 29 个「已退出」的残留会话全部报成「疑似 hang/僵尸会话」刷屏 29 行
 * （实测 2026-08-10，29 条无一例外都是 `进程状态 已退出`）。
 * 本函数仍返回全量（含已退出），因为 traj cost 补写**刻意**只对已退出的会话做。
 */
export function scanStaleHeartbeats(): StaleHeartbeatSession[] {
  try {
    if (!existsSync(sessionsDir())) return [];

    const dirs = readdirSync(sessionsDir(), { withFileTypes: true });
    const stale: StaleHeartbeatSession[] = [];
    const now = Date.now();

    for (const d of dirs) {
      if (!d.isDirectory()) continue;

      const sessionDir = join(sessionsDir(), d.name);
      const crashPath = join(sessionDir, "crash.json");
      const heartbeatPath = join(sessionDir, "heartbeat.txt");

      // 只关注：有心跳文件 且 无 crash.json 的会话
      // 有 crash.json 的会话已经由 crash-marker 诊断
      if (!existsSync(heartbeatPath) || existsSync(crashPath)) continue;

      try {
        const raw = readFileSync(heartbeatPath, "utf-8").trim();
        if (!raw) continue;

        const heartbeat = JSON.parse(raw);
        const heartbeatTs = heartbeat.ts;
        if (!heartbeatTs) continue;

        const heartbeatMs = new Date(heartbeatTs).getTime();
        if (isNaN(heartbeatMs)) continue;

        // 最后心跳 > 30 秒前 → stale
        if (now - heartbeatMs > 30_000) {
          // 检查 session 目录中是否有 PID 信息（从 .pids/ 目录反向查找）
          let isProcessAlive = false;
          try {
            const orphanPids = findOrphanPids();
            for (const o of orphanPids) {
              if (o.session_id === d.name) {
                isProcessAlive = false; // 在孤儿列表 = 进程已死
                break;
              }
            }
            // 如果不在孤儿列表中，可能进程还在运行
            if (!isProcessAlive) {
              // 再检查 .pids/ 目录中的文件是否匹配该 session
              const pidDir = pidsDir();
              if (existsSync(pidDir)) {
                const pidFiles = readdirSync(pidDir, { withFileTypes: true });
                for (const pf of pidFiles) {
                  if (!pf.isFile() || !pf.name.endsWith(".json")) continue;
                  try {
                    const entryRaw = readFileSync(join(pidDir, pf.name), "utf-8");
                    const entry = JSON.parse(entryRaw) as PidEntry;
                    if (entry.session_id === d.name) {
                      // 找到了对应的 PID 文件，检查进程是否存活
                      try {
                        process.kill(entry.pid, 0);
                        isProcessAlive = true;
                      } catch {
                        // 进程不存在
                      }
                      break;
                    }
                  } catch {
                    /* ignore */
                  }
                }
              }
            }
          } catch {
            /* ignore */
          }

          stale.push({
            session_id: d.name,
            last_heartbeat_ts: heartbeatTs,
            is_process_alive: isProcessAlive,
          });
        }
      } catch {
        // heartbeat 文件损坏，跳过
      }
    }

    return stale;
  } catch {
    return [];
  }
}

/**
 * 把心跳残留会话按「进程是否还活着」分成 hang 与未正常收尾两类。
 *
 * 这一步是纯函数（不碰文件系统），传入 `scanStaleHeartbeats()` 的结果即可，
 * 方便调用方复用同一次扫描：告警读 `hang`，cost 补写读 `unfinished`。
 */
export function classifyStaleHeartbeats(
  stale: StaleHeartbeatSession[],
): StaleHeartbeatClassification {
  const hang: StaleHeartbeatSession[] = [];
  const unfinished: StaleHeartbeatSession[] = [];
  for (const s of stale) {
    if (s.is_process_alive) hang.push(s);
    else unfinished.push(s);
  }
  return { hang, unfinished };
}
