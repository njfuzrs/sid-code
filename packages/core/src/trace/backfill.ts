/**
 * 启动时补传扫描（P0 最后一道防线）
 *
 * ## 为什么必须有这一层
 *
 * 2026-09-16 实测：本机 52 个交互式会话 **0 个**上传到平台，且 **0 个**带 `.uploaded` 标记。
 * 排查后确认的链条不是"上传失败"，而是**上传从来没被执行到**：
 *
 * | 现象（实测 52 个会话） | 数字 | 含义 |
 * |---|---|---|
 * | `events.jsonl` 里有 `SessionEnd` 事件 | 13 / 52 | 其余 39 个 SessionEnd **一次都没跑** |
 * | 那 13 个的 `reason` | 全是 `error` | 只有崩溃兜底路径进过 SessionEnd |
 * | 有 `messages.json`（handleSessionEnd 在上传**之前**写） | 0 / 52 | 连上传前的落盘都没走完 |
 * | 残留 `heartbeat.txt`（SessionEnd 末尾会删） | 52 / 52 | 独立佐证：SessionEnd 收尾从未完成 |
 *
 * 而 traj 里那 34 个 `exit_status: "end_turn"` 是 `builder.ts` 从 `stop_reason` **推断**出来的，
 * 不是真终态（34 推断 + 5 unknown = 39，与"无 SessionEnd"的数量精确吻合）。
 * **别拿 exit_status 当"会话正常收尾"的判据** —— 它在这个问题上恰好是伪装成好消息的缺省值。
 *
 * ⚠️ 最值得记住的一点：告警系统当时**已经看见了**这个症状，却把它判成无害 ——
 * warn.log 里有 `发现 51 个未正常收尾的历史会话（进程已退出但残留 heartbeat，非 hang）`。
 * 「非 hang」是对的，但它同时也是「51 个会话的轨迹没上传」，那句话把唯一的线索标成了背景噪音。
 *
 * ## 判据为什么用 `.uploaded` 而不是重试队列
 *
 * 重试队列（`.upload_queue.jsonl`）本身不可靠：条目指向的会话目录会被 LRU
 * （`maxSessionsRetained` 默认 100）轮转删掉，剩下一堆指向空地址的门票。
 * 而「目录在、`session.traj` 在、`.uploaded` 缺」这个判据是**自洽**的：
 * 它只依赖磁盘现状，不依赖任何一个可能已经失真的旁路记录。
 *
 * ## 边界：为什么扫描要这么保守
 *
 * 多开终端是常态，所以「未上传」不等于「可以上传」——正在被另一个 sid-code 进程写的
 * 会话必须跳过，否则会传上去一份中途快照，并给它盖上 `.uploaded` 章，
 * 于是**真正的终态永远不会再被传**（标记一写，本模块下次就不再看它了）。
 * 判活用三条独立信号，任一命中即跳过（宁可这次不传，下次启动再传）：
 *   1. 是当前进程自己的会话；
 *   2. `heartbeat.txt` 的 `ts` 比 `heartbeatFreshMs` 还新 —— 有进程正在每 10s 写它；
 *   3. `.pids/*.json` 里有该 session 的条目且 `process.kill(pid, 0)` 判活。
 *
 * 再加一条时间闸：目录 mtime 太新（`minAgeMs`）一律不动 —— 覆盖"刚建目录、心跳还没写第一次"
 * 那个窗口，这个窗口里上面三条信号全都是空的。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "../debug/logger.ts";

/** 只需要 uploadSession 的最小上传器视图（便于测试注入，无需真实网络） */
export interface BackfillUploader {
  uploadSession(sessionDir: string, sessionId: string): Promise<{ allConfirmed: boolean }>;
}

export interface BackfillOptions {
  /** 轨迹根目录（`.../trajectories`），其下应有 `sessions/` */
  outputDir: string;
  /** 当前进程自己的会话 id —— 永不补传（它还在写） */
  currentSessionId?: string;
  /** 单次启动最多补传多少个会话（默认 20），防止启动时打爆网络 */
  maxSessions?: number;
  /** 并发上传数（默认 2） */
  concurrency?: number;
  /** 目录至少静置这么久才考虑补传（默认 60s） */
  minAgeMs?: number;
  /** 心跳比这个还新 = 有活进程在写（默认 30s，心跳周期是 10s） */
  heartbeatFreshMs?: number;
  /** 中止信号：退出时取消未完成的补传，绝不拖慢退出 */
  signal?: AbortSignal;
}

