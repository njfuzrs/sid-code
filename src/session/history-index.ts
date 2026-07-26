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

import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
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

/** 内存保留上限（读取时截断，避免超大文件全量入内存） */
const MAX_IN_MEMORY = 500;

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
  }
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
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const entries: HistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t);
      if (rec && typeof rec.display === "string") {
        entries.push({
          display: rec.display,
          pastedContents: Array.isArray(rec.pastedContents) ? rec.pastedContents : [],
          timestamp: typeof rec.timestamp === "string" ? rec.timestamp : "",
          project: typeof rec.project === "string" ? rec.project : "",
          sessionId: typeof rec.sessionId === "string" ? rec.sessionId : "",
        });
      }
    } catch {
      /* 跳过坏行 */
    }
  }
  const filtered = opts?.project ? entries.filter(e => e.project === opts.project) : entries;
  // 文件是"最旧在前"追加序；调用方要"最新在前"，反转后截断。
  const reversed = filtered.reverse();
  const limit = opts?.limit ?? MAX_IN_MEMORY;
  return reversed.slice(0, limit);
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
      .map(display =>
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
    getLogger().info("HISTORY", `已迁移 ${legacyStrings.length} 条旧 input-history 到 history.jsonl`);
  } catch (e) {
    getLogger().warn("HISTORY", `迁移旧 input-history 失败（不阻断）: ${(e as Error)?.message}`);
  }
}
