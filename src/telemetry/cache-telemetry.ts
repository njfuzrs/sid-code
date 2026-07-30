/**
 * 缓存中断遥测持久化（G13）。
 *
 * 把 CacheBreakDetector 检测到的缓存中断落盘为 append-only JSONL，跨会话留存，
 * 供 `/cache --history` 查询缓存健康度趋势（哪类中断最频繁、是否在恶化）。
 *
 * 设计契约（对齐 usage-ledger 的"同源双汇"理念）：
 * - **append-only + 大小轮转**：每条中断落一行，超 10MB 滚动为 .1（保留 1 份历史）。
 *   注：原实现只有 append 没有轮转，"体积可控"是空承诺——缓存中断是核心度量对象、
 *   正常使用中持续高频增长，实测本机已 8.5MB / 51615 行且无收敛。轮转实现照搬
 *   src/permission/audit.ts 的既有范式。
 * - **只存聚合归因**（drop tokens / percent / changes 文本），绝不存消息内容——隐私安全。
 * - 读写均容错：文件不存在 / 损坏行跳过，绝不抛错阻断主流程。
 *
 * 存储位置：~/.sid-code/cache-breaks.jsonl（可经 SID_CODE_CACHE_BREAKS 环境变量重定向，测试隔离用）。
 */

import { existsSync, appendFileSync, mkdirSync, statSync, renameSync, unlinkSync, openSync, readSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { sidPaths } from "../config/paths.ts";
import type { CacheBreakRecord } from "../api/cache-detection.ts";

/** 落盘的单条中断遥测行 */
export interface CacheBreakTelemetryEntry {
  /** 中断检测时间戳（秒，Unix epoch） */
  ts: number;
  model: string;
  /** 命中下降的 token 数 */
  dropTokens: number;
  /** 下降百分比（整数 0-100） */
  dropPercent: number;
  /** 归因列表（人类可读） */
  changes: string[];
  previousCacheReadTokens: number;
  currentCacheReadTokens: number;
  /** P1-2：本轮响应前是否发生过重试（分离重试触发脱落 vs 纯服务端波动）。旧数据无此字段。 */
  precededByRetry?: boolean;
}

/** 遥测文件路径（测试可经环境变量重定向） */
export function cacheBreaksPath(): string {
  const override = process.env.SID_CODE_CACHE_BREAKS;
  if (override && override.trim() !== "") return override;
  return sidPaths.cacheBreaks();
}

/**
 * 追加一条缓存中断遥测（append-only）。失败静默忽略（绝不阻断主循环）。
 */
export function emitCacheBreakTelemetry(record: CacheBreakRecord): void {
  try {
    const entry: CacheBreakTelemetryEntry = {
      ts: record.ts,
      model: record.model,
      dropTokens: record.dropTokens,
      dropPercent: record.dropPercent,
      changes: record.changes,
      previousCacheReadTokens: record.previousCacheReadTokens,
      currentCacheReadTokens: record.currentCacheReadTokens,
      precededByRetry: record.precededByRetry,
    };
    const path = cacheBreaksPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
    rotateIfOversized(path);
  } catch {
    // 写盘失败静默忽略
  }
}

/** 单文件大小上限（10MB），与 permission/audit.ts 对齐 */
const MAX_BYTES = 10 * 1024 * 1024;

/** 尾部读取窗口：够装下 limit 条 JSONL 且远小于全量（每条实测 ~170B，1MB 可容 ~6000 条） */
const TAIL_WINDOW_BYTES = 1024 * 1024;

/**
 * 从文件尾部读取最后 n 行（非空行），只读末尾 TAIL_WINDOW_BYTES 字节。
 *
 * 原实现是 readFileSync 整个文件 + split 后 slice(-n)——为拿 100 条读了 8.5MB、
 * RSS 涨 33MB。这里改为按 offset 只读尾部窗口，代价与文件总大小解耦。
 * 窗口内首行可能被截断（不是完整 JSON），故当窗口非文件开头时丢弃第一行。
 */
function readTailLines(path: string, n: number): string[] {
  if (n <= 0) return [];
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    if (size === 0) return [];
    const start = Math.max(0, size - TAIL_WINDOW_BYTES);
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    fd = openSync(path, "r");
    readSync(fd, buf, 0, length, start);
    let lines = buf.toString("utf-8").split("\n");
    // 窗口不是从文件开头切的 → 首行大概率被截断，丢弃
    if (start > 0) lines = lines.slice(1);
    const nonEmpty = lines.filter((l) => l.trim() !== "");
    return nonEmpty.length > n ? nonEmpty.slice(nonEmpty.length - n) : nonEmpty;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * 超过大小上限时轮转为 .1（只保留 1 份历史，磁盘占用封顶 ~20MB）。
 * 失败静默——轮转是维护性动作，绝不阻断遥测主流程。
 */
function rotateIfOversized(path: string): void {
  try {
    if (!existsSync(path) || statSync(path).size <= MAX_BYTES) return;
    const backup = `${path}.1`;
    if (existsSync(backup)) unlinkSync(backup);
    renameSync(path, backup);
  } catch {
    // 轮转失败静默忽略
  }
}

/**
 * 读取最近 N 条缓存中断历史（损坏行跳过，从尾部取）。
 *
 * 跨轮转读取：当前文件不足 limit 条时回补上一份 .1，避免刚轮转完
 * `/cache --history` 显示为空（轮转引入的新失败模式）。
 * @param limit 最多返回多少条（默认 100）
 */
export function queryCacheBreakHistory(limit = 100): CacheBreakTelemetryEntry[] {
  try {
    const path = cacheBreaksPath();
    // 注意：不能在此处对 path 做 existsSync 早退——轮转（renameSync）刚发生时当前文件
    // 尚不存在，而历史全在 .1 里，早退会让 /cache --history 直接失忆。
    // readTailLines 自身对不存在的文件返回 []，故两个 sink 都交给它判定。
    let tail = readTailLines(path, limit);
    // 当前文件不足 limit 条 → 回补上一份 .1 的尾部（轮转刚发生时当前文件几乎是空的）
    if (tail.length < limit && existsSync(`${path}.1`)) {
      const older = readTailLines(`${path}.1`, limit - tail.length);
      tail = older.concat(tail);
    }
    const out: CacheBreakTelemetryEntry[] = [];
    for (const line of tail) {
      try {
        out.push(JSON.parse(line) as CacheBreakTelemetryEntry);
      } catch {
        // 损坏行跳过
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 聚合历史中断按归因类型计数（供 /cache --history 展示哪类中断最频繁）。
 * 归因映射到稳定的类别键，便于跨条目聚合。
 */
export function summarizeCacheBreakHistory(
  limit = 500,
): { total: number; byCategory: Record<string, number> } {
  const entries = queryCacheBreakHistory(limit);
  const byCategory: Record<string, number> = {};
  const bump = (k: string) => {
    byCategory[k] = (byCategory[k] ?? 0) + 1;
  };
  for (const e of entries) {
    for (const change of e.changes) {
      if (change.includes("模型变化")) bump("model");
      else if (change.includes("System prompt")) bump("system_prompt");
      else if (change.includes("工具顺序")) bump("tool_order");
      else if (change.includes("工具变化")) bump("tools");
      else if (change.includes("缓存策略")) bump("cache_policy");
      else if (change.includes("Beta headers")) bump("beta_headers");
      else if (change.includes("消息数量骤减")) bump("compact");
      else if (change.includes("TTL")) bump("ttl_expiry");
      else bump("unknown");
    }
  }
  return { total: entries.length, byCategory };
}
