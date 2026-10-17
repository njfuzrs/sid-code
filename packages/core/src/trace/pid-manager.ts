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
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
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
 * PID 复用判定的容差。
 *
 * `entry.start_time` 是 `write()` 被调用的时刻（进程启动后若干秒），`ps -o lstart=` 是进程
 * 真实启动时刻、秒级截断 —— 同一个进程恒有 `lstart ≤ start_time`。只有「进程启动晚于记录时刻」
 * 才必是复用；容差吸收秒级截断与时钟微调，宁可漏判复用，不可把活进程判成孤儿。
 */
export const PID_REUSE_TOLERANCE_MS = 2_000;

/**
 * 解析 `TZ=UTC LC_ALL=C ps -o pid=,lstart= -p a,b,c` 的输出 → pid → 启动时刻（epoch ms）。
 *
 * ⚠️ 输入按 **UTC** 解析，所以调用 ps 时必须同时传 `TZ=UTC`。不能让 ps 打本地时间再用
 * `Date.parse` 按本进程时区解：本进程的 TZ 未必等于 ps 看到的系统时区（实测 `bun test`
 * 把进程 TZ 设成 UTC，而 ps 按系统 +08:00 打印，差 8 小时 ⇒ 活进程全被判成「复用」）。
 *
 * 解析不了的行直接丢掉：调用方对「查不到」一律按存活处理（宁可漏清，不可误删）。
 */
export function parsePsLstart(output: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of output.split("\n")) {
    // 例：`16875 Sun Oct 18 01:18:07 2026`（lstart 的日期是空格对齐的，`Oct  2` 有两个空格）
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const ms = Date.parse(`${m[2]!.replace(/\s+/g, " ")} GMT`);
    if (Number.isFinite(ms)) out.set(Number(m[1]), ms);
  }
  return out;
}

/** 进程真实启动时刻明显晚于 PID 文件记录时刻 ⇒ 这个 pid 已被别的进程复用。 */
export function isPidReused(
  lstartMs: number | undefined,
  recordedIso: string,
  toleranceMs: number = PID_REUSE_TOLERANCE_MS,
): boolean {
  if (lstartMs === undefined) return false;
  const recordedMs = Date.parse(recordedIso);
  if (!Number.isFinite(recordedMs)) return false;
  return lstartMs > recordedMs + toleranceMs;
}

/**
 * 批量查一组 pid 的启动时刻。一次 spawn 查完全部，不按 pid 逐个起子进程。
 *
 * 不比对 `comm`：Linux 截断到 15 字符，与 `process.title` 比不可靠。
 * ps 不可用 / busybox 无 lstart / 超时 → 返回空 Map，调用方据此一律按存活处理。
 * 发布平台只有 darwin + linux（release.sh），不需要 Windows 分支。
 */
function queryStartTimes(pids: number[]): Map<number, number> {
  if (pids.length === 0) return new Map();
  try {
    const r = spawnSync("ps", ["-o", "pid=,lstart=", "-p", pids.join(",")], {
      encoding: "utf-8",
      timeout: 2_000,
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    });
    // 部分 pid 不存在时 ps 退出码非 0，但存在的那些照样会打印 —— 不看退出码，只看输出。
    return parsePsLstart(typeof r.stdout === "string" ? r.stdout : "");
  } catch {
    return new Map();
  }
}

/** 读 `.pids/` 下全部可解析的条目（损坏文件跳过），附 mtime 供排序。 */
function readPidEntries(): Array<{ entry: PidEntry; mtime: number }> {
  if (!existsSync(pidsDir())) return [];
  const out: Array<{ entry: PidEntry; mtime: number }> = [];
  for (const f of readdirSync(pidsDir(), { withFileTypes: true })) {
    if (!f.isFile() || !f.name.endsWith(".json")) continue;
    const filePath = join(pidsDir(), f.name);
    try {
      const entry = JSON.parse(readFileSync(filePath, "utf-8")) as PidEntry;
      if (typeof entry.pid !== "number" || !Number.isFinite(entry.pid)) continue;
      let mtime = 0;
      try {
        mtime = statSync(filePath).mtimeMs;
      } catch {
        /* 取不到 mtime 只影响排序 */
      }
      out.push({ entry, mtime });
    } catch {
      // 文件损坏或无法解析，跳过
    }
  }
  return out;
}

/**
 * 给每个条目判活：`kill -0` 通过之后再比对进程启动时刻，排除 PID 复用。
 *
 * 只用 `kill -0` 的老判据有个永久漏洞：pid 被系统复用给别的进程时，孤儿被当成活的、
 * 永远清不掉（`PidEntry.start_time` 一直存着，却从不参与比对）。
 * EPERM（进程在但不属于本用户）按存活处理，与 backfill.ts 的 `hasLivePid` 同口径。
 */
function classifyPidEntries(
  items: Array<{ entry: PidEntry; mtime: number }>,
): Array<{ entry: PidEntry; mtime: number; alive: boolean }> {
  const kill0 = items.map((it) => {
    try {
      process.kill(it.entry.pid, 0);
      return true;
    } catch (err: any) {
      return err?.code === "EPERM";
    }
  });
  // 本进程自己的条目不必查 ps：它一定是活的，且 start_time 一定不早于自己的启动
  const toQuery = items
    .filter((it, i) => kill0[i] && it.entry.pid !== process.pid)
    .map((it) => it.entry.pid);
  const starts = queryStartTimes(toQuery);
  return items.map((it, i) => ({
    ...it,
    alive:
      kill0[i]! &&
      (it.entry.pid === process.pid || !isPidReused(starts.get(it.entry.pid), it.entry.start_time)),
  }));
}

