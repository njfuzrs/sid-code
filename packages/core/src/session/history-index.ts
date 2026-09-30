/**
 * 全局输入历史索引（P2-G8，对齐 claude-code `~/.claude/history.jsonl`）。
 *
 * 每次用户提交输入追加一行 JSON：`{display, pastedContents, timestamp, project, sessionId}`。
 * 与旧的 `input-history.json`（纯字符串数组、无元数据、按进程覆写）相比：
 *   - JSONL 追加写：崩溃安全、跨会话/跨项目累积，不会被后一个进程整体覆盖。
 *   - 带 project/sessionId：`Ctrl+R` 反向搜索与 ↑/↓ 历史可跨会话检索并保留来源信息。
 *
 * 权威源迁移：history.jsonl 为权威源；首次读取时若发现旧 input-history.json 且索引为空，
 * 自动迁移（见 migrateLegacyInputHistory）。旧文件保留不删，避免误伤，但不再写入。
 */

import {
  appendFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
  statSync,
  renameSync,
} from "fs";
import { getSidHome, sidHomePath } from "../config/paths.ts";
import { getLogger } from "../debug/logger.ts";

/** history.jsonl 每行的记录结构（对齐 CC 字段名） */
export interface HistoryEntry {
  /** 展示文本（用户输入的还原后真实内容） */
  display: string;
  /** 粘贴内容引用（占位符 → 原文的映射摘要）；无则空数组 */
  pastedContents: Array<{ id: number; type: string; preview?: string }>;
  /** ISO 时间戳 */
  timestamp: string;
  /** 所属项目根目录（跨项目检索用） */
  project: string;
  /** 所属会话 id（跨会话溯源用）；未知为 "" */
  sessionId: string;
}

/** 默认返回上限（UI 只要最近这么多条）。 */
const MAX_IN_MEMORY = 500;

// N14：history.jsonl 以前只追加、永不轮转，且每次启动 readFileSync + 全量 JSON.parse
// 之后才截断到 500 条 —— 截断只省了返回值，峰值内存与解析开销随文件单调增长。
// 现在两道：① 读取从文件尾按块倒读，攒够 limit 条就停；② 追加后超阈值即轮转。
// 历史索引不是审计日志（每行独立、无 parentUuid 链），丢掉很老的输入没有代价。

/** 倒读块大小。 */
const TAIL_CHUNK_BYTES = 64 * 1024;
/** 超过这个体积就轮转（本机实测 789 行 661KB，单行 max 48.6KB）。 */
const ROTATE_THRESHOLD_BYTES = 8 * 1024 * 1024;
/** 轮转后最多保留的行数。 */
const ROTATE_KEEP_LINES = 5000;
/** 轮转后最多保留的字节（取阈值一半：大行多时按字节先到顶，避免保留量本身又超阈值、每次追加都轮转）。 */
const ROTATE_KEEP_BYTES = ROTATE_THRESHOLD_BYTES / 2;

const HISTORY_JSONL = (): string => sidHomePath("history.jsonl");
const LEGACY_INPUT_HISTORY = (): string => sidHomePath("input-history.json");

/**
 * 追加一条历史记录（崩溃安全的单行追加）。写入失败静默吞（历史索引非关键路径）。
 */
export function appendHistoryEntry(entry: HistoryEntry): void {
  try {
    mkdirSync(getSidHome(), { recursive: true });
    appendFileSync(HISTORY_JSONL(), JSON.stringify(entry) + "\n", "utf-8");
  } catch (e) {
    getLogger().warn("HISTORY", `history.jsonl 追加失败（不阻断）: ${(e as Error)?.message}`);
    return;
  }
  rotateHistoryIfNeeded();
}

/**
 * 超阈值时把 history.jsonl 截到最近 ROTATE_KEEP_LINES 行 / ROTATE_KEEP_BYTES 字节
 * （先到者为准），tmp + rename 原子替换。失败静默（历史索引非关键路径）。
 *
 * 已知取舍：别的进程恰在「读尾部 → rename」这几毫秒内追加的那一行会丢。
 * 触发频率是「每长到 8MB 一次」，丢的是一条输入历史，不值得为它上跨进程锁。
 *
 * @returns 是否发生了轮转（测试用）
 */
export function rotateHistoryIfNeeded(opts?: {
  thresholdBytes?: number;
  keepLines?: number;
  keepBytes?: number;
}): boolean {
  const path = HISTORY_JSONL();
  const threshold = opts?.thresholdBytes ?? ROTATE_THRESHOLD_BYTES;
  try {
    if (!existsSync(path) || statSync(path).size <= threshold) return false;
    const keepLines = opts?.keepLines ?? ROTATE_KEEP_LINES;
    const keepBytes = opts?.keepBytes ?? ROTATE_KEEP_BYTES;
    const kept: string[] = [];
    let bytes = 0;
    readLinesFromTail(path, (line) => {
      const len = Buffer.byteLength(line, "utf-8") + 1;
      // 至少保留最新一行，哪怕它自己就超 keepBytes
      if (kept.length > 0 && bytes + len > keepBytes) return false;
      kept.push(line);
      bytes += len;
      return kept.length < keepLines;
    });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, kept.reverse().join("\n") + (kept.length > 0 ? "\n" : ""), "utf-8");
    renameSync(tmp, path);
    getLogger().info("HISTORY", `history.jsonl 已轮转：保留最近 ${kept.length} 行（${bytes}B）`);
    return true;
  } catch (e) {
    getLogger().warn("HISTORY", `history.jsonl 轮转失败（不阻断）: ${(e as Error)?.message}`);
    return false;
  }
}

