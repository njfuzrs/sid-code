/**
 * 启动补传水位（P0-3）
 *
 * ## 要堵的洞
 *
 * 补传（backfill.ts）原先只看「缺 `.uploaded` 标记」，没有时间下限。本地轨迹默认保留
 * 365 天 / 10GB，于是**今天才配上传的用户，几次启动后会把过去一年在未授权状态下
 * 产生的会话全部传走**。换上传地址同理：A 没传完的历史会整批发往新地址 B。
 *
 * ## 三条设计约束（每条都是被否决过的替代方案换来的）
 *
 * 1. **比较对象是会话创建时间，不是目录 mtime**。resume 旧会话会刷新目录 mtime，
 *    用 mtime 当闸，一次 resume 就能把授权前的会话推过水位。创建时间取自会话 id 前缀
 *    （`YYYYMMDD-HHMMSS-<hex>`，本地时区，见 session/id.ts），解析失败再回落
 *    `events.jsonl` 首行 / `session.traj` 的 `start_time`。三者都取不到 → 视为水位前
 *    （fail-closed：宁可少传，不能多传）。
 * 2. **水位按上传目标分别记**：`{ [target]: upload_enabled_at }`。换地址 = 新目标 =
 *    从「现在」起算。target 取 `origin + pathname`（同一主机不同路径前缀可能是两个平台）。
 * 3. **存 state 目录，不写 settings.json**：settings 走 Zod 有损 round-trip，写回会丢字段
 *    （见 patchSettingsFile 的约束）；水位也不是用户该手改的配置。
 *
 * ## 升级迁移：已配置上传的用户行为不变
 *
 * 状态文件不存在 = 本版本首次启动。此时**已经配置**的上传目标，水位取「该目标下最早一个
 * 未上传会话的创建时间」——积压照常补传，一个都不丢；只有升级之后才出现的目标从「现在」起算。
 * 这一步必须在启动时**无条件**跑一次（`ensureUploadWatermarks`，cli 入口调用），否则
 * 「升级时没配上传、过一个月才配」的用户第一次读水位时也会被当成迁移，全量历史又被放出去。
 *
 * 「现在」用的是**进程启动时刻（向下取整到秒）**而不是调用时刻：本进程自己的会话 id 在
 * loadConfig 里生成，早于这里的调用；会话 id 只精确到秒，取整保证它不会落在水位前。
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { sidPaths } from "../config/paths.ts";
import { getLogger } from "../debug/logger.ts";
import { hasFinalUploadMarker } from "./upload-marker.ts";

const STATE_VERSION = 1;

interface WatermarkState {
  version: number;
  /** 本机首次写入水位文件的时间（= 升级到带水位版本的时刻），仅供排查 */
  baseline_at: string;
  /** 上传目标 → 该目标开始被授权上传的时刻（ISO） */
  targets: Record<string, string>;
}

export interface WatermarkOptions {
  /** 轨迹根目录（`.../trajectories`），迁移时扫描其下 `sessions/` */
  outputDir: string;
  /** 状态文件路径，缺省 `~/.sid-code/state/upload-watermarks.json`（测试注入用） */
  statePath?: string;
  /** 「现在」，缺省为进程启动时刻向下取整到秒（测试注入用） */
  nowMs?: number;
}

function defaultStatePath(): string {
  return sidPaths.stateFile("upload-watermarks.json");
}

/** 进程启动时刻向下取整到秒：保证本进程生成的会话 id（秒级）不早于它 */
function processStartFloorMs(): number {
  return Math.floor(performance.timeOrigin / 1000) * 1000;
}

/**
 * 上传目标的规范化键：`origin + pathname`（去尾斜杠）。
 * 非法 URL 原样返回——宁可多一个奇怪的键，也不能把两个地址并成一个。
 */
export function uploadTargetKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url.trim();
  }
}

const ID_PREFIX = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/;

/** 读文件开头一段（不读整份：session.traj / events.jsonl 可能很大） */
function readHead(path: string, bytes = 8192): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf-8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* 忽略 */
      }
    }
  }
}

/**
 * 会话创建时间（ms）。取不到返回 null，调用方按「水位前」处理。
 *
 * ⚠️ 刻意不用 statSync(dir).mtimeMs / birthtime：mtime 会被 resume 刷新；
 * birthtime 在部分文件系统上不可靠，且目录被 `Bun.write` 重建时会变新。
 */