/**
 * 扫描 .pids/ 目录，返回进程已不存在（或 pid 已被复用）的孤儿 PID 条目。
 * 按文件修改时间升序排列（最早在先）。
 *
 * ⚠️ 以前每次最多返回 10 条（`slice(0, 10)`）：孤儿多于 10 个时，第 11 个起每次启动都看不到，
 * 而调用方是「拿到就删」，等于把清理速度限成每次启动 10 个且对诊断隐瞒总数。现在返回全量。
 */
export function findOrphanPids(): PidEntry[] {
  try {
    return classifyPidEntries(readPidEntries())
      .filter((c) => !c.alive)
      .sort((a, b) => a.mtime - b.mtime)
      .map((c) => c.entry);
  } catch {
    return [];
  }
}

/**
 * 按 pid 删 PID 文件（文件名就是 `<pid>.json`，无需遍历）。
 *
 * 退出路径与孤儿清理都应该用它而不是 `cleanup(sessionId)`：同一个 `session_id` 被另一个
 * 活进程 resume 复用时，按 session_id 删会命中 `readdir` 顺序里的第一个 —— 可能是**活进程**
 * 的文件，于是那个活会话在别的实例眼里「已死」，被当成僵尸去补传 / 清理。
 */
export function removeByPid(pid: number): void {
  try {
    const filePath = join(pidsDir(), `${pid}.json`);
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // 静默失败
  }
}

/**
 * 按 session_id 删 PID 文件。
 *
 * ⚠️ 只保留给外部调用方兼容；本进程的退出路径用 `removeByPid(process.pid)`（理由见那里）。
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
    // 判活只做一次：旧实现对**每个**会话目录都重扫一遍 .pids/（还调一次 findOrphanPids），
    // 现在判活要起一次 ps，再按目录数重复就是 O(会话数) 次 spawn。
    let aliveSessions = new Set<string>();
    try {
      aliveSessions = new Set(
        classifyPidEntries(readPidEntries())
          .filter((c) => c.alive)
          .map((c) => c.entry.session_id),
      );
    } catch {
      /* 判活失败 → 一律按已退出（与旧实现「找不到 pid 文件」同口径） */
    }

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
          // 无 pid 文件 = 进程已退出（PID 文件只在退出路径删、或被孤儿清理删）
          const isProcessAlive = aliveSessions.has(d.name);

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

/** events.jsonl 里有没有 SessionEnd：只做子串探测，不逐行 parse（大会话的 events 上 MB） */
function hasSessionEnd(sessionDir: string): boolean {
  try {
    const raw = readFileSync(join(sessionDir, "events.jsonl"), "utf-8");
    return raw.includes('"event":"SessionEnd"');
  } catch {
    return false;
  }
}

/** 存量 heartbeat 清扫结果 */
export interface HeartbeatSweepResult {
  /** 已删（dryRun 时为「将删」）的会话 id */
  removed: string[];
  /** 进程已退出但没有 SessionEnd —— 刻意保留，digest 把它们当「收尾被打断」的证据 */
  keptNoSessionEnd: string[];
}

/**
 * 清扫「进程已死 ∧ 已有 SessionEnd」会话残留的 heartbeat.txt（S8 存量）。
 *
 * 成因：信号路径的收尾以前被第二个同类信号打断（S15），heartbeat 撤销排在 1.2s race 之后，
 * 一次都没执行到 —— 实测 209 个会话已有 SessionEnd 而 heartbeat 仍在。它们不是 hang，
 * 但每次启动都被报成「未正常收尾」。
 *
 * 只删两个条件同时成立的：
 * - `!is_process_alive`：判活与 `scanStaleHeartbeats()` 同口径（pid 文件 + kill -0 + 复用比对）；
 *   **传入的必须是孤儿 PID 清理之前或之后同一次扫描的结果**，不能混用两次扫描。
 * - events.jsonl 含 SessionEnd：没有 SessionEnd 的死会话保留 heartbeat —— `digest.ts` 靠
 *   「heartbeat 在 + 无 SessionEnd」识别被强杀的会话，删了就抹掉证据。
 *
 * ⚠️ 这一步删用户目录下的文件。`dryRun: true` 只列清单不删，用于人工过目。
 */
export function sweepEndedHeartbeats(
  stale: StaleHeartbeatSession[],
  opts: { dryRun?: boolean } = {},
): HeartbeatSweepResult {
  const result: HeartbeatSweepResult = { removed: [], keptNoSessionEnd: [] };
  for (const s of stale) {
    if (s.is_process_alive) continue;
    const sessionDir = join(sessionsDir(), s.session_id);
    if (!hasSessionEnd(sessionDir)) {
      result.keptNoSessionEnd.push(s.session_id);
      continue;
    }
    if (!opts.dryRun) {
      try {
        unlinkSync(join(sessionDir, "heartbeat.txt"));
      } catch {
        continue; // 删不掉就不计入 removed
      }
    }
    result.removed.push(s.session_id);
  }
  return result;
}
