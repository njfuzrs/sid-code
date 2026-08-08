/**
 * cache-report.ts —— 跨会话缓存视图（P2-4）
 *
 * 回答四个问题，全部有据可查、不含推测：
 *   1. 各模型的加权命中率是多少（分母是 promptTotal，不是"命中的请求数"）
 *   2. 缓存省了多少钱
 *   3. 中断按结构化类别的分布（哪类可优化、哪类只能监测）
 *   4. **哪些数字不可信**（渠道伪造 / 采集缺陷 / 样本太少）
 *
 * 第 4 条是本模块存在的主要理由。此前博客里"luna 命中率 2.2%，判定网关后端不支持
 * 前缀缓存"这个错误结论，正是因为账本只给了一个数字、没有任何"这个数字可不可信"的
 * 标注：真相是 sid-code 在 Responses 路径压根没提取缓存字段（已由 P0-1 修复）。
 * 所以这里的每个百分比都必须带样本量，不可信渠道必须打 ⚠ 且**不混入总命中率**。
 *
 * 数据源（全部只读）：
 *   ~/.sid-code/usage-ledger.jsonl    跨会话用量账本（命中率/成本/省钱）
 *   ~/.sid-code/cache-breaks.jsonl    缓存中断归因历史
 */

import { aggregateOverall } from "../telemetry/usage-aggregator.ts";
import { summarizeCacheBreakHistory } from "../telemetry/cache-telemetry.ts";
import type { ModelCacheStats } from "../telemetry/usage-aggregator.ts";

/** 样本量下限：低于此值只列数字不做判断（避免拿 2 个会话下结论） */
const MIN_SESSIONS_FOR_VERDICT = 5;

/**
 * 命中率低到需要怀疑"根本没生效"的阈值。
 *
 * 取 5% 而非 0：真实的冷启动会话本就命中 0，而一个**长期**低于 5% 的模型
 * 要么是采集缺陷、要么是渠道不支持，两者都值得点出来查 —— 但只有样本量够时才提。
 */
const SUSPICIOUS_HIT_RATE = 0.05;

export interface CacheReportOptions {
  noColor?: boolean;
  json?: boolean;
  /** 只看最近 N 天（不传 = 全部历史） */
  sinceDays?: number;
}

/** 单模型的报告行（json 模式直接输出这个结构） */
export interface CacheModelRow {
  model: string;
  sessions: number;
  promptTotal: number;
  cacheHit: number;
  /** 加权命中率 0~1；promptTotal=0 时为 null（不是 0 —— 没有分母就没有比率） */
  hitRate: number | null;
  costUSD: number;
  savingsUSD: number;
  /** 样本不足 / 命中率异常低等需要人看一眼的原因；为空表示无异常 */
  caveats: string[];
}

export interface CacheReport {
  models: CacheModelRow[];
  totalHitRate: number | null;
  totalCostUSD: number;
  totalSavingsUSD: number;
  totalSessions: number;
  breaks: {
    total: number;
    byCategory: Record<string, number>;
    /** 走结构化 categories 的记录数（P0-2 之后的新数据） */
    structuredCount: number;
    /** 只能靠文案匹配的旧记录数 */
    legacyCount: number;
  };
}

/** 构造报告数据（纯函数，便于测试；渲染在 renderCacheSection） */
export function buildCacheReport(opts: CacheReportOptions = {}): CacheReport {
  const agg = aggregateOverall({ sinceDays: opts.sinceDays });
  const breaks = summarizeCacheBreakHistory(500);

  const models: CacheModelRow[] = Object.entries(agg.byModel)
    .map(([model, s]) => toRow(model, s))
    .sort((a, b) => b.promptTotal - a.promptTotal);

  return {
    models,
    // promptTotal=0 时给 null 而不是 0：没有分母就没有比率，落 0 会被读成"命中率 0%"
    totalHitRate: agg.totalSessions > 0 && hasPrompt(models) ? agg.totalHitRate : null,
    totalCostUSD: agg.totalCostUSD,
    totalSavingsUSD: agg.totalSavingsUSD,
    totalSessions: agg.totalSessions,
    breaks,
  };
}

function hasPrompt(models: CacheModelRow[]): boolean {
  return models.some((m) => m.promptTotal > 0);
}