/** 一个待补传的会话 */
export interface PendingSession {
  sessionId: string;
  dir: string;
  /** 目录 mtime，用于「最旧优先」排序 */
  mtimeMs: number;
  /** session.traj 字节数（仅用于日志/诊断） */
  trajBytes: number;
}

/** 扫描统计：每个被跳过的会话都必须落进某一格，不允许「悄悄没了」 */
export interface ScanStats {
  /** 扫到的会话目录总数 */
  scanned: number;
  /** 已带 `.uploaded` 标记 */
  alreadyUploaded: number;
  /** 没有 session.traj（空壳 / 正在初始化） */
  noTraj: number;
  /** session.traj 是 0 字节（写了一半） */
  emptyTraj: number;
  /** 目录太新，本轮不动 */
  tooNew: number;
  /** 判定为有活进程在写 */
  live: number;
  /** 只有 session.traj、没有 events.jsonl 的「幽灵目录」，不传 */
  ghost: number;
  /** 读目录/文件出错 */
  errored: number;
}

export interface ScanResult {
  /** 待补传会话，最旧优先（最旧的最接近被 LRU 轮转删掉） */
  pending: PendingSession[];
  stats: ScanStats;
}

export interface BackfillResult extends ScanStats {
  /** 待补传总数（= pending.length，未受 maxSessions 截断） */
  pending: number;
  /** 本轮实际尝试的会话数（受 maxSessions 截断） */
  attempted: number;
  /** 全部文件确认上传 */
  uploaded: number;
  /** 上传未全部确认（已进重试队列） */
  failed: number;
  /** 上传抛异常 */
  errors: number;
  /** 因 maxSessions 截断而本轮没碰的会话数 */
  deferred: number;
  /** 是否被 AbortSignal 中止 */
  aborted: boolean;
}

