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
 * upsert 一行会话汇总（按 sessionId 去重，latest-wins）——支持**每轮增量落盘**。
 *
 * 背景（缺陷修复）：账本此前只在 SessionEnd（退出路径）落一行。但交互式会话做完一轮仍停在 REPL
 * 不退出 → SessionEnd 不触发 → 该会话在跨会话聚合（/cache）里长期计 $0，直到用户手动退出。
 * 解法：每轮 done 后就把「本会话累计用量」写进账本。
 *
 * 为什么必须 upsert 而非 append：aggregateEntries 对每行 costUSD 累加、sessions += 1。若每轮裸
 * append，一个 30 轮的会话会写 30 行 → 成本翻 30 倍、会话数翻 30 倍。upsert 保证「每会话恒一行」
 * （costUSD 是会话累计值，最新一次写入最完整），既支持增量可见、又不破坏聚合口径。
 *
 * 实现：读全量（跳过损坏行）→ 剔除同 sessionId 旧行 → 追加新行 → 整体重写。ledger 体积可控
 * （prune 保证），重写为 best-effort、off-hot-path、失败静默忽略。
 */
export function upsertUsageLedger(entry: UsageLedgerEntry): void {
  try {
    const path = ledgerPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const existing = readUsageLedger().filter((e) => e.sessionId !== entry.sessionId);
    existing.push(entry);
    writeFileSync(path, existing.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
  } catch {
    // 写盘失败静默忽略（绝不阻断主流程）
  }
}

/**
 * 按 sessionId 去重，保留每个会话**最后出现**的那一行（latest-wins），保持原有顺序。
 *
 * 防御用途：upsertUsageLedger 已保证新写入每会话恒一行，但历史账本里可能残留 append 时代的
 * 多行（同一会话被增量 append 过），或 upsert 前的旧数据。聚合器读侧先过这道去重，杜绝
 * 「同一会话被累加多次」导致成本/会话数虚高。无重复时是恒等变换，零副作用。
 */
export function dedupeBySession(entries: UsageLedgerEntry[]): UsageLedgerEntry[] {
  const lastIdx = new Map<string, number>();
  entries.forEach((e, i) => lastIdx.set(e.sessionId, i));
  return entries.filter((e, i) => lastIdx.get(e.sessionId) === i);
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