function toRow(model: string, s: ModelCacheStats): CacheModelRow {
  const hitRate = s.promptTotal > 0 ? s.cacheHit / s.promptTotal : null;
  const caveats: string[] = [];

  if (s.sessions < MIN_SESSIONS_FOR_VERDICT) {
    caveats.push(`样本仅 ${s.sessions} 会话，不足以下结论`);
  } else if (hitRate !== null && hitRate < SUSPICIOUS_HIT_RATE) {
    // 刻意只说"待查"而不给结论：这正是 luna 那次踩的坑 —— 把一个低数字直接
    // 解释成"网关不支持"，而真因是本地采集缺陷。要查的两个方向都写出来。
    caveats.push(
      `命中率异常低（${pct(hitRate)}），待查：① 本地是否漏采该协议的缓存字段 ② 渠道是否真的支持前缀缓存`,
    );
  }
  if (hitRate !== null && hitRate > 0 && s.savingsUSD === 0 && s.costUSD > 0) {
    caveats.push("有命中但省钱为 0，疑为定价表缺该模型");
  }

  return {
    model,
    sessions: s.sessions,
    promptTotal: s.promptTotal,
    cacheHit: s.cacheHit,
    hitRate,
    costUSD: s.costUSD,
    savingsUSD: s.savingsUSD,
    caveats,
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/** 渲染人类可读的缓存段落（--cache），或 json 模式下的原始结构 */
export function renderCacheSection(opts: CacheReportOptions = {}): string {
  const r = buildCacheReport(opts);
  if (opts.json) return JSON.stringify(r, null, 2);

  const L: string[] = [];
  const scope = opts.sinceDays ? `最近 ${opts.sinceDays} 天` : "全部历史";
  L.push(`━━━ 缓存视图（${scope}，${r.totalSessions} 会话）━━━`);

  if (r.totalSessions === 0) {
    L.push("  账本为空。跑几轮会话后再看（账本在 SessionEnd 落盘）。");
    return L.join("\n");
  }

  L.push("");
  L.push(`  总计  命中率 ${r.totalHitRate === null ? "N/A" : pct(r.totalHitRate)}` +
    `   成本 $${r.totalCostUSD.toFixed(4)}   省下 $${r.totalSavingsUSD.toFixed(4)}`);
  L.push("");
  L.push("  按模型（按输入量降序，命中率分母是 promptTotal 而非请求数）:");
  for (const m of r.models) {
    const rate = m.hitRate === null ? "N/A" : pct(m.hitRate);
    L.push(
      `    ${m.model.padEnd(22)} 命中率 ${rate.padStart(6)}  ` +
        `输入 ${m.promptTotal}  命中 ${m.cacheHit}  ` +
        `${m.sessions} 会话  省 $${m.savingsUSD.toFixed(4)}`,
    );
    // 每条 caveat 单独一行且带 ⚠ —— 数字与"这个数字可不可信"必须一起出现，
    // 分开放会让人只抄走数字（博客那次错误结论就是这么来的）。
    for (const c of m.caveats) L.push(`      ⚠ ${c}`);
  }

  L.push("");
  const b = r.breaks;
  L.push(`  中断归因（最近 ${b.total} 条；结构化 ${b.structuredCount} / 旧文案 ${b.legacyCount}）:`);
  if (b.total === 0) {
    L.push("    无记录。");
  } else {
    const entries = Object.entries(b.byCategory).sort((x, y) => y[1] - x[1]);
    for (const [cat, n] of entries) {
      const share = ((n / b.total) * 100).toFixed(0);
      L.push(`    ${cat.padEnd(20)} ${String(n).padStart(4)} 次 (${share}%)${categoryHint(cat)}`);
    }
  }

  return L.join("\n");
}

/**
 * 给归因类别标注"能不能优化" —— 分布本身不说明该做什么。
 *
 * `server_fluctuation` 占比高是**正常**的（服务端 TTL 到期本地无法控制），
 * 不标注的话容易被读成"缓存坏了"而去改本地代码，白费力气。
 */
function categoryHint(category: string): string {
  switch (category) {
    case "server_fluctuation":
      return "  ← 服务端波动，本地不可控（只能监测）";
    case "prefix_break":
      return "  ← 本地前缀断裂，可优化";
    case "tool_order":
      return "  ← 工具顺序不稳定，可优化";
    case "system_prompt":
      return "  ← system prompt 变化，检查是否有动态内容混进静态段";
    case "compact":
      return "  ← compact 后必然重算，预期行为";
    case "ttl_expiry":
      return "  ← 间隔过长，预期行为";
    case "model":
      return "  ← 换模型必然重算，预期行为";
    default:
      return "";
  }
}
