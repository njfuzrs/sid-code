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

  /**
   * P2-9：本行里属于存量数据（无 `appVersion`，即 2026-08-08 前的采集代码写的）
   * 的份额。行的主数字仍是全量 —— 存量只从**总计**里减掉，不改单行展示。
   *
   * 单行不减的理由：一行就是一个渠道的全部历史，把它按采集代码版本劈成两半，
   * 会让"这个渠道命中率多少"这个问题失去唯一答案。而总计要给一个能引用的数字，
   * 必须干净。
   */
  legacySessions: number;
  legacyPromptTotal: number;
  legacyCacheHit: number;
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

  /**
   * P2-9：没有 `appVersion` 的账本行数 —— 即**用 2026-08-08 之前的采集代码写的**。
   *
   * 为什么必须排除出命中率总计：那批代码有两个已修的漏采缺陷
   * （`e6642094` 修 Responses API 缓存双漏采、`ed26bfeb` 修 savings 兜底）。
   * 实测同一模型同一渠道，`gpt-5.6-luna` 08-02 记 3.2%、08-09 记 81.1% ——
   * 差异**全部**来自采集代码的修复时点，不是渠道变化。把这批行混进总计，
   * 会把总命中率从主力渠道的 79~82% 拉低到 66.2%，读起来像"缓存没做好"。
   *
   * 与 `rowsWithoutHost` 同一套处理模式（不新造一套）：归入"无版本标记"桶、
   * 默认排除出总计、渲染层**必须**显式报告排除了多少 —— 静默排除读起来像
   * "全部数据都在这儿"，而静默不排除读起来像"总计干净"，两种都是骗人。
   */
  rowsWithoutVersion: number;
  /** 同上按会话数计 */
  sessionsWithoutVersion: number;
  /** 被排除出命中率总计的存量输入 token 数 */
  excludedLegacyPromptTotal: number;
  /** 被排除出命中率总计的存量命中 token 数 */
  excludedLegacyCacheHit: number;
  /**
   * 存量行自己的命中率（可为 null）。
   *
   * 单独给出来是为了**自证排除真的生效了**：若它与 `totalHitRate` 相差无几，
   * 说明要么存量数据本来就不脏、要么排除逻辑没接上 —— 两种都需要人看一眼。
   * 只报一个"已排除"计数而不给对照值，无法区分这两种情况。
   */
  legacyHitRate: number | null;
  /**
   * 含存量行的总命中率 —— **仅供对照，不要拿它下结论**。
   *
   * 它就是修复前那个被拉低的数字（实测 66.2%）。与 `totalHitRate` 并列输出，
   * 让"排除了多少脏数据"变成一个能看见的差值而不是一句承诺。
   */
  totalHitRateIncludingLegacy: number | null;
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

  /**
   * P2-9：上面各项里**属于存量行（无 `appVersion`）的那部分**，作为子集单独累加。
   *
   * 为什么是"桶内子集"而不是"多一个桶维度"：分组键必须保持 `模型 × 渠道`。
   * 把版本加进键会把每个渠道切成"有版本/无版本"两半，行数翻倍且每半样本更少 ——
   * 而这个视图要回答的问题是"哪个渠道更省"，不是"哪个版本更省"。
   * 存量只需要能从总计里**减掉**，不需要单独成行。
   */
  legacySessions: number;
  legacyPromptTotal: number;
  legacyCacheHit: number;
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
      b = {
        model: e.model,
        endpointHost: e.endpointHost,
        sessions: 0,
        promptTotal: 0,
        cacheHit: 0,
        costUSD: 0,
        savingsUSD: 0,
        legacySessions: 0,
        legacyPromptTotal: 0,
        legacyCacheHit: 0,
      };
      buckets.set(key, b);
    }
    b.sessions++;
    b.promptTotal += e.promptTotal;
    b.cacheHit += e.cacheHit;
    b.costUSD += e.costUSD;
    b.savingsUSD += e.savingsUSD;

    // P2-9：判据是"字段缺失"而非任何版本号比较。
    //
    // 刻意不写 `if (e.appVersion < "0.1.601")` 这类版本比较：字符串比版本号会在
    // 0.1.99 vs 0.1.100 上排错，而语义化比较需要引一个解析器 —— 而这里真正要
    // 区分的只有一件事：**这行是不是用带修复的采集代码写的**。修复落地即开始写
    // 这个字段，所以"有没有字段"正好就是那条分界线，比任何数值比较都准。
    if (!e.appVersion) {
      b.legacySessions++;
      b.legacyPromptTotal += e.promptTotal;
      b.legacyCacheHit += e.cacheHit;
    }
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

  // P2-9：存量行（无 appVersion）在可信渠道内的份额 —— 从命中率总计里减掉。
  //
  // 只在 `counted` 上累加：untrusted 渠道的行已经整行排除掉了，再把它的存量份额
  // 算进"排除量"会重复计数，让"排除了多少"这个数字本身失真。
  const legacyPrompt = counted.reduce((s, m) => s + m.legacyPromptTotal, 0);
  const legacyHit = counted.reduce((s, m) => s + m.legacyCacheHit, 0);
  const cleanPrompt = totalPrompt - legacyPrompt;
  const cleanHit = totalHit - legacyHit;

  return {
    models,
    // 分母为 0 时给 null 而不是 0：没有分母就没有比率，落 0 会被读成"命中率 0%"
    //
    // P2-9：**默认口径已改为"排除存量行"**。全是存量数据时（cleanPrompt=0）给 null
    // 而不是回落到含存量的数字 —— 回落会让"这个总计是干净的"这个承诺在最需要它的
    // 场景下静默失效，而 null + 下方显式说明能让人看出"暂时无可信样本"。
    totalHitRate: cleanPrompt > 0 ? cleanHit / cleanPrompt : null,
    totalCostUSD: counted.reduce((s, m) => s + m.costUSD, 0),
    totalSavingsUSD: counted.reduce((s, m) => s + m.savingsUSD, 0),
    totalSessions: counted.reduce((s, m) => s + m.sessions, 0),
    excludedUntrustedRows: models.length - counted.length,
    rowsWithoutHost,
    sessionsWithoutHost,
    rowsWithoutVersion: models.filter((m) => m.legacySessions > 0).length,
    sessionsWithoutVersion: counted.reduce((s, m) => s + m.legacySessions, 0),
    excludedLegacyPromptTotal: legacyPrompt,
    excludedLegacyCacheHit: legacyHit,
    legacyHitRate: legacyPrompt > 0 ? legacyHit / legacyPrompt : null,
    // 对照值：修复前那个被存量拉低的数字。并列输出让差值可见。
    totalHitRateIncludingLegacy: totalPrompt > 0 ? totalHit / totalPrompt : null,
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

  // P2-9：本行掺了多少存量数据。**行内数字不减，只标注** —— 一行是一个渠道的
  // 全部历史，劈成两半就没有唯一答案了；但不标注的话，一个被存量拉低的行数字
  // 会被当成"这个渠道命中率就这么低"抄走（luna 那次就是这么得出错误结论的）。
  if (s.legacySessions > 0) {
    const share = s.sessions > 0 ? ` (${s.legacySessions}/${s.sessions} 会话)` : "";
    caveats.push(
      `含 2026-08-08 前采集的存量数据${share}，其 cacheHit/savings 已知漏采 ——` +
        `本行数字偏低，已从总计中排除该部分`,
    );
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
    legacySessions: s.legacySessions,
    legacyPromptTotal: s.legacyPromptTotal,
    legacyCacheHit: s.legacyCacheHit,
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
  L.push(
    `  总计  命中率 ${r.totalHitRate === null ? "N/A" : pct(r.totalHitRate)}` +
      `   成本 $${r.totalCostUSD.toFixed(4)}   省下 $${r.totalSavingsUSD.toFixed(4)}`,
  );
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
  // P2-9：存量数据的排除必须**显式报告数量 + 给出对照值**。
  //
  // 只说"已排除"不给对照，读者无法判断排除是否真的生效（这正是 §七.3 验收里
  // "若排除后数字没动说明排除逻辑没生效"那一条要防的）。所以三个数一起给：
  // 排除了多少会话、存量自己的命中率、以及含存量的旧口径值。
  if (r.sessionsWithoutVersion > 0) {
    L.push(
      `        ⚠ 已排除 ${r.sessionsWithoutVersion} 个无版本标记会话` +
        `（2026-08-08 前的采集代码，cacheHit/savings 已知漏采）：` +
        `其命中率 ${r.legacyHitRate === null ? "N/A" : pct(r.legacyHitRate)}，` +
        `含它们的旧口径总计为 ${
          r.totalHitRateIncludingLegacy === null ? "N/A" : pct(r.totalHitRateIncludingLegacy)
        }`,
    );
    L.push(
      `          （上面那行"总计"已是排除后的干净口径。存量行的 cost 仍然有效，` +
        `只有 cacheHit/savings 失真，所以数据保留不删）`,
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
  L.push(
    `  中断归因（最近 ${b.total} 条；结构化 ${b.structuredCount} / 旧文案 ${b.legacyCount}）:`,
  );
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
