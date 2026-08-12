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

import {
  existsSync,
  appendFileSync,
  mkdirSync,
  statSync,
  renameSync,
  unlinkSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { dirname } from "node:path";
import { sidPaths } from "../config/paths.ts";
import type { CacheBreakRecord, CacheBreakCategory } from "../api/cache-detection.ts";

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
  /**
   * P0-2：结构化归因类别，与 changes 一一对应。**聚合统计的唯一合法判据。**
   * 旧数据（2026-08-08 之前）无此字段 → 聚合时回退到 changes 文案匹配。
   */
  categories?: CacheBreakCategory[];
  previousCacheReadTokens: number;
  currentCacheReadTokens: number;
  /**
   * P0-2：前缀 hash 判据。检测器早就算出来了（cache-detection.ts 的 combinePrefixHash），
   * 但落盘时被手写字段拷贝列表丢掉 —— 实测 676 条历史记录里带此字段的是 **0 条**，
   * 导致"服务端波动占 99.5%"这个结论只能靠对中文文案 grep 得出。
   */
  previousPrefixHash?: string;
  currentPrefixHash?: string;
  /** P1-2：本轮响应前是否发生过重试（分离重试触发脱落 vs 纯服务端波动）。旧数据无此字段。 */
  precededByRetry?: boolean;
}

/**
 * 落盘时**显式剔除**的键（P0-3）。
 *
 * 落盘策略从"手写白名单拷贝"改为"默认透传 + 显式剔除"：
 * 手写白名单的失败模式是**静默丢字段** —— 新增一个诊断字段、忘了加进拷贝列表，
 * 代码照跑、测试照绿，只是数据永久缺失（`previousPrefixHash` 就这样丢了 676 条）。
 * 同病见记忆 `message-fidelity-silent-block-drop`：手写字段列表与手写分派链同病，
 * 根治都是"默认透传 + 兜底告警"。
 *
 * 当前为空：`CacheBreakRecord` 的所有字段都是聚合归因，不含消息内容，全部可落盘。
 * 将来若新增**含用户内容**的字段（例如 diff 片段），必须加进这里 ——
 * 本文件的隐私契约是"只存聚合归因，绝不存消息内容"。
 */
const EXCLUDED_KEYS = new Set<string>([]);

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
    const entry = buildTelemetryEntry(record);
    const path = cacheBreaksPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
    rotateIfOversized(path);
  } catch {
    // 写盘失败静默忽略
  }
}

/**
 * 把检测器产出的 record 转成落盘行：**默认透传所有键**，只剔除 {@link EXCLUDED_KEYS}。
 *
 * 导出是为了让门禁测试能直接断言"record 的键集合 − 剔除集合 ⊆ 落盘 entry 的键集合"，
 * 而不必去解析文件（见 tests/telemetry/cache-break-telemetry-fidelity.test.ts）。
 *
 * 显式 undefined 的键会被剔掉：`JSON.stringify` 本就会丢它们，但留在对象里会让
 * "键存在 / 值为 undefined" 这两种状态在门禁断言里混淆（同病见记忆
 * `explicit-undefined-punches-through-defaults`：门禁要断言"键不存在"而非"值 undefined"）。
 */
export function buildTelemetryEntry(record: CacheBreakRecord): CacheBreakTelemetryEntry {
  const entry: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (EXCLUDED_KEYS.has(key)) continue;
    if (value === undefined) continue;
    entry[key] = value;
  }
  return entry as unknown as CacheBreakTelemetryEntry;
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
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
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
export function summarizeCacheBreakHistory(limit = 500): {
  total: number;
  byCategory: Record<string, number>;
  structuredCount: number;
  legacyCount: number;
} {
  const entries = queryCacheBreakHistory(limit);
  const byCategory: Record<string, number> = {};
  let structuredCount = 0;
  let legacyCount = 0;
  const bump = (k: string) => {
    byCategory[k] = (byCategory[k] ?? 0) + 1;
  };
  for (const e of entries) {
    // P0-2：优先读结构化 categories。文案匹配只是**旧数据兼容路径**，
    // 不是主判据 —— 新记录一律走上面这条，改文案不会再让统计断裂。
    if (e.categories && e.categories.length > 0) {
      structuredCount++;
      for (const c of e.categories) bump(c);
      continue;
    }
    legacyCount++;
    for (const change of e.changes) {
      if (change.includes("模型变化")) bump("model");
      else if (change.includes("System prompt")) bump("system_prompt");
      else if (change.includes("工具顺序")) bump("tool_order");
      else if (change.includes("工具变化")) bump("tools");
      else if (change.includes("缓存策略")) bump("cache_policy");
      else if (change.includes("Beta headers")) bump("beta_headers");
      else if (change.includes("消息数量骤减")) bump("compact");
      else if (change.includes("TTL")) bump("ttl_expiry");
      // P2-1 的两类前缀 hash 归因（cache-detection.ts:264-268）此前无对应分支，
      // 全部落进 unknown —— 实测真实数据 500 条里 499 条如此，聚合等于失效。
      // 这两类恰恰是最有价值的区分：服务端波动本地不可控，前缀断裂才是能优化的。
      else if (change.includes("服务端缓存波动")) bump("server_fluctuation");
      else if (change.includes("本地前缀 hash 变化")) bump("prefix_break");
      else bump("unknown");
    }
  }
  return { total: entries.length, byCategory, structuredCount, legacyCount };
}