/** 读 heartbeat.txt 的 ts，取不到返回 null（损坏/空文件/无字段都算取不到） */
function readHeartbeatTs(sessionDir: string): number | null {
  try {
    const raw = readFileSync(join(sessionDir, "heartbeat.txt"), "utf-8").trim();
    if (!raw) return null;
    const ts = (JSON.parse(raw) as { ts?: unknown }).ts;
    if (typeof ts !== "string") return null;
    const ms = new Date(ts).getTime();
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

/**
 * 该 session 是否有存活进程在写。
 *
 * ⚠️ 刻意**不复用** `pid-manager.ts` 的 `findOrphanPids()`：那个模块把路径硬编码在
 * 全局 `sidPaths.trajectories()` 上，而本模块必须只看传进来的 `outputDir` ——
 * 否则测试传 tmpdir 以为隔离了，实际去读真实 HOME 的 `.pids/`，
 * 于是**本机开着一个 sid-code 就能让测试结论翻转**（这类"测试绿但读了真实 HOME"
 * 的坑本仓在 uploader 队列路径上已经踩过一次，见 uploader.ts 的 P1-5 注释）。
 */
function hasLivePid(outputDir: string, sessionId: string): boolean {
  try {
    const pidsDir = join(outputDir, ".pids");
    if (!existsSync(pidsDir)) return false;
    for (const f of readdirSync(pidsDir, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith(".json")) continue;
      try {
        const entry = JSON.parse(readFileSync(join(pidsDir, f.name), "utf-8")) as {
          pid?: unknown;
          session_id?: unknown;
        };
        if (entry.session_id !== sessionId) continue;
        if (typeof entry.pid !== "number" || !Number.isFinite(entry.pid)) continue;
        try {
          // signal 0 = 只探测存在性，不真的发信号。
          // EPERM（进程在但不属于本用户）会抛，此时按「存活」处理——判活宁可宽松。
          process.kill(entry.pid, 0);
          return true;
        } catch (err) {
          return (err as { code?: string })?.code === "EPERM";
        }
      } catch {
        /* 单个 pid 文件损坏不影响其余 */
      }
    }
  } catch {
    /* .pids 读不了就当没有 */
  }
  return false;
}

/**
 * 扫描待补传会话。纯读，无任何副作用（不写盘、不发网络），可安全在启动早期调用。
 */
export function scanPendingUploads(opts: BackfillOptions): ScanResult {
  const { outputDir, currentSessionId, minAgeMs = 60_000, heartbeatFreshMs = 30_000 } = opts;

  const stats: ScanStats = {
    scanned: 0,
    alreadyUploaded: 0,
    noTraj: 0,
    emptyTraj: 0,
    tooNew: 0,
    live: 0,
    ghost: 0,
    errored: 0,
  };
  const pending: PendingSession[] = [];

  const sessionsDir = join(outputDir, "sessions");
  let entries: ReturnType<typeof readdirSync>;
  try {
    if (!existsSync(sessionsDir)) return { pending, stats };
    entries = readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    stats.errored++;
    return { pending, stats };
  }

  const now = Date.now();

  for (const e of entries) {
    // 点开头的是内部目录（`.pids` 等），不是会话
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    stats.scanned++;

    const sessionId = e.name;
    const dir = join(sessionsDir, sessionId);

    try {
      // ① 当前会话：还在写，永不补传
      if (currentSessionId && sessionId === currentSessionId) {
        stats.live++;
        continue;
      }

      // ② 已上传过
      if (existsSync(join(dir, ".uploaded"))) {
        stats.alreadyUploaded++;
        continue;
      }

      // ③ 没有 traj = 没有可上传的主数据（空壳 / 正在初始化）
      const trajPath = join(dir, "session.traj");
      if (!existsSync(trajPath)) {
        stats.noTraj++;
        continue;
      }
      const trajBytes = statSync(trajPath).size;
      if (trajBytes === 0) {
        // 0 字节 = 写了一半，传上去是个坏文件。留着，下次启动再看。
        stats.emptyTraj++;
        continue;
      }

      // ③.5 幽灵目录：有 `session.traj` 却没有 `events.jsonl`。
      //
      // 成因（实测 2026-09-16）：空壳会话被 `cleanupIfBlankSession()` 删掉目录后，
      // side-call 观察者仍触发了一次 `forceRebuildTraj()`，而 `Bun.write()`
      // **会自动重建缺失的父目录** —— 盘上于是留下一个只含 traj 的残骸
      // （inode 与删除前不同，可证是删后重建）。collector 侧已加 `sessionDisposed`
      // 闸从源头堵住，这里是**第二道**：历史遗留的幽灵目录仍在盘上，
      // 而它们正是空壳判定当初想避免的噪音，传上云等于把噪音搬进训练数据。
      //
      // 判据选 `events.jsonl` 而不是别的：它在 SessionStart 就被写入（第一条
      // SessionStart 事件），是「这个会话真的启动过采集」的最早证据；
      // 真实的 52 个会话 events.jsonl 齐全 52/52，所以这条判据不会误伤正常会话。
      if (!existsSync(join(dir, "events.jsonl"))) {
        stats.ghost++;
        continue;
      }

      // ④ 时间闸：目录太新一律不动。
      // ⚠️ mtimeMs 是浮点数，刚建的目录 now - mtimeMs 可能是**负数**；用 `<` 比较
      // 天然把负数判成"太新，不动"，方向是安全的（见 MEMORY mtime-float-breaks-maxage-zero）。
      const mtimeMs = statSync(dir).mtimeMs;
      if (now - mtimeMs < minAgeMs) {
        stats.tooNew++;
        continue;
      }

      // ⑤ 心跳还新 = 有进程正在每 10s 写它
      const hbMs = readHeartbeatTs(dir);
      if (hbMs !== null && now - hbMs < heartbeatFreshMs) {
        stats.live++;
        continue;
      }

      // ⑥ PID 判活
      if (hasLivePid(outputDir, sessionId)) {
        stats.live++;
        continue;
      }

      pending.push({ sessionId, dir, mtimeMs, trajBytes });
    } catch {
      stats.errored++;
    }
  }

  // 最旧优先：最旧的最接近被 LRU（maxSessionsRetained）轮转删掉，先救它
  pending.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return { pending, stats };
}

/**
 * 执行补传。best-effort：**任何情况下都不抛异常**，也不阻塞调用方（由调用方决定是否 await）。
 *
 * 并发受 `concurrency` 限制、总量受 `maxSessions` 限制 —— 52 个积压会话一次性并发上传
 * 会在启动瞬间打爆网络，而补传的价值不依赖"一次传完"（下次启动会接着传）。
 */
export async function runBackfill(
  uploader: BackfillUploader,
  opts: BackfillOptions,
): Promise<BackfillResult> {
  const maxSessions = Math.max(0, opts.maxSessions ?? 20);
  const concurrency = Math.max(1, opts.concurrency ?? 2);
  const { pending, stats } = scanPendingUploads(opts);

  const result: BackfillResult = {
    ...stats,
    pending: pending.length,
    attempted: 0,
    uploaded: 0,
    failed: 0,
    errors: 0,
    deferred: Math.max(0, pending.length - maxSessions),
    aborted: false,
  };

  if (pending.length === 0 || maxSessions === 0) return result;

  const batch = pending.slice(0, maxSessions);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (opts.signal?.aborted) {
        result.aborted = true;
        return;
      }
      const idx = cursor++;
      if (idx >= batch.length) return;
      const item = batch[idx]!;
      result.attempted++;
      try {
        const r = await uploader.uploadSession(item.dir, item.sessionId);
        if (r?.allConfirmed) result.uploaded++;
        else result.failed++;
      } catch (err) {
        result.errors++;
        getLogger().warn("TRACE", `启动补传异常 ${item.sessionId}: ${err}`);
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, () => worker()));
  } catch (err) {
    // worker 内部已全量 try-catch，走到这里只可能是 Promise.all 自身异常；
    // 仍然兜住 —— 补传绝不能把异常抛回启动路径。
    result.errors++;
    getLogger().warn("TRACE", `启动补传批次异常: ${err}`);
  }

  return result;
}

