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

import { summarizeCacheBreakHistory } from "../telemetry/cache-telemetry.ts";
import { readUsageLedger, dedupeBySession } from "../telemetry/usage-ledger.ts";
import { readChannelTrust, lookupChannelTrust } from "../telemetry/channel-trust.ts";
import type { ChannelTrustRegistry } from "../telemetry/channel-trust.ts";

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

/**
 * 单行的分组键：模型 × 端点 host（P0-4）。
 *
 * 为什么不按模型聚合：同一模型名经不同网关，usage 可信度**完全不同**
 *（实测某月卡网关的 Anthropic usage 是编造的）。按模型聚合会把假数字和真数字
 * 加在一起，从此不可分离。
 */
export interface CacheModelRow {
  model: string;
  /** 端点 host；旧账本行无此字段时为 undefined（显示为"未知渠道"） */
  endpointHost?: string;
  sessions: number;
  promptTotal: number;
  cacheHit: number;
  /** 加权命中率 0~1；promptTotal=0 时为 null（不是 0 —— 没有分母就没有比率） */
  hitRate: number | null;
  costUSD: number;
  savingsUSD: number;
  /** P0-4：该渠道的 usage 可信度判定 */
  trust: "trusted" | "untrusted" | "unknown";
  /** 样本不足 / 命中率异常低 / 渠道不可信等需要人看一眼的原因；为空表示无异常 */
  caveats: string[];
}

export interface CacheReport {
  models: CacheModelRow[];
  /** 总命中率 —— **已排除 untrusted 渠道**（见 P0-4） */
  totalHitRate: number | null;
  totalCostUSD: number;
  totalSavingsUSD: number;
  totalSessions: number;
  /** P0-4：被排除出总计的不可信渠道行数（>0 时渲染层必须说明） */
  excludedUntrustedRows: number;
  /**
   * P0-4 覆盖盲区：没有 `endpointHost` 因而**无法参与可信度判定**的行数。
   *
   * 这些行按 unknown（= 可信）计入总计，但那不是"已确认可信"，而是"判不了"。
   * `endpointHost` 2026-08-08 才落地，之前的账本行全部落在这里。
   *
   * ⚠️ 渲染层必须在 `excludedUntrustedRows === 0` 时也把这个数说出来，
   * 否则"已排除 0 行"读起来像"总计干净"，而真相是脏数据没带标签所以排不掉。
   */
  rowsWithoutHost: number;
  /** 同上，按会话数计（行是"模型×渠道"分组，会话数才是用户能对上的量级） */
  sessionsWithoutHost: number;
  breaks: {
    total: number;
    byCategory: Record<string, number>;
    /** 走结构化 categories 的记录数（P0-2 之后的新数据） */
    structuredCount: number;
    /** 只能靠文案匹配的旧记录数 */
    legacyCount: number;
  };
}

/** 内部累加器：模型 × host */
interface Bucket {
  model: string;
  endpointHost?: string;
  sessions: number;
  promptTotal: number;
  cacheHit: number;
  costUSD: number;
  savingsUSD: number;
}

