/**
 * monitor 子进程的孤儿兜底（D1-b 第 2 层）
 *
 * ## 为什么需要它
 *
 * monitor 子进程是 `detached` 的进程组组长（`monitor-task.ts` 的 spawn 处，为了 `kill(-pid)`
 * 能清掉 `sleep 60 &` 类孙进程）。代价是父进程死亡**不会**连带杀死它——POSIX 没有
 * PDEATHSIG，Node 也不提供。宿主侧的退出清理（`/quit` / 信号 / 崩溃兜底 / `exit` 事件）
 * 只在宿主还活着时能跑；`kill -9` / OOM 时一行都跑不到，子进程被 launchd/init 收养后
 * 永久泄漏（实测 PID 94623 在宿主 SIGKILL 后 PPID=1 一直运行）。
 *
 * 所以这里换一个时刻兜底：**spawn 时落一份元数据，终态时删；下次启动扫描残留的元数据**，
 * 宿主已死的就清掉它的进程组。
 *
 * ## 三条判据（全部写死在 `classifyMonitorMeta`，改之前先读）
 *
 * 1. **宿主还活着就不动**。多开 sid-code 共享同一个配置根是常态，启动扫描只能杀
 *    「父进程已死」的 monitor，否则会把另一个会话正在用的 monitor 杀掉——这是本兜底
 *    最容易写错的地方（verify-monitor 的 `D1b-orphan-scan-negative` 专门拦它）。
 *    判活与 `PidManager.findOrphanPids` 同口径：`kill(pid, 0)`，EPERM 视为存活；
 *    再用启动时刻排除宿主 pid 被复用（复用 → 原宿主已死）。
 * 2. **进程组身份核对通过才 kill**。monitor 的 pid 可能在它退出后被别的进程复用；
 *    对一个复用了 pgid 的无关进程组发 SIGKILL 是本模块唯一可能造成的真实伤害。
 *    判据：组内至少有一个成员的启动时刻**不晚于**元数据记录的 spawn 时刻（+ 秒级截断容差）。
 *    理由：spawn 那一刻 pid P 被我们的 monitor 占着，任何「复用了 P」的进程都只能在
 *    我们的进程组整体消失之后才出现，启动时刻必然晚于 spawn。核对不上 → 不 kill，
 *    只删元数据并告警（启动时刻不会变，留着下次再核也不会变成「核对通过」）。
 * 3. **查不到就不杀**。`ps` 不可用 / 输出解析不了 → 保留元数据，下次启动再试。
 *    宁可漏清，不可误杀。
 *
 * ## 为什么不用「环境变量注入 task_id 再核对」
 *
 * 那是最直观的精确身份（task_id 随机），但 macOS 的 `ps -E` 读不到 SIP 保护的系统二进制
 * 的环境变量：实测 `zsh -c 'tail -F …'`（exec 后组长就是 `/usr/bin/tail`）0/1 读到标记。
 * monitor 最典型的命令恰恰是 `tail -F | grep`，这条判据在主流场景下等于不存在。
 * 命令行核对同样不行（`trace/digest.ts` 的 `findSessionProcess` 注释记录过：
 * `process_title` 不能可靠排除 PID 复用）。
 *
 * ## 已知限制
 *
 * - 只在「下次启动」发生：用户永不重启 sid-code 时，孤儿留到重启为止。真正的兜底要 OS 级
 *   机制（PDEATHSIG / 进程组归属），POSIX 没有。
 * - Windows 不做：`detached` 在 win32 为 false，没有进程组可清；发布平台只有 darwin + linux。
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { spawnSync } from "node:child_process";
import { sidPaths } from "../config/paths.ts";
import { isPidReused, PID_REUSE_TOLERANCE_MS } from "../trace/pid-manager.ts";
import { getCurrentSessionId } from "./session-task-store.ts";

/**
 * 元数据文件后缀。
 *
 * 与任务输出 `<id>.output` 同住 `sidPaths.tasks()`：启动清理
 * （`startup-housekeeping.ts` 的 `cleanupOrphanedTaskOutputs`）只删 `.output`，
 * `evictTaskOutput` 按内存登记的路径 unlink，都不会碰到这里的 `.monitor.json`。
 * 反过来本模块也只认这个后缀，绝不遍历删除整个目录。
 */
export const MONITOR_META_SUFFIX = ".monitor.json";