/**
 * 从文件尾按块倒读，逐行（最新在前）回调；回调返回 false 即停止，不再读更早的块。
 * 按字节 0x0a 切行：UTF-8 里多字节字符的续字节不会是 0x0a，所以块边界不会切坏字符。
 * 空行跳过。最后一行没有换行符（崩溃半行）也照常回调，由调用方的 JSON.parse 容错。
 */
function readLinesFromTail(path: string, onLine: (line: string) => boolean): void {
  const fd = openSync(path, "r");
  try {
    let pos = fstatSync(fd).size;
    let carry = Buffer.alloc(0); // 当前块之后、尚未遇到行首的残段
    while (pos > 0) {
      const len = Math.min(TAIL_CHUNK_BYTES, pos);
      pos -= len;
      const chunk = Buffer.allocUnsafe(len);
      readSync(fd, chunk, 0, len, pos);
      const buf = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
      let end = buf.length;
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i] !== 0x0a) continue;
        if (end > i + 1 && !emit(buf, i + 1, end, onLine)) return;
        end = i;
      }
      // buf[0, end) 是一行的后半截，行首还在更早的块里
      carry = buf.subarray(0, end);
    }
    if (carry.length > 0) emit(carry, 0, carry.length, onLine);
  } finally {
    closeSync(fd);
  }
}

function emit(buf: Buffer, start: number, end: number, onLine: (line: string) => boolean): boolean {
  const line = buf.toString("utf-8", start, end).trim();
  return line ? onLine(line) : true;
}

function parseHistoryLine(line: string): HistoryEntry | null {
  try {
    const rec = JSON.parse(line);
    if (rec && typeof rec.display === "string") {
      return {
        display: rec.display,
        pastedContents: Array.isArray(rec.pastedContents) ? rec.pastedContents : [],
        timestamp: typeof rec.timestamp === "string" ? rec.timestamp : "",
        project: typeof rec.project === "string" ? rec.project : "",
        sessionId: typeof rec.sessionId === "string" ? rec.sessionId : "",
      };
    }
  } catch {
    /* 跳过坏行 */
  }
  return null;
}

/**
 * 读取历史记录（最新在前）。可选按 project 过滤。
 * 解析容错：跳过坏行，不因单行损坏丢整个历史。
 *
 * @param opts.project 仅返回该项目的记录（不传返回全部）
 * @param opts.limit 返回上限（默认 MAX_IN_MEMORY）
 */
export function readHistoryEntries(opts?: { project?: string; limit?: number }): HistoryEntry[] {
  const path = HISTORY_JSONL();
  if (!existsSync(path)) {
    // 权威源不存在 → 尝试从旧 input-history.json 迁移一次
    migrateLegacyInputHistory();
    if (!existsSync(path)) return [];
  }
  const limit = opts?.limit ?? MAX_IN_MEMORY;
  const entries: HistoryEntry[] = [];
  if (limit <= 0) return entries;
  try {
    // 文件是「最旧在前」追加序，倒读天然得到「最新在前」；攒够 limit 条即停，不碰更早的块。
    readLinesFromTail(path, (line) => {
      const e = parseHistoryLine(line);
      if (e && (!opts?.project || e.project === opts.project)) entries.push(e);
      return entries.length < limit;
    });
  } catch {
    return [];
  }
  return entries;
}

/**
 * 读取历史的纯 display 字符串数组（最新在前，去重保序）。
 * 供 useInputHistoryStore / useReverseSearch 这类只认字符串列表的现有消费方直接替换数据源。
 */
export function readHistoryDisplays(opts?: { project?: string; limit?: number }): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of readHistoryEntries(opts)) {
    if (seen.has(e.display)) continue;
    seen.add(e.display);
    out.push(e.display);
  }
  return out;
}

/**
 * 一次性迁移旧 input-history.json（纯字符串数组）到 history.jsonl。
 * 仅在 history.jsonl 不存在且旧文件存在时执行；迁移记录不带 project/sessionId（旧数据无此信息）。
 * 幂等：迁移后 history.jsonl 存在，后续调用直接跳过。旧文件不删除。
 */
export function migrateLegacyInputHistory(): void {
  const jsonlPath = HISTORY_JSONL();
  const legacyPath = LEGACY_INPUT_HISTORY();
  if (existsSync(jsonlPath) || !existsSync(legacyPath)) return;
  try {
    const parsed = JSON.parse(readFileSync(legacyPath, "utf-8"));
    if (!Array.isArray(parsed)) return;
    // input-history.json 是"最新在前"，写 jsonl 要"最旧在前"，故反转。
    const legacyStrings = parsed.filter((s): s is string => typeof s === "string").reverse();
    if (legacyStrings.length === 0) return;
    mkdirSync(getSidHome(), { recursive: true });
    const lines = legacyStrings
      .map((display) =>
        JSON.stringify({
          display,
          pastedContents: [],
          timestamp: "",
          project: "",
          sessionId: "",
        } satisfies HistoryEntry),
      )
      .join("\n");
    writeFileSync(jsonlPath, lines + "\n", "utf-8");
    getLogger().info(
      "HISTORY",
      `已迁移 ${legacyStrings.length} 条旧 input-history 到 history.jsonl`,
    );
  } catch (e) {
    getLogger().warn("HISTORY", `迁移旧 input-history 失败（不阻断）: ${(e as Error)?.message}`);
  }
}
