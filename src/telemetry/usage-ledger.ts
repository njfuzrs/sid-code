/**
 * 用量账本（usage-ledger）——缓存命中长期统计的自包含底座（方案模块 C1）。
 *
 * 设计契约（与 OTel 导出管道分流，"同源双汇"）：
 * - **append-only**：每会话 SessionEnd 落**一行**汇总，体积可控（1 万会话 ≈ 几 MB）。
 * - **默认开、不轮转、人类可读**：与 metrics.jsonl（默认关 + 50MB 轮转 + 不可读回）互补；
 *   也不受 trajectories LRU（默认留 100 会话）影响——专供跨会话聚合。
 * - **只存聚合数字（token 数 / 成本），绝不存任何消息内容**——隐私安全。
 *
 * 存储位置：~/.sid-code/usage-ledger.jsonl（可经 SID_CODE_USAGE_LEDGER 环境变量重定向，测试隔离用）。
 *
 * 读写均容错：文件不存在 / 损坏行直接跳过，不抛错——绝不阻断 SessionEnd 退出热路径。
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sidPaths } from "../config/paths.ts";

/** 单会话用量账本行（每会话一行汇总） */
export interface UsageLedgerEntry {
  /** 会话结束时间戳（秒，Unix epoch） */
  ts: number;
  sessionId: string;
  model: string;
  provider: string;
  /** 完整输入 = hit + write + uncached（归一化三段总和） */
  promptTotal: number;
  /** 命中（读缓存）token 数 */
  cacheHit: number;
  /** 写入缓存 token 数（DeepSeek 恒 0） */
  cacheWrite: number;
  /** 未命中（全价）输入 token 数 */
  uncachedInput: number;
  /** 输出 token 数 */
  output: number;
  /** 本会话总成本（美元） */
  costUSD: number;
  /** 本会话缓存节省（美元） */
  savingsUSD: number;
  /** 会话时长（毫秒） */
  durationMs: number;
}

/** 账本文件路径（测试可经环境变量重定向） */
export function ledgerPath(): string {
  const override = process.env.SID_CODE_USAGE_LEDGER;
  if (override && override.trim() !== "") return override;
  return sidPaths.usageLedger();
}

/**
 * 追加一行会话汇总到账本（append-only）。
 * 失败静默忽略（不阻断 SessionEnd 退出）。
 */
export function appendUsageLedger(entry: UsageLedgerEntry): void {
  try {
    const path = ledgerPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // 写盘失败静默忽略
  }
}

/**
 * 读取账本全部行（损坏行跳过）。
 * @param maxEntries 可选：只返回最近 N 行（从尾部取，避免大文件全量解析）
 */
export function readUsageLedger(maxEntries?: number): UsageLedgerEntry[] {
  try {
    const path = ledgerPath();
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, "utf-8");
    let lines = raw.split("\n").filter((l) => l.trim() !== "");
    if (maxEntries !== undefined && lines.length > maxEntries) {
      lines = lines.slice(lines.length - maxEntries);
    }
    const result: UsageLedgerEntry[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object" && typeof parsed.ts === "number") {
          result.push(parsed as UsageLedgerEntry);
        }
      } catch {
        // 跳过损坏行
      }
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * 裁剪账本：只保留最近 maxSessions 行（滚动裁剪，控制体积）。
 * 返回裁剪后剩余行数；失败返回 -1。
 */
export function pruneUsageLedger(maxSessions: number): number {
  try {
    const entries = readUsageLedger();
    if (entries.length <= maxSessions) return entries.length;
    const kept = entries.slice(entries.length - maxSessions);
    const path = ledgerPath();
    writeFileSync(path, kept.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    return kept.length;
  } catch {
    return -1;
  }
}