export function sessionCreatedAtMs(sessionId: string, sessionDir: string): number | null {
  const m = ID_PREFIX.exec(sessionId);
  if (m) {
    const [, y, mo, d, h, mi, s] = m.map(Number) as number[];
    // 与 generateSessionId 一致：本地时区
    const ms = new Date(y!, mo! - 1, d!, h!, mi!, s!).getTime();
    if (!Number.isNaN(ms)) return ms;
  }
  // 旧格式 id（UUID / 8 位 hex）：events.jsonl 首行是 SessionStart，带 timestamp
  const ev = readHead(join(sessionDir, "events.jsonl"), 4096);
  if (ev) {
    const first = ev.split("\n", 1)[0];
    try {
      const ts = (JSON.parse(first ?? "") as { timestamp?: unknown }).timestamp;
      if (typeof ts === "string") {
        const ms = new Date(ts).getTime();
        if (!Number.isNaN(ms)) return ms;
      }
    } catch {
      /* 首行可能被截断，继续回落 */
    }
  }
  const traj = readHead(join(sessionDir, "session.traj"));
  if (traj) {
    const st = /"start_time"\s*:\s*"([^"]+)"/.exec(traj);
    if (st) {
      const ms = new Date(st[1]!).getTime();
      if (!Number.isNaN(ms)) return ms;
    }
  }
  return null;
}

function readState(path: string): WatermarkState | null {
  try {
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf-8")) as Partial<WatermarkState>;
    if (!data || typeof data !== "object" || typeof data.targets !== "object" || !data.targets) {
      return null;
    }
    return {
      version: typeof data.version === "number" ? data.version : STATE_VERSION,
      baseline_at: typeof data.baseline_at === "string" ? data.baseline_at : "",
      targets: Object.fromEntries(
        Object.entries(data.targets).filter(([, v]) => typeof v === "string"),
      ) as Record<string, string>,
    };
  } catch {
    return null;
  }
}

function writeState(path: string, state: WatermarkState): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
}

/** 迁移用：该目录下最早一个未上传会话的创建时间；没有则 null */
function earliestUnuploadedCreatedMs(outputDir: string): number | null {
  const sessionsDir = join(outputDir, "sessions");
  let earliest: number | null = null;
  try {
    if (!existsSync(sessionsDir)) return null;
    for (const e of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const dir = join(sessionsDir, e.name);
      // S11：与补传同口径，只认终态标记（中途快照 final:false 仍算未上传）
      if (hasFinalUploadMarker(dir)) continue;
      const ms = sessionCreatedAtMs(e.name, dir);
      if (ms !== null && (earliest === null || ms < earliest)) earliest = ms;
    }
  } catch {
    /* 扫描失败按「无积压」处理：水位落在现在，方向是少传 */
  }
  return earliest;
}

/**
 * 启动时调用一次（cli 入口，loadConfig 之后，**不论是否配置了上传**）。
 *
 * - 状态文件不存在（升级后首次启动）：写入基线；若此刻已配置上传，该目标的水位取
 *   最早未上传会话的创建时间（迁移：积压不丢）。
 * - 状态文件存在：若此刻配置的上传目标还没有水位，记为「现在」。
 *
 * best-effort：任何异常只记日志，不抛。读水位时状态仍缺失会按同一规则补建。
 */
export function ensureUploadWatermarks(
  uploadUrl: string | undefined,
  opts: WatermarkOptions,
): void {
  try {
    resolveWatermark(uploadUrl, opts);
  } catch (err) {
    getLogger().warn("TRACE", `补传水位初始化失败（不影响启动）: ${err}`);
  }
}

/**
 * 取某个上传目标的补传水位（ms）：只有创建时间 ≥ 水位的会话才会被自动补传。
 * 目标首次出现时记为「现在」并落盘。
 */
export function getUploadWatermark(uploadUrl: string, opts: WatermarkOptions): number {
  return resolveWatermark(uploadUrl, opts) ?? opts.nowMs ?? processStartFloorMs();
}

function resolveWatermark(uploadUrl: string | undefined, opts: WatermarkOptions): number | null {
  const path = opts.statePath ?? defaultStatePath();
  const nowMs = opts.nowMs ?? processStartFloorMs();
  const key = uploadUrl ? uploadTargetKey(uploadUrl) : null;

  let state = readState(path);
  let dirty = false;
  if (!state) {
    // 升级后首次启动（或状态文件损坏）：已配置的目标沿用现状语义，积压照常补传
    state = { version: STATE_VERSION, baseline_at: new Date(nowMs).toISOString(), targets: {} };
    if (key) {
      const earliest = earliestUnuploadedCreatedMs(opts.outputDir);
      state.targets[key] = new Date(
        earliest !== null ? Math.min(earliest, nowMs) : nowMs,
      ).toISOString();
    }
    dirty = true;
  } else if (key && !state.targets[key]) {
    // 升级之后才出现的上传目标：只传「从现在起」产生的会话
    state.targets[key] = new Date(nowMs).toISOString();
    dirty = true;
    getLogger().info(
      "TRACE",
      `新的轨迹上传目标 ${key}：只自动上传此后产生的会话（更早的需 --upload-traces --include-history）`,
    );
  }
  if (dirty) writeState(path, state);

  if (!key) return null;
  const ms = new Date(state.targets[key]!).getTime();
  return Number.isNaN(ms) ? nowMs : ms;
}