/** 构造报告数据（纯函数，便于测试；渲染在 renderCacheSection） */
export function buildCacheReport(opts: CacheReportOptions = {}): CacheReport {
  const breaks = summarizeCacheBreakHistory(500);
  const registry = readChannelTrust();

  // 自己读账本而不复用 aggregateOverall：后者按模型聚合，会把不同渠道的数字
  // 合成一行，之后再也分不开可信与不可信（P0-4 的核心要求就是分得开）。
  let entries = dedupeBySession(readUsageLedger());
  if (opts.sinceDays !== undefined) {
    const cutoff = Math.floor(Date.now() / 1000) - opts.sinceDays * 24 * 60 * 60;
    entries = entries.filter((e) => e.ts >= cutoff);
  }

  const buckets = new Map<string, Bucket>();
  for (const e of entries) {
    const key = `${e.model}|${e.endpointHost ?? ""}`;
    let b = buckets.get(key);
    if (!b) {
      b = { model: e.model, endpointHost: e.endpointHost, sessions: 0, promptTotal: 0, cacheHit: 0, costUSD: 0, savingsUSD: 0 };
      buckets.set(key, b);
    }
    b.sessions++;
    b.promptTotal += e.promptTotal;
    b.cacheHit += e.cacheHit;
    b.costUSD += e.costUSD;
    b.savingsUSD += e.savingsUSD;
  }

  const models = [...buckets.values()]
    .map((b) => toRow(b, registry))
    .sort((a, b) => b.promptTotal - a.promptTotal);

  // 总计只累加可信（含 unknown）渠道：把伪造的"命中"混进去会凭空抬高整体数字，
  // 让"缓存做得好"这个结论建立在假数据上。
  const counted = models.filter((m) => m.trust !== "untrusted");
  const totalPrompt = counted.reduce((s, m) => s + m.promptTotal, 0);
  const totalHit = counted.reduce((s, m) => s + m.cacheHit, 0);

  // P0-4 的**覆盖盲区**：排除只能作用于带 endpointHost 的行。
  //
  // `endpointHost` 2026-08-08 才随 P0-4 落地，之前的账本行一条都没有 host，
  // 于是全部按 unknown（= 可信）计入 —— 包括那些真的来自不可信渠道的行。
  // 实测本机：358 行里只有 8 行带 host，ppchat 判为 untrusted 却排除了 **0 行**。
  //
  // ⚠️ 不把这个盲区写出来，"已排除 0 个不可信渠道行"会被读成"总计里没有脏数据"，
  // 而真相是"脏数据还在里面，只是它没带渠道标签所以排不掉"。
  // 这正是本仓库反复栽的那个跟头：**机制上线 ≠ 数据被治理**，中间隔着一段
  // 只有新数据才有字段的过渡期。同病见记忆 `proxy-metric-rewards-relabeling-waste`。
  const rowsWithoutHost = models.filter((m) => !m.endpointHost).length;
  const sessionsWithoutHost = models
    .filter((m) => !m.endpointHost)
    .reduce((s, m) => s + m.sessions, 0);

  return {
    models,
    // 分母为 0 时给 null 而不是 0：没有分母就没有比率，落 0 会被读成"命中率 0%"
    totalHitRate: totalPrompt > 0 ? totalHit / totalPrompt : null,
    totalCostUSD: counted.reduce((s, m) => s + m.costUSD, 0),
    totalSavingsUSD: counted.reduce((s, m) => s + m.savingsUSD, 0),
    totalSessions: counted.reduce((s, m) => s + m.sessions, 0),
    excludedUntrustedRows: models.length - counted.length,
    rowsWithoutHost,
    sessionsWithoutHost,
    breaks,
  };
}

function toRow(s: Bucket, registry: ChannelTrustRegistry): CacheModelRow {
  const hitRate = s.promptTotal > 0 ? s.cacheHit / s.promptTotal : null;
  const caveats: string[] = [];
  const verdict = lookupChannelTrust(s.endpointHost, registry);

  // 不可信渠道的警示放**最前面**：它决定后面所有数字是否值得读
  if (verdict.verdict === "untrusted") {
    const why = verdict.reason ?? `判据 ${(verdict.failedCriteria ?? []).join("/")} 命中`;
    caveats.push(`渠道 usage 不可信（${why}），已排除出总计`);
  }

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
    model: s.model,
    endpointHost: s.endpointHost,
    sessions: s.sessions,
    promptTotal: s.promptTotal,
    cacheHit: s.cacheHit,
    hitRate,
    costUSD: s.costUSD,
    savingsUSD: s.savingsUSD,
    trust: verdict.verdict,
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
  // 排除了多少行必须写出来：静默排除读起来像"全部数据都在这儿"
  if (r.excludedUntrustedRows > 0) {
    L.push(`        （已排除 ${r.excludedUntrustedRows} 个不可信渠道行，见下方 ⚠）`);
  }
  // P0-4 覆盖盲区：**排除数为 0 时也要说**。否则"没排除"会被读成"总计干净"，
  // 而实际是这些行没带 endpointHost、根本没进可信度判定。
  if (r.sessionsWithoutHost > 0) {
    L.push(
      `        ⚠ 其中 ${r.sessionsWithoutHost} 个会话无渠道标记（账本 2026-08-08 前不记 endpointHost），` +
        `未参与可信度判定 —— 上面的总计里可能仍混有不可信渠道的数字`,
    );
  }
  L.push("");
  L.push("  按模型 × 渠道（按输入量降序，命中率分母是 promptTotal 而非请求数）:");
  for (const m of r.models) {
    const rate = m.hitRate === null ? "N/A" : pct(m.hitRate);
    // 同模型经不同网关可信度不同，所以渠道必须显式出现在行上
    const host = m.endpointHost ?? "未知渠道";
    const mark = m.trust === "untrusted" ? " ⚠不可信" : "";
    L.push(
      `    ${m.model.padEnd(22)} @${host.padEnd(20)}${mark} 命中率 ${rate.padStart(6)}  ` +
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
