/**
 * 缓存中断遥测持久化（G13）。
 *
 * 把 CacheBreakDetector 检测到的缓存中断落盘为 append-only JSONL，跨会话留存，
 * 供 `/cache --history` 查询缓存健康度趋势（哪类中断最频繁、是否在恶化）。
 *
 * 设计契约（对齐 usage-ledger 的"同源双汇"理念）：
 * - **append-only**：每条中断落一行，体积可控。
 * - **只存聚合归因**（drop tokens / percent / changes 文本），绝不存消息内容——隐私安全。
 * - 读写均容错：文件不存在 / 损坏行跳过，绝不抛错阻断主流程。
 *
 * 存储位置：~/.sid-code/cache-breaks.jsonl（可经 SID_CODE_CACHE_BREAKS 环境变量重定向，测试隔离用）。
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
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
  } catch {
    // 写盘失败静默忽略
  }
}

/**
 * 读取最近 N 条缓存中断历史（损坏行跳过，从尾部取）。
 * @param limit 最多返回多少条（默认 100）
 */
export function queryCacheBreakHistory(limit = 100): CacheBreakTelemetryEntry[] {
  try {
    const path = cacheBreaksPath();
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    const tail = lines.length > limit ? lines.slice(lines.length - limit) : lines;
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