/** 一个 monitor 子进程的身份元数据（spawn 时写、终态时删） */
export interface MonitorProcessMeta {
  version: 1;
  task_id: string;
  /** monitor 进程组 id（detached → 组长 pid 即 pgid） */
  pgid: number;
  /** spawn 返回后立即取的时刻（ISO）。进程组身份核对的上界（判据 2） */
  spawned_at: string;
  /** 宿主 sid-code 的 pid */
  host_pid: number;
  /**
   * 宿主写元数据的时刻（ISO）。宿主一定启动得比它早，所以「宿主 pid 上的进程启动晚于它」
   * 必是复用（与 `PidManager.isPidReused` 同一条判据）。
   */
  host_recorded_at: string;
  /**
   * 宿主会话 id（cli.ts 启动时注入 `setCurrentSessionId`；未注入时省略）。
   * 只用于清理日志里「是哪个会话漏的」，**不参与任何判据**：宿主死活与进程组身份
   * 都按 pid + 启动时刻判，会话 id 回答不了「这个 pid 现在还是不是它」。
   */
  session_id?: string;
  /** monitor 命令（截断），只用于清理日志，不参与任何判据 */
  command: string;
}

/** `ps -A -o pid=,pgid=,lstart=` 的一行 */
export interface PsRow {
  pid: number;
  pgid: number;
  /** 进程启动时刻（epoch ms，秒级截断）；解析失败为 NaN */
  startMs: number;
}

/** 单条元数据的判定结果 */
export type OrphanVerdict =
  | { action: "keep"; reason: "host_alive" | "ps_unavailable" }
  | { action: "drop"; reason: "group_gone" | "identity_mismatch" }
  | { action: "reap"; members: number[] };

/** 一次启动扫描的结果（调用方据此写诊断日志） */
export interface OrphanReapReport {
  reaped: Array<{ meta: MonitorProcessMeta; members: number[] }>;
  dropped: Array<{ taskId: string; reason: "group_gone" | "identity_mismatch" | "corrupt" }>;
  kept: Array<{ taskId: string; reason: "host_alive" | "ps_unavailable" }>;
}

const COMMAND_PREVIEW_CHARS = 200;

function metaDir(): string {
  return sidPaths.tasks();
}

function metaPath(taskId: string, dir = metaDir()): string {
  return join(dir, `${taskId}${MONITOR_META_SUFFIX}`);
}

/**
 * spawn 成功后写元数据。同步、绝不抛：落盘失败只意味着这个 monitor 失去 SIGKILL 兜底，
 * 不能影响 monitor 本身（与 `.output` 落盘失败降级的口径一致，T-M1-12）。
 */
export function writeMonitorMeta(opts: {
  taskId: string;
  pgid: number;
  command: string;
  spawnedAt?: number;
}): boolean {
  if (platform() === "win32") return false;
  try {
    const dir = metaDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const meta: MonitorProcessMeta = {
      version: 1,
      task_id: opts.taskId,
      pgid: opts.pgid,
      spawned_at: opts.spawnedAt !== undefined ? new Date(opts.spawnedAt).toISOString() : now,
      host_pid: process.pid,
      host_recorded_at: now,
      ...(getCurrentSessionId() ? { session_id: getCurrentSessionId() } : {}),
      command: opts.command.slice(0, COMMAND_PREVIEW_CHARS),
    };
    writeFileSync(metaPath(opts.taskId, dir), JSON.stringify(meta));
    return true;
  } catch {
    return false;
  }
}

/** 终态时删元数据（幂等、同步、绝不抛——`process.on("exit")` 里也会走到这里） */
export function removeMonitorMeta(taskId: string): void {
  try {
    unlinkSync(metaPath(taskId));
  } catch {
    /* 不存在 / 已删 */
  }
}

/**
 * 解析 `TZ=UTC LC_ALL=C ps -A -o pid=,pgid=,lstart=` 的输出。
 *
 * ⚠️ 必须同时传 `TZ=UTC`：lstart 按 UTC 解析（原因见 `pid-manager.ts` 的 `parsePsLstart`：
 * 本进程 TZ 未必等于 ps 看到的系统时区，`bun test` 下实测差 8 小时）。
 * lstart 的日期是空格对齐的（`Nov  2`），先把连续空白压成一个再解析。
 */
export function parsePsPgidTable(output: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of output.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      pgid: Number(m[2]),
      startMs: Date.parse(`${m[3]!.trim().replace(/\s+/g, " ")} GMT`),
    });
  }
  return rows;
}

