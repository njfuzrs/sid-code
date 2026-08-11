/**
 * 用量聚合器（usage-aggregator）——读账本，按周期键聚合命中率 / 成本 / 省钱（方案模块 C2）。
 *
 * periodKey 自写（不复用 budget-tracker.ts 的 getPeriodKey——后者签名是 getPeriodKey(rule)、
 * weekly 返回 `w{epoch周数}` 而非 ISO `2026-W24`，不可直接复用）。
 * 复用 claude-code 的"per-model map 派生总量"模式：总量由 byModel 求和派生。
 */

import type { UsageLedgerEntry } from "./usage-ledger.ts";
import { readUsageLedger, dedupeBySession } from "./usage-ledger.ts";
import { readChannelTrust, lookupChannelTrust } from "./channel-trust.ts";
import type { ChannelTrustRegistry } from "./channel-trust.ts";

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
  /**
   * P0-4：本模型的用量来自哪些端点 host（去重，按首次出现顺序）。
   *
   * 为什么模型统计要带渠道：同一模型名经不同网关，usage 可信度**完全不同**
   *（实测某月卡网关的 Anthropic usage 是编造的）。`/cache` 只按模型聚合时，
   * 一个数字背后可能混了两个渠道，而"这个数能不能信"取决于渠道 ——
   * 数字与它的可信前提必须一起出现，分开放会让人只抄走数字。
   *
   * 旧账本行（2026-08-08 前）无 `endpointHost` 字段，不产生条目 ——
   * 所以空数组表示"该模型的样本全部来自记录渠道之前"，不是"没有渠道"。
   */
  hosts: string[];
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
  /**
   * P0-4：因渠道 usage 不可信而**排除出本统计**的账本行数（0 = 无排除）。
   *
   * 必须暴露给渲染层并显式写出来：静默排除读起来像"全部数据都在这儿"。
   * 与 `src/trace/cache-report.ts` 的 `excludedUntrustedRows` 同语义同口径。
   */
  excludedUntrustedRows: number;
  /**
   * P0-4：被排除的渠道 host → 理由。供渲染层给出"排除了谁、为什么"。
   *
   * 只放 host 与 reason，不放被排除的数字 —— 把假数字打印出来，
   * 迟早有人把它当真数字抄走（博客那次错误结论就是这么来的）。
   */
  untrustedHosts: Array<{ host: string; reason?: string }>;
  /**
   * P0-4 **覆盖盲区**：无 `endpointHost` 因而无法参与可信度判定的会话数。
   *
   * 这些行按 unknown（= 可信）计入，但那不是"已确认可信"，是"判不了"。
   * `endpointHost` 2026-08-08 才随 P0-4 落地，之前的账本行全部落在这里 ——
   * 实测本机 358 行只有 8 行带 host，于是 ppchat 虽判为 untrusted 却排除了 0 行。
   *
   * ⚠️ 渲染层必须在 `excludedUntrustedRows === 0` 时也说出这个数：
   * 否则"没排除任何行"会被读成"总计里没有脏数据"，而真相是脏数据没带标签、排不掉。
   * **机制上线 ≠ 数据被治理**，中间隔着一段只有新数据才有字段的过渡期。
   */
  sessionsWithoutHost: number;
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
    output: 0, costUSD: 0, savingsUSD: 0, sessions: 0, hosts: [],
  };
}

/**
 * 把一组账本行聚合成单个 PeriodCacheStats（不分周期，调用方自行筛选）。
 *
 * P0-4：**不可信渠道的行不进任何统计**（既不进 byModel 也不进总计），
 * 只在 `excludedUntrustedRows` / `untrustedHosts` 里留痕。
 *
 * 为什么必须在这里排除而不是在渲染层：`/cache` 的总命中率与"累计省钱"是
 * 对外可引用的数字。实测某月卡网关的 Anthropic usage 是编造的（全新前缀 r1 就报
 * 大量 cache_read），把它混进分子会**凭空抬高**整体命中率 ——
 * "我们缓存做得很好"这个结论就建立在假数据上。
 *
 * `unknown` 渠道（含旧账本行无 `endpointHost`）按**可信**处理：把没探测过的
 * 一律排除会让 `/cache` 在探针跑之前显示空表，比不排除更糟。
 * 判据链见 `channel-trust.ts` 头注释。
 *
 * @param registry 可注入的登记表（测试用；不传则每次调用读一次文件）
 */
