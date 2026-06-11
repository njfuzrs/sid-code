/**
 * 用量聚合器（usage-aggregator）——读账本，按周期键聚合命中率 / 成本 / 省钱（方案模块 C2）。
 *
 * periodKey 自写（不复用 budget-tracker.ts 的 getPeriodKey——后者签名是 getPeriodKey(rule)、
 * weekly 返回 `w{epoch周数}` 而非 ISO `2026-W24`，不可直接复用）。
 * 复用 claude-code 的"per-model map 派生总量"模式：总量由 byModel 求和派生。
 */

import type { UsageLedgerEntry } from "./usage-ledger.ts";
import { readUsageLedger } from "./usage-ledger.ts";

/** 聚合粒度 */
export type Granularity = "day" | "week" | "month";

/** 单模型聚合统计 */
export interface ModelCacheStats {
  promptTotal: number;
  cacheHit: number;
  cacheWrite: number;
  uncachedInput: number;
  output: number;
  costUSD: number;
  savingsUSD: number;
  sessions: number;
}

/** 单周期聚合输出 */
export interface PeriodCacheStats {
  /** "2026-06-11" / "2026-W24" / "2026-06" */
  period: string;
  byModel: Record<string, ModelCacheStats>;
  /** 加权命中率 = Σhit / ΣpromptTotal（0~1） */
  totalHitRate: number;
  /** 累计省钱（美元） */
  totalSavingsUSD: number;
  /** 累计成本（美元） */
  totalCostUSD: number;
  /** 周期内会话数 */
  totalSessions: number;
}

/**
 * 计算周期键（自写，对齐 ISO 习惯）。
 * @param tsSeconds Unix epoch 秒
 * @param granularity day / week / month
 *
 * - day   → "YYYY-MM-DD"
 * - week  → "YYYY-Www"（ISO 8601 周数，周一为周首）
 * - month → "YYYY-MM"
 */
export function periodKey(tsSeconds: number, granularity: Granularity): string {
  const d = new Date(tsSeconds * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");

  if (granularity === "month") return `${y}-${pad(m)}`;
  if (granularity === "day") return `${y}-${pad(m)}-${pad(day)}`;

  // week：ISO 8601 周数
  const { isoYear, isoWeek } = isoWeekNumber(d);
  return `${isoYear}-W${pad(isoWeek)}`;
}

/**
 * ISO 8601 周数计算（周一为周首，第 1 周含当年第一个周四）。
 * 返回 { isoYear, isoWeek }——跨年周可能属于上一年/下一年。
 */
function isoWeekNumber(date: Date): { isoYear: number; isoWeek: number } {
  // 复制并归一到 UTC 当天
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // ISO：周四决定归属年。getUTCDay() 周日=0，转为周一=0 体系
  const dayNum = (d.getUTCDay() + 6) % 7; // 周一=0 ... 周日=6
  // 移到本周周四
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const isoYear = d.getUTCFullYear();
  // 当年第一个周四
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const isoWeek =
    1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return { isoYear, isoWeek };
}

/** 空模型统计 */
function emptyModelStats(): ModelCacheStats {
  return {
    promptTotal: 0, cacheHit: 0, cacheWrite: 0, uncachedInput: 0,
    output: 0, costUSD: 0, savingsUSD: 0, sessions: 0,
  };
}

/**
 * 把一组账本行聚合成单个 PeriodCacheStats（不分周期，调用方自行筛选）。
 */
export function aggregateEntries(entries: UsageLedgerEntry[], period: string): PeriodCacheStats {
  const byModel: Record<string, ModelCacheStats> = {};
  let totalHit = 0;
  let totalPrompt = 0;
  let totalSavings = 0;
  let totalCost = 0;

  for (const e of entries) {
    if (!byModel[e.model]) byModel[e.model] = emptyModelStats();
    const m = byModel[e.model];
    m.promptTotal += e.promptTotal;
    m.cacheHit += e.cacheHit;
    m.cacheWrite += e.cacheWrite;
    m.uncachedInput += e.uncachedInput;
    m.output += e.output;
    m.costUSD += e.costUSD;
    m.savingsUSD += e.savingsUSD;
    m.sessions += 1;

    totalHit += e.cacheHit;
    totalPrompt += e.promptTotal;
    totalSavings += e.savingsUSD;
    totalCost += e.costUSD;
  }

  return {
    period,
    byModel,
    totalHitRate: totalPrompt > 0 ? totalHit / totalPrompt : 0,
    totalSavingsUSD: totalSavings,
    totalCostUSD: totalCost,
    totalSessions: entries.length,
  };
}

/** 聚合选项 */
export interface AggregateOptions {
  granularity?: Granularity;
  /** 只统计该模型（精确或前缀匹配） */
  model?: string;
  /** 只统计最近 N 天（按 ts 过滤） */
  sinceDays?: number;
  /** 当前时间戳（秒），便于测试注入；默认 Date.now()/1000 */
  nowSeconds?: number;
  /** 只读账本最近 N 行（大文件优化） */
  maxEntries?: number;
}

/**
 * 从账本聚合：返回按周期键分组的 PeriodCacheStats（按周期升序）。
 */
export function aggregateUsage(opts: AggregateOptions = {}): PeriodCacheStats[] {
  const granularity = opts.granularity ?? "day";
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  let entries = readUsageLedger(opts.maxEntries);

  // 模型过滤（精确或前缀）
  if (opts.model) {
    const q = opts.model;
    entries = entries.filter((e) => e.model === q || e.model.startsWith(q) || q.startsWith(e.model));
  }

  // 时间窗过滤
  if (opts.sinceDays !== undefined) {
    const cutoff = now - opts.sinceDays * 24 * 60 * 60;
    entries = entries.filter((e) => e.ts >= cutoff);
  }

  // 按周期键分组
  const groups = new Map<string, UsageLedgerEntry[]>();
  for (const e of entries) {
    const key = periodKey(e.ts, granularity);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }

  const result: PeriodCacheStats[] = [];
  for (const [key, group] of groups) {
    result.push(aggregateEntries(group, key));
  }
  // 按周期键升序
  result.sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));
  return result;
}

/**
 * 跨周期合并为单个总览（供 /cache 顶部"总命中率/累计省钱"行）。
 */
export function aggregateOverall(opts: AggregateOptions = {}): PeriodCacheStats {
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  let entries = readUsageLedger(opts.maxEntries);
  if (opts.model) {
    const q = opts.model;
    entries = entries.filter((e) => e.model === q || e.model.startsWith(q) || q.startsWith(e.model));
  }
  if (opts.sinceDays !== undefined) {
    const cutoff = now - opts.sinceDays * 24 * 60 * 60;
    entries = entries.filter((e) => e.ts >= cutoff);
  }
  return aggregateEntries(entries, "overall");
}