/** 全量进程表（一次 spawn）。ps 不可用 / 超时 / 空输出 → null，调用方按「查不到」处理 */
function queryPsTable(): PsRow[] | null {
  try {
    const r = spawnSync("ps", ["-A", "-o", "pid=,pgid=,lstart="], {
      encoding: "utf-8",
      timeout: 2_000,
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    });
    const rows = parsePsPgidTable(typeof r.stdout === "string" ? r.stdout : "");
    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}

/** `kill(pid, 0)` 判活；EPERM（进程在、不属于本用户）视为存活，与 findOrphanPids 同口径 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/**
 * 单条元数据的判定（纯函数：进程表与判活都由调用方注入，便于覆盖 PID 复用等难造的形态）。
 *
 * @param table 全量进程表；null = ps 不可用
 */
export function classifyMonitorMeta(
  meta: MonitorProcessMeta,
  table: PsRow[] | null,
  isAlive: (pid: number) => boolean,
  toleranceMs: number = PID_REUSE_TOLERANCE_MS,
): OrphanVerdict {
  // 判据 1：宿主还活着就不动（宿主 pid 被复用 → 原宿主已死）
  let hostAlive = isAlive(meta.host_pid);
  if (hostAlive && table) {
    const hostRow = table.find((r) => r.pid === meta.host_pid);
    if (hostRow && Number.isFinite(hostRow.startMs)) {
      hostAlive = !isPidReused(hostRow.startMs, meta.host_recorded_at, toleranceMs);
    }
  }
  if (hostAlive) return { action: "keep", reason: "host_alive" };

  // 判据 3：查不到就不杀（留到下次启动）
  if (!table) return { action: "keep", reason: "ps_unavailable" };

  const members = table.filter((r) => r.pgid === meta.pgid);
  if (members.length === 0) return { action: "drop", reason: "group_gone" };

  const timed = members.filter((r) => Number.isFinite(r.startMs));
  if (timed.length === 0) return { action: "keep", reason: "ps_unavailable" };

  // 判据 2：组内至少一个成员启动不晚于 spawn 时刻（+ 秒级截断容差）才认是我们的进程组
  const spawnedMs = Date.parse(meta.spawned_at);
  if (!Number.isFinite(spawnedMs)) return { action: "drop", reason: "identity_mismatch" };
  const verified = timed.some((r) => r.startMs <= spawnedMs + toleranceMs);
  if (!verified) return { action: "drop", reason: "identity_mismatch" };

  return { action: "reap", members: members.map((r) => r.pid) };
}

function parseMeta(raw: string): MonitorProcessMeta | null {
  try {
    const m = JSON.parse(raw) as Partial<MonitorProcessMeta>;
    if (
      typeof m.task_id !== "string" ||
      !Number.isInteger(m.pgid) ||
      (m.pgid as number) <= 1 ||
      !Number.isInteger(m.host_pid) ||
      (m.host_pid as number) <= 0 ||
      typeof m.spawned_at !== "string" ||
      typeof m.host_recorded_at !== "string"
    ) {
      return null;
    }
    return m as MonitorProcessMeta;
  } catch {
    return null;
  }
}

/**
 * 启动扫描：清掉宿主已死的 monitor 进程组，返回清理报告（调用方写诊断日志）。
 *
 * 没有任何元数据文件时**不起 ps**（只有一次 readdir），不给每次启动加开销。
 * 测试可注入进程表 / 判活 / kill；生产调用方不传参数。
 */
export function reapOrphanMonitors(opts?: {
  dir?: string;
  psTable?: () => PsRow[] | null;
  isAlive?: (pid: number) => boolean;
  killGroup?: (pgid: number) => void;
}): OrphanReapReport {
  const report: OrphanReapReport = { reaped: [], dropped: [], kept: [] };
  if (platform() === "win32") return report;
  const dir = opts?.dir ?? metaDir();
  let names: string[];
  try {
    if (!existsSync(dir)) return report;
    names = readdirSync(dir).filter((n) => n.endsWith(MONITOR_META_SUFFIX));
  } catch {
    return report;
  }
  if (names.length === 0) return report;

  const isAlive = opts?.isAlive ?? isProcessAlive;
  const killGroup =
    opts?.killGroup ??
    ((pgid: number) => {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        /* 组已消失（ESRCH）：结果相同 */
      }
    });
  let table: PsRow[] | null | undefined;
  const getTable = (): PsRow[] | null => {
    if (table === undefined) table = (opts?.psTable ?? queryPsTable)();
    return table;
  };

  for (const name of names) {
    const file = join(dir, name);
    const taskId = name.slice(0, -MONITOR_META_SUFFIX.length);
    let meta: MonitorProcessMeta | null = null;
    try {
      meta = parseMeta(readFileSync(file, "utf-8"));
    } catch {
      meta = null;
    }
    if (!meta) {
      // 损坏 / 字段缺失：无从核对身份，留着也永远核不了——删掉，不 kill
      tryUnlink(file);
      report.dropped.push({ taskId, reason: "corrupt" });
      continue;
    }
    const verdict = classifyMonitorMeta(meta, getTable(), isAlive);
    if (verdict.action === "keep") {
      report.kept.push({ taskId: meta.task_id, reason: verdict.reason });
      continue;
    }
    if (verdict.action === "reap") killGroup(meta.pgid);
    tryUnlink(file);
    if (verdict.action === "reap") {
      report.reaped.push({ meta, members: verdict.members });
    } else {
      report.dropped.push({ taskId: meta.task_id, reason: verdict.reason });
    }
  }
  return report;
}

function tryUnlink(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    /* ignore */
  }
}