export function aggregateEntries(
  entries: UsageLedgerEntry[],
  period: string,
  registry?: ChannelTrustRegistry,
): PeriodCacheStats {
  const byModel: Record<string, ModelCacheStats> = {};
  let totalHit = 0;
  let totalPrompt = 0;
  let totalSavings = 0;
  let totalCost = 0;
  let countedSessions = 0;
  let excludedUntrustedRows = 0;
  let sessionsWithoutHost = 0;
  // host → reason，去重（同一渠道多行只报一次）
  const untrusted = new Map<string, string | undefined>();

  const reg = registry ?? readChannelTrust();

  for (const e of entries) {
    // P0-4：不可信渠道整行排除。放在累加之前 —— 一旦加进去就再也分不出来了
    const verdict = lookupChannelTrust(e.endpointHost, reg);
    if (verdict.verdict === "untrusted") {
      excludedUntrustedRows++;
      if (e.endpointHost && !untrusted.has(e.endpointHost)) {
        untrusted.set(e.endpointHost, verdict.reason);
      }
      continue;
    }

    // P0-4 覆盖盲区：无 host 的行进不了可信度判定（见 sessionsWithoutHost 注释）
    if (!e.endpointHost) sessionsWithoutHost++;

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
    if (e.endpointHost && !m.hosts.includes(e.endpointHost)) m.hosts.push(e.endpointHost);

    totalHit += e.cacheHit;
    totalPrompt += e.promptTotal;
    totalSavings += e.savingsUSD;
    totalCost += e.costUSD;
    countedSessions++;
  }

  return {
    period,
    byModel,
    totalHitRate: totalPrompt > 0 ? totalHit / totalPrompt : 0,
    totalSavingsUSD: totalSavings,
    totalCostUSD: totalCost,
    // 会话数与上面三个总量同口径：都只数**计入统计**的行。
    // 用 entries.length 会让"355 会话"配上"排除 3 行后的命中率"，分母对不上。
    totalSessions: countedSessions,
    excludedUntrustedRows,
    untrustedHosts: [...untrusted].map(([host, reason]) => ({ host, reason })),
    sessionsWithoutHost,
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
  /**
   * P0-4：可注入的渠道可信度登记表（测试用）。
   * 不传则读一次 `~/.sid-code/channel-trust.json`；**在这一层读一次然后传给所有
   * 分组**，而不是让 aggregateEntries 每组各读一次文件 —— 后者在按天分组时
   * 会把同一个文件读几十遍。
   */
  trustRegistry?: ChannelTrustRegistry;
}

/**
 * 从账本聚合：返回按周期键分组的 PeriodCacheStats（按周期升序）。
 */
export function aggregateUsage(opts: AggregateOptions = {}): PeriodCacheStats[] {
  const granularity = opts.granularity ?? "day";
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  let entries = dedupeBySession(readUsageLedger(opts.maxEntries));

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

  // P0-4：登记表在这里读**一次**，传给所有分组。按天分组时组数可达几十，
  // 让每组各读一次文件是无谓的重复 IO。
  const reg = opts.trustRegistry ?? readChannelTrust();

  const result: PeriodCacheStats[] = [];
  for (const [key, group] of groups) {
    result.push(aggregateEntries(group, key, reg));
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
  let entries = dedupeBySession(readUsageLedger(opts.maxEntries));
  if (opts.model) {
    const q = opts.model;
    entries = entries.filter((e) => e.model === q || e.model.startsWith(q) || q.startsWith(e.model));
  }
  if (opts.sinceDays !== undefined) {
    const cutoff = now - opts.sinceDays * 24 * 60 * 60;
    entries = entries.filter((e) => e.ts >= cutoff);
  }
  return aggregateEntries(entries, "overall", opts.trustRegistry ?? readChannelTrust());
}