/** 把补传结果渲染成一行日志（`--upload-traces` 与启动日志共用同一口径） */
export function formatBackfillResult(r: BackfillResult): string {
  return (
    `待补传 ${r.pending}，本轮尝试 ${r.attempted}（成功 ${r.uploaded}，` +
    `未确认 ${r.failed}，异常 ${r.errors}）；` +
    `顺延 ${r.deferred}，跳过：已上传 ${r.alreadyUploaded}、无 traj ${r.noTraj}、` +
    `空 traj ${r.emptyTraj}、太新 ${r.tooNew}、进程在写 ${r.live}、` +
    `幽灵目录 ${r.ghost}、读错 ${r.errored}` +
    (r.aborted ? "；已被中止" : "")
  );
}

// ─── 可观测性：上传积压体检 ───

export interface UploadBacklog {
  /** 盘上会话目录总数 */
  totalSessions: number;
  /** 带 `.uploaded` 标记的会话数 */
  uploaded: number;
  /** 缺标记且可补传的会话数 */
  pending: number;
  /** 因有活进程在写而本轮不动的会话数 */
  live: number;
  /** 只含 traj 的幽灵目录数（历史遗留残骸） */
  ghost: number;
  /** 重试队列条目数（读不到时为 null，与 0 区分） */
  queueEntries: number | null;
}

/**
 * 读一遍盘，回答「有多少轨迹还没上云」。纯读，无副作用。
 *
 * 为什么值得单独有个函数：这个 bug 藏了九天，不是因为难查，而是因为**没有任何地方
 * 会说出这个数字**。`debug.log` 只打「上传已启用」，`deleteAfterUpload: false` 让
 * 会话目录看起来一切正常（traj/raw/events 都在、都是新的），肉眼分辨不出没上传 ——
 * 真正的信号是 `.uploaded` 标记缺失，而修复前没有任何命令会提示这件事。
 *
 * `queueEntries` 刻意用 `number | null` 而不是 0 兜底：「队列文件读不到」和
 * 「队列是空的」是两种完全不同的处境，压成同一个 0 会让排查者以为队列健康。
 */
export function getUploadBacklog(opts: BackfillOptions): UploadBacklog {
  const { pending, stats } = scanPendingUploads(opts);
  let queueEntries: number | null = null;
  try {
    const qPath = join(opts.outputDir, ".upload_queue.jsonl");
    if (existsSync(qPath)) {
      queueEntries = readFileSync(qPath, "utf-8").trim().split("\n").filter(Boolean).length;
    } else {
      queueEntries = 0;
    }
  } catch {
    queueEntries = null;
  }
  return {
    totalSessions: stats.scanned,
    uploaded: stats.alreadyUploaded,
    pending: pending.length,
    live: stats.live,
    ghost: stats.ghost,
    queueEntries,
  };
}
