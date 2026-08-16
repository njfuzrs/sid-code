#!/usr/bin/env bun
/**
 * northstar-snapshot —— 北极星四方向主指标的版本快照与版本间对比（P1-5 + P0-3 + P2-13）
 *
 * ## 它解决的两个问题
 *
 * **① 零自动对比（P1-5）。** 4 个 CLI 看板全部人工触发、无一带版本维度；5 个 workflow
 * 里 4 个的 cron 全被注释。那些注释的理由是对的（依赖 API key，空 secret 只会让请求拿
 * 401 失败在半路、每周稳定堆一个红叉），但由此得出"所以没有自动对比"是错的 ——
 * **四个主指标里有三个完全不需要 LLM**：
 *
 * | 指标 | 需要 LLM？ | 数据源 |
 * |---|---|---|
 * | 端到端 / TTFT | ❌ | `session-index.jsonl` |
 * | 单位成本 / 缓存命中率 | ❌ | `usage-ledger.jsonl` |
 * | 防线触发率 | ❌ | `session-index.jsonl` |
 * | 质量分（correctness） | ✅ 必须真跑模型 + judge | `evals/` |
 *
 * 真正的缺口不是"缺自动化能力"，而是"把需要 key 的和不需要 key 的绑在了一起"。
 * 本脚本只做前三类，一行 LLM 调用都没有。
 *
 * **② 文档现状人手维护导致三次漂移（P0-3）。** 现状数字是人抄进 markdown 表格的，
 * 于是无法自动过期、无法机械校验、改代码的人不会想起改文档。三次漂移的失效模式完全相同：
 * 读者看不出那个快照是三天前还是三个月前量的，于是照抄。告诫 + 自觉核验这条路**已被证伪
 * 三次**，所以改成生成（`--emit-markdown`）+ 陈旧检测（`--check-staleness`）。
 *
 * ## 三条禁令（照抄 changelog 那四条的同一理由）
 *
 * 1. **绝不调 LLM**。本脚本会被 `release.sh` 调用，而发布路径必须确定性 + 离线 + 幂等。
 * 2. **CI 里只做 self-test**，不尝试聚合真实用量 —— runner 上没有 `~/.sid-code/`，
 *    强行聚合只会得到一份 n=0 的快照，而 n=0 的快照比没有快照更危险（它看起来像数据）。
 * 3. **版本间对比只报告不阻断发版**。指标退步需要人判断（可能是采样变了、可能是新功能
 *    的合理代价），自动拦发版会逼人加 `--skip` 绕过，最后连报告都不看了。
 *
 * ## P2-13：三个"会话数"分母
 *
 * 输出头部固定打印三个分母及其定义。它们互不一致**不是 bug，是口径不同**：
 * `active-sessions/` 是进程级（含从未调用 LLM 的）、`trajectories/sessions/` 是有轨迹
 * 采集的（受 LRU=100 管辖）、`usage-ledger.jsonl` 是有真实 API 调用的（无清理）。
 * 任何"覆盖率"分子分母取自不同源就会算出荒谬结果 —— 方案作者自己踩过一次：
 * 按目录数（82）当分母得出 traj 覆盖 68%，按有效会话算其实是 100%。
 *
 * ## 用法
 *
 *   bun scripts/northstar-snapshot.ts                          # 打印人类可读快照
 *   bun scripts/northstar-snapshot.ts --json                    # 机器可读
 *   bun scripts/northstar-snapshot.ts --version 0.1.601 --emit northstar/
 *                                                              # 写 northstar/v0.1.601.json
 *   bun scripts/northstar-snapshot.ts --compare 0.1.600 0.1.601 # 两个版本间对比
 *   bun scripts/northstar-snapshot.ts --emit-markdown           # 生成防漂移 markdown 块
 *   bun scripts/northstar-snapshot.ts --check-staleness 30 <file>
 *                                                              # 生成块超过 N 天则非零退出
 *   bun scripts/northstar-snapshot.ts --self-test               # CI 用：不读真实数据
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSessionIndex, type SessionIndexEntry } from "@sid-code/core/trace/session-index.ts";
import { readUsageLedger, type UsageLedgerEntry } from "@sid-code/core/telemetry/usage-ledger.ts";
import {
  aggregateCacheHit,
  type CacheHitAggregate,
} from "@sid-code/core/telemetry/cache-hit-aggregate.ts";
import { sidPaths } from "@sid-code/core/config/paths.ts";
import { getRawVersion } from "@sid-code/shared/version.ts";

/**
 * 本脚本认得的全部 flag。
 *
 * **必须与下方所有 `flags.has(...)` / `argOf(...)` 的实参完全一致** —— 由
 * `packages/cli/tests/scripts/northstar-snapshot-flags.test.ts` 双向对账。
 *
 * 这份清单的存在理由不是文档化，而是让**未识别 flag 变成硬错误**。
 * `trace-digest.ts` 的 `--health` 就是反面教材：头注释写着可用、代码没接，
 * 未识别 flag 被静默忽略 → 用户拿到的是一份看似正常的单会话摘要，
 * 而他要的是健康看板。不报错的降级比报错难查得多。
 */
export const KNOWN_FLAGS = new Set([
  "--json",
  "--version",
  "--emit",
  "--compare",
  "--emit-markdown",
  "--check-staleness",
  "--self-test",
  "--days",
  "--weekly",
]);

/** 生成块的定界标记。`--check-staleness` 靠它们定位，改动会破坏既有文档里的块。 */
export const MARKDOWN_BEGIN = "<!-- NORTHSTAR:BEGIN";
export const MARKDOWN_END = "<!-- NORTHSTAR:END -->";

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

/**
 * 一个指标的取值 + **它的样本量**。
 *
 * `n` 是必填字段而不是可选的：p95 在 n=3 上算出来的数与 n=1000 上的数长得一模一样，
 * 但一个是噪声、一个是结论。不带 n 的指标在本文件里视为无效数据。
 */
export interface Metric {
  value: number | null;
  n: number;
  /** 取数源（file:field 粒度）。说不出源的数字就是自我感觉 */
  source: string;
  /** 单位，用于渲染（ms / usd / ratio / count） */
  unit: "ms" | "usd" | "ratio" | "count";
}

/** 三个"会话数"分母（P2-13）。刻意不统一 —— 三个口径各有用途，合并会丢信息 */
export interface SessionDenominators {
  /** 进程级会话数（含从未产生 LLM 调用的），无 LRU */
  activeSessions: number;
  /** 有轨迹采集且含 events.jsonl 的会话数，受 LRU=100 管辖 */
  trajValidSessions: number;
  /** 有真实 API 调用的会话数（账本行数，去重后），无清理 */
  ledgerSessions: number;
  /** 索引里的会话数 —— 不受 LRU 影响，是**跨版本对比唯一可用**的分母 */
  indexSessions: number;
}

export interface NorthstarSnapshot {
  /** 快照对应的 sid-code 版本（裸 x.y.z）。飞轮曲线唯一的分组键 */
  appVersion: string;
  /**
   * `appVersion` 与数据的关系。**这个字段不能省，它决定了 `appVersion` 是不是在撒谎。**
   *
   * - `version`：只聚合 `app_version === appVersion` 的行 —— 这一份**真的是那个版本的数据**。
   * - `cumulative`：聚合窗口内**所有版本**的行，`appVersion` 只是"谁生成了这份快照"。
   *
   * 为什么必须显式区分：一份标着 `v0.1.601` 却混着 20 个历史版本数据的快照，
   * 会让连续两次发版的 delta 恒等于 +0.0%（两份都以同一批旧数据为主体）——
   * 那不是"性能没变"，是分组键失效。飞轮曲线要的是前者，看板总览要的是后者，
   * 混用则两个用途都废掉。
   */
  scope: "version" | "cumulative";
  /** 生成时刻（ISO）。P0-3 的核心：让新鲜度一眼可读 */
  generatedAt: string;
  /** 聚合的时间窗（天）；null = 全量 */
  windowDays: number | null;
  denominators: SessionDenominators;
  /** 更快 */
  faster: { e2e_p50: Metric; e2e_p95: Metric; ttft_p50: Metric; ttft_p95: Metric };
  /** 更省 */
  cheaper: {
    cost_per_session: Metric;
    cache_hit_rate: Metric;
    turns_per_session: Metric;
    compactions_per_session: Metric;
  };
  /**
   * 缓存命中率的**清洗账**：排除了什么、以及排除前后的两个数。
   *
   * 为什么它必须进快照结构而不只是渲染时打一行：`cache_hit_rate` 现在是**干净口径**
   * （去重 + 排除 untrusted 渠道 + 排除无 appVersion 存量行），这让它与历史快照
   * 里那个脏口径的数**不可直接比较**。不把清洗账一并落盘，将来对比两份 JSON 的人
   * 会把一次口径修复读成一次真实的指标跃升 —— 那正是本脚本存在的理由要防的事。
   *
   * 静默排除读起来像"全部数据都在这儿"，静默不排除读起来像"总计干净"，两种都是骗人。
   */
  cacheHitCaliber: {
    /** 干净口径的分子分母（可复算 `cache_hit_rate`，也让"分母有多小"可见） */
    cleanPromptTotal: number;
    cleanCacheHit: number;
    /**
     * 含存量行的命中率 —— **仅供对照**，就是本次口径修复之前报的那个数。
     * 与 `cache_hit_rate` 并列，让"排除了多少脏数据"变成能看见的差值而非一句承诺。
     */
    hitRateIncludingLegacy: number | null;
    /**
     * 存量行自己的命中率。给它是为了**自证排除真的生效了**：若与干净口径相差无几，
     * 说明要么存量本来就不脏、要么排除没接上 —— 两种都需要人看一眼。
     */
    legacyHitRate: number | null;
    /** 去重掉的重复会话行数（>0 说明账本里有 append 时代的残留） */
    duplicateRows: number;
    /** 被判 untrusted 整行排除的会话行数 */
    untrustedRows: number;
    /**
     * 无 `endpointHost` 因而**无法参与可信度判定**的行数。
     * `untrustedRows === 0` 时也必须报出来：否则"已排除 0 行"读起来像"总计干净"，
     * 真相是脏数据没带渠道标签所以排不掉（机制上线 ≠ 数据被治理）。
     */
    rowsWithoutHost: number;
    /** 无 `appVersion` 被判存量、排除出干净口径的会话行数 */
    legacyRows: number;
    /**
     * 可信渠道内的全部会话行数（含存量）—— `hitRateIncludingLegacy` 的样本量。
     *
     * 它同时是「有没有东西可判」的判据：为 0 时命中率相关的一致性断言一律不产出
     * （账本为空时那条断言恒成立，不携带信息，报 skip 比报 pass 诚实）。
     */
    countedSessions: number;
  };
  /** 更少返工 */
  fewerRedos: { real_errors_per_session: Metric; pathological_session_rate: Metric };
  /** 底座 · 可度量（含 P2-14 轨迹损坏率） */
  foundation: {
    defense_trigger_rate: Metric;
    traj_corrupt_rate: Metric;
    /** 无版本标记因而无法参与版本对比的索引行数 */
    rows_without_version: number;
  };
  /** 一致性断言结果。任一条失败说明某侧漏采，是真缺陷 */
  assertions: Array<{ name: string; ok: boolean; detail: string }>;
}

// ─────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────

/** 分位数。空样本返回 null（**不是 0** —— 0 会被读成"0 毫秒"） */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function metric(value: number | null, n: number, source: string, unit: Metric["unit"]): Metric {
  return { value, n, source, unit };
}

/** 均值。空样本返回 null，同 percentile 的理由 */
function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** 数当前盘上的"有轨迹且含 events.jsonl"的会话目录数（P2-13 的第二个分母） */
function countTrajValidSessions(): number {
  try {
    const dir = join(sidPaths.trajectories(), "sessions");
    if (!existsSync(dir)) return 0;
    let n = 0;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        if (statSync(p).isDirectory() && existsSync(join(p, "events.jsonl"))) n++;
      } catch {
        /* 单个目录读失败跳过，不让一个坏目录毁掉整个分母 */
      }
    }
    return n;
  } catch {
    return 0;
  }
}

/** 数 active-sessions/ 下的 .json（P2-13 的第一个分母：进程级会话） */
function countActiveSessions(): number {
  try {
    const dir = sidPaths.activeSessions();
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────
// 聚合
// ─────────────────────────────────────────────────────────────

export interface BuildOptions {
  /** 只聚合最近 N 天；不传 = 全量 */
  windowDays?: number;
  /** 只聚合某个版本的行（版本间对比用） */
  onlyVersion?: string;
  /** 注入数据源（测试/self-test 用；不传则读真实盘） */
  data?: { index: SessionIndexEntry[]; ledger: UsageLedgerEntry[] };
  /** 注入分母（同上） */
  denominators?: Partial<SessionDenominators>;
  /** 快照标记的版本号；不传取当前 package.json */
  appVersion?: string;
  /** 生成时刻（ISO）。**必须可注入** —— 否则快照内容不确定，测不了幂等 */
  now?: Date;
}

/**
 * 构造快照（纯函数，数据可注入）。
 *
 * 所有分位数都从**原始样本重排**算，绝不拿分位数再平均 —— p50 的平均不是平均的 p50，
 * 从会话级 p50 反推全量 p50 只会得到一个看起来合理的错数。
 * 单会话的 `e2e_p50` 在这里被当作"该会话的代表值"参与全量分布，这一点在
 * `source` 字段里写明，不假装它等于全量分位数。
 */
export function buildSnapshot(opts: BuildOptions = {}): NorthstarSnapshot {
  const now = opts.now ?? new Date();
  const appVersion = opts.appVersion ?? getRawVersion();
  const windowDays = opts.windowDays ?? null;

  const rawIndex = opts.data?.index ?? readSessionIndex();
  const rawLedger = opts.data?.ledger ?? readUsageLedger();

  const cutoffSec = windowDays === null ? 0 : Math.floor(now.getTime() / 1000) - windowDays * 86400;
  const inWindow = <T extends { ts: number }>(e: T) => e.ts >= cutoffSec;

  let index = rawIndex.filter(inWindow);
  let ledger = rawLedger.filter(inWindow);

  // 无版本标记的行数必须在**过滤之前**先数出来并报告。静默排除读起来像"全部数据都在
  // 这儿"，静默不排除读起来像"总计干净"—— 两种都是骗人（与 cache-report 同一处理模式）。
  const rowsWithoutVersion = index.filter((e) => !e.app_version).length;
  if (opts.onlyVersion) {
    index = index.filter((e) => e.app_version === opts.onlyVersion);
    ledger = ledger.filter((e) => e.appVersion === opts.onlyVersion);
  }

  // ── 更快 ──
  // 单会话分位数缺失（样本不足）时整条会话不进分布，而不是当 0 —— 见 Metric.n 注释。
  const e2eP50s = index.map((e) => e.e2e_p50).filter((v): v is number => typeof v === "number");
  const e2eP95s = index.map((e) => e.e2e_p95).filter((v): v is number => typeof v === "number");
  const ttftP50s = index.map((e) => e.ttft_p50).filter((v): v is number => typeof v === "number");
  const ttftP95s = index.map((e) => e.ttft_p95).filter((v): v is number => typeof v === "number");

  // ── 更省 ──
  // 成本/轮数按**会话**取值：会话长度是成本最大杠杆（2× 轮数 ≈ 3~4× 成本），
  // 所以 turns 与 cost 必须是同一批会话上的两个数，否则"变省了"可能只是会话变短了。
  const costs = ledger.map((e) => e.costUSD).filter((v) => typeof v === "number" && v >= 0);
  const turns = index.map((e) => e.turns).filter((v) => typeof v === "number" && v >= 0);
  const compactions = index
    .map((e) => e.compactions)
    .filter((v) => typeof v === "number" && v >= 0);

  // 缓存命中率 = cache_read ÷ 总 input。**在 token 总量上算，不是各会话命中率的平均** ——
  // 后者会让一个 100 token 的会话与一个 100 万 token 的会话等权，得出的数没有计费意义。
  //
  // 走公共聚合器 `telemetry/cache-hit-aggregate.ts`，**不在这里自己做除法**。
  // 此前这里是一段裸循环（`hitSum / inputSum`），三层清洗一个都没做，于是同一份
  // `usage-ledger.jsonl` 在 `/cache` 视图里是 76.4%、在这份进 release 曲线的快照里是
  // 68.2%。差的 8.2pp 全部来自：① 未按 sessionId 去重 ② 未排除伪造 usage 的渠道
  // ③ 未排除 2026-08-08 前采集代码写的存量行。**脏的那个恰好是画曲线的那个。**
  //
  // 注意传的是 `rawLedger` 而不是上面已按窗口过滤的 `ledger`：去重必须发生在窗口
  // 过滤之前（否则窗口边界会把一次 upsert 的旧行当成"窗口内唯一的行"留下），
  // 所以窗口/版本过滤一并交给聚合器按正确顺序做。
  const cacheAgg = aggregateCacheHit({
    entries: rawLedger,
    windowDays: opts.windowDays,
    onlyVersion: opts.onlyVersion,
    now,
  });

  // ── 更少返工 ──
  // 只统计有终态的会话：增量行的 real_errors 恒 0（见 collector 的
  // flushSessionIndexIncremental 注释），混进来会把"还在跑"读成"零错误"。
  const settled = index.filter((e) => e.exit_status !== "incomplete");
  const realErrors = settled
    .map((e) => e.real_errors)
    .filter((v) => typeof v === "number" && v >= 0);
  const pathologicalCount = settled.filter((e) => (e.pathological?.length ?? 0) > 0).length;

  // ── 底座 ──
  const defenseCount = index.filter((e) => e.defense_triggered === true).length;
  const corruptCount = index.filter((e) => e.traj_corrupt === true).length;

  const denominators: SessionDenominators = {
    activeSessions: opts.denominators?.activeSessions ?? countActiveSessions(),
    trajValidSessions: opts.denominators?.trajValidSessions ?? countTrajValidSessions(),
    ledgerSessions:
      opts.denominators?.ledgerSessions ?? new Set(ledger.map((e) => e.sessionId)).size,
    indexSessions: opts.denominators?.indexSessions ?? new Set(index.map((e) => e.session_id)).size,
  };

  const IDX = "session-index.jsonl";
  const LED = "usage-ledger.jsonl";

  const snapshot: NorthstarSnapshot = {
    appVersion,
    scope: opts.onlyVersion ? "version" : "cumulative",
    generatedAt: now.toISOString(),
    windowDays,
    denominators,
    faster: {
      e2e_p50: metric(percentile(e2eP50s, 0.5), e2eP50s.length, `${IDX}:e2e_p50`, "ms"),
      e2e_p95: metric(percentile(e2eP95s, 0.95), e2eP95s.length, `${IDX}:e2e_p95`, "ms"),
      ttft_p50: metric(percentile(ttftP50s, 0.5), ttftP50s.length, `${IDX}:ttft_p50`, "ms"),
      ttft_p95: metric(percentile(ttftP95s, 0.95), ttftP95s.length, `${IDX}:ttft_p95`, "ms"),
    },
    cheaper: {
      cost_per_session: metric(mean(costs), costs.length, `${LED}:costUSD`, "usd"),
      // n 用 `cleanSessions`（真正贡献了这个比值的会话数），**不是账本总行数**。
      // 以前写 `ledger.length` 是虚报样本量：实测本机 378 行里 377 行是存量被排除，
      // 干净口径只由 1 个会话支撑 —— 报 n=378 会让一个 n=1 的数字看起来像结论。
      cache_hit_rate: metric(cacheAgg.hitRate, cacheAgg.cleanSessions, cacheAgg.source, "ratio"),
      turns_per_session: metric(mean(turns), turns.length, `${IDX}:turns`, "count"),
      compactions_per_session: metric(
        mean(compactions),
        compactions.length,
        `${IDX}:compactions`,
        "count",
      ),
    },
    cacheHitCaliber: buildCacheHitCaliber(cacheAgg),
    fewerRedos: {
      real_errors_per_session: metric(
        mean(realErrors),
        realErrors.length,
        `${IDX}:real_errors（仅有终态会话）`,
        "count",
      ),
      pathological_session_rate: metric(
        settled.length > 0 ? pathologicalCount / settled.length : null,
        settled.length,
        `${IDX}:pathological（仅有终态会话）`,
        "ratio",
      ),
    },
    foundation: {
      defense_trigger_rate: metric(
        index.length > 0 ? defenseCount / index.length : null,
        index.length,
        `${IDX}:defense_triggered`,
        "ratio",
      ),
      traj_corrupt_rate: metric(
        index.length > 0 ? corruptCount / index.length : null,
        index.length,
        `${IDX}:traj_corrupt`,
        "ratio",
      ),
      rows_without_version: rowsWithoutVersion,
    },
    assertions: [],
  };

  snapshot.assertions = buildAssertions(snapshot);
  return snapshot;
}

/**
 * 把公共聚合器的清洗账搬进快照结构。
 *
 * 单独一个函数只为一件事：**字段与聚合器一一对应**。以前这类"顺手在 return 里
 * 展开一下"的写法，是漏字段最常见的形态 —— 漏掉的那项在 JSON 里就是不存在，
 * 而读 JSON 的人分不清"没排除"和"没记录"。
 */
function buildCacheHitCaliber(agg: CacheHitAggregate): NorthstarSnapshot["cacheHitCaliber"] {
  return {
    cleanPromptTotal: agg.cleanPromptTotal,
    cleanCacheHit: agg.cleanCacheHit,
    hitRateIncludingLegacy: agg.hitRateIncludingLegacy,
    legacyHitRate: agg.legacyHitRate,
    duplicateRows: agg.excluded.duplicateRows,
    untrustedRows: agg.excluded.untrustedRows,
    rowsWithoutHost: agg.excluded.rowsWithoutHost,
    legacyRows: agg.excluded.legacyRows,
    countedSessions: agg.countedSessions,
  };
}

/**
 * 一致性断言（P2-13 第 2 条 + 口径自洽）。
 *
 * 这些断言不是"数据校验"，而是**口径自证**：它们检查的是不同数据源之间必然成立的
 * 结构关系。任一条失败说明某一侧漏采 —— 那是真缺陷，比指标本身的数值更值得看。
 */
export function buildAssertions(s: NorthstarSnapshot): NorthstarSnapshot["assertions"] {
  const out: NorthstarSnapshot["assertions"] = [];
  const d = s.denominators;

  // 有 API 调用的一定有轨迹，反之不然（有轨迹的会话可能一次 API 都没调）。
  // ⚠ 只在两边都非空时判：账本或轨迹任一为空（新机器 / CI runner）时这条恒成立或恒失败，
  // 都不携带信息，报 skip 比报 pass 诚实。
  if (d.ledgerSessions > 0 && d.trajValidSessions > 0) {
    out.push({
      name: "账本会话数 >= 轨迹有效会话数",
      ok: d.ledgerSessions >= d.trajValidSessions,
      detail: `账本 ${d.ledgerSessions} vs 轨迹有效 ${d.trajValidSessions}`,
    });
  }

  // 索引不受 LRU 影响，所以它**必然 >=** 盘上还剩的轨迹目录数。
  // 若反过来，说明索引写入漏了（只挂 SessionEnd 那个坑的形态：实测 55:25，
  // 30 个会话没有终态 → 只挂 SessionEnd 等于放弃 54.5% 的样本）。
  if (d.indexSessions > 0 && d.trajValidSessions > 0) {
    out.push({
      name: "索引会话数 >= 轨迹有效会话数（索引不受 LRU 影响）",
      ok: d.indexSessions >= d.trajValidSessions,
      detail: `索引 ${d.indexSessions} vs 轨迹有效 ${d.trajValidSessions}`,
    });
  }

  // 端到端必然 >= 首字节。违反说明两个口径的基准点不一致 —— 这个不变量比数值本身
  // 更值得断言（TTFT 曾因基准不重设而虚高数十秒，形态就是这条会红）。
  const e2e = s.faster.e2e_p50.value;
  const ttft = s.faster.ttft_p50.value;
  if (e2e !== null && ttft !== null) {
    out.push({
      name: "端到端 p50 >= 首字节 p50",
      ok: e2e >= ttft,
      detail: `e2e ${(e2e / 1000).toFixed(1)}s vs ttft ${(ttft / 1000).toFixed(1)}s`,
    });
  }

  // 命中率的样本量必须**等于**干净口径的分母所覆盖的会话数。
  //
  // 这条不是数据校验，是接线自证：`cache_hit_rate.n` 以前写的是账本总行数
  // （实测 378），而真正贡献那个比值的只有 1 个会话 —— 一个 n=1 的数字被标成 n=378，
  // 于是它在版本对比里绕过了"样本不足"护栏（阈值 20），能算出几十个百分点的
  // "改善"写进 release note。断言它与 `cleanPromptTotal>0` 自洽，能拦住这类回归。
  // ⚠ 只在账本非空时判：空账本（新机器 / CI runner）上这条恒成立，不携带信息 ——
  // 报 skip 比报 pass 诚实，与上面两条断言同一处理（"0 条断言的全绿是假绿"）。
  if (s.cacheHitCaliber.countedSessions > 0) {
    const hitN = s.cheaper.cache_hit_rate.n;
    const hasCleanDenominator = s.cacheHitCaliber.cleanPromptTotal > 0;
    out.push({
      name: "缓存命中率的 n 与干净口径分母自洽（不虚报样本量）",
      ok: hasCleanDenominator ? hitN > 0 : hitN === 0,
      detail: hasCleanDenominator
        ? `干净分母 ${s.cacheHitCaliber.cleanPromptTotal} token，n=${hitN}`
        : `无干净样本（分母 0），n=${hitN}（应为 0）`,
    });
  }

  return out;
}

// ─────────────────────────────────────────────────────────────
// 版本间对比
// ─────────────────────────────────────────────────────────────

export interface MetricDelta {
  key: string;
  before: number | null;
  after: number | null;
  /** 相对变化（after/before - 1）。任一侧缺失或 before=0 时为 null */
  deltaRatio: number | null;
  nBefore: number;
  nAfter: number;
  /** 单位，用于渲染。与 Metric.unit 同源 —— 渲染层不该猜某个数字是毫秒还是美元 */
  unit: Metric["unit"];
  /**
   * 是否**样本量太小、不足以下结论**。
   *
   * 判据 n < 20：这不是统计显著性检验（那需要方差，而分位数的方差要 bootstrap），
   * 而是一条粗但诚实的护栏 —— 与其给出一个看似精确的 p 值，不如明确说"样本不够"。
   * 缺了它，两个 n=3 的快照之间会算出 40% 的"改善"，然后被写进 release note。
   */
  underpowered: boolean;
}

/**
 * 主指标扁平化的取数路径。加新指标时**同时**加到这里，否则对比里静默缺一项。
 *
 * 由 `northstar-snapshot.test.ts` 断言"每个方向至少有一项进了对比表" ——
 * 加了指标忘了加对比是静默失效，不会有任何东西报错。
 */
const COMPARE_KEYS: Array<[string, (s: NorthstarSnapshot) => Metric]> = [
  ["更快 · 端到端 p50", (s) => s.faster.e2e_p50],
  ["更快 · 端到端 p95", (s) => s.faster.e2e_p95],
  ["更快 · 首字节 p50", (s) => s.faster.ttft_p50],
  ["更省 · 单会话成本", (s) => s.cheaper.cost_per_session],
  ["更省 · 缓存命中率", (s) => s.cheaper.cache_hit_rate],
  ["更省 · 单会话轮数", (s) => s.cheaper.turns_per_session],
  ["更少返工 · 单会话真错误", (s) => s.fewerRedos.real_errors_per_session],
  ["更少返工 · 病态会话率", (s) => s.fewerRedos.pathological_session_rate],
  ["底座 · 防线触发率", (s) => s.foundation.defense_trigger_rate],
  ["底座 · 轨迹损坏率", (s) => s.foundation.traj_corrupt_rate],
];

/** 低于此样本量的对比一律标 ⚠ 不下结论。见 MetricDelta.underpowered */
export const MIN_SAMPLES_FOR_CONCLUSION = 20;

export function compareSnapshots(
  before: NorthstarSnapshot,
  after: NorthstarSnapshot,
): MetricDelta[] {
  return COMPARE_KEYS.map(([key, pick]) => {
    const b = pick(before);
    const a = pick(after);
    const deltaRatio =
      b.value !== null && a.value !== null && b.value !== 0 ? a.value / b.value - 1 : null;
    return {
      key,
      before: b.value,
      after: a.value,
      deltaRatio,
      nBefore: b.n,
      nAfter: a.n,
      unit: a.unit,
      underpowered: b.n < MIN_SAMPLES_FOR_CONCLUSION || a.n < MIN_SAMPLES_FOR_CONCLUSION,
    };
  });
}

// ─────────────────────────────────────────────────────────────
// 渲染
// ─────────────────────────────────────────────────────────────

/**
 * 按单位格式化一个取值。`null` 一律渲染成 `—` 而不是 `0` ——
 * 「没有样本」与「测出来是 0」在每一个指标上都是相反的结论。
 */
export function fmtValue(value: number | null, unit: Metric["unit"]): string {
  if (value === null) return "—";
  switch (unit) {
    case "ms":
      return `${(value / 1000).toFixed(1)}s`;
    case "usd":
      return `$${value.toFixed(4)}`;
    case "ratio":
      return `${(value * 100).toFixed(1)}%`;
    case "count":
      return value.toFixed(1);
  }
}

function fmt(m: Metric): string {
  return fmtValue(m.value, m.unit);
}

/**
 * 渲染缓存命中率的清洗账（缩进在命中率那一行下面）。
 *
 * **无条件输出**，不做"有排除才打印"的裁剪：这个数现在是干净口径，与本次修复之前
 * 落盘的历史快照不可直接比较。任何一行都省掉的话，读者手里就只剩一个裸百分比，
 * 而那正是「luna 命中率 2.2% → 判定网关不支持前缀缓存」那个错误结论的成因。
 */
export function renderCacheHitCaliber(s: NorthstarSnapshot): string[] {
  const c = s.cacheHitCaliber;
  const L: string[] = [];
  L.push(
    `    口径: 已按 sessionId 去重 ${c.duplicateRows} 行 · ` +
      `排除 untrusted 渠道 ${c.untrustedRows} 行 · ` +
      `排除无版本标记存量行 ${c.legacyRows} 行`,
  );
  L.push(
    `    对照: 含存量的旧口径 ${fmtValue(c.hitRateIncludingLegacy, "ratio")} · ` +
      `存量行自身 ${fmtValue(c.legacyHitRate, "ratio")}` +
      `（两者与上面的干净口径相差无几 = 存量不脏或排除没生效，都要看一眼）`,
  );
  // 排除数为 0 时也要说 —— 见函数注释。这条盲区在 excludedUntrustedRows=0 时最危险。
  if (c.rowsWithoutHost > 0) {
    L.push(
      `    ⚠ 其中 ${c.rowsWithoutHost} 行无 endpointHost（账本 2026-08-08 前不记），` +
        `未参与可信度判定 —— 干净口径里可能仍混有不可信渠道的数字`,
    );
  }
  return L;
}

export function renderSnapshot(s: NorthstarSnapshot): string {
  const L: string[] = [];
  L.push(`北极星指标快照  v${s.appVersion}  生成于 ${s.generatedAt}`);
  L.push(`聚合窗口: ${s.windowDays === null ? "全量" : `最近 ${s.windowDays} 天`}`);
  // scope 必须打在最显眼处：一份混着 20 个历史版本的快照和一份只含本版数据的快照，
  // 数字长得一样但含义完全不同。不写出来，读者无从判断手里这份能不能用来做版本对比。
  L.push(
    s.scope === "version"
      ? `数据范围: 仅 v${s.appVersion} 产生的行（可用于版本对比）`
      : `数据范围: 窗口内**所有版本**的行（v${s.appVersion} 只是生成者）—— 不可用于版本对比`,
  );
  L.push("");

  // P2-13：三个分母固定打印在最前面。任何覆盖率都必须标注用的是哪个 ——
  // 分子分母取自不同源会算出荒谬结果，而这三个数互不一致是**口径不同**、不是 bug。
  L.push("会话数的三个口径（互不一致是正常的，口径不同）:");
  L.push(
    `  active-sessions/      ${s.denominators.activeSessions}  进程级会话（含从未调 LLM 的），无 LRU`,
  );
  L.push(
    `  trajectories/sessions ${s.denominators.trajValidSessions}  有轨迹且含 events.jsonl，受 LRU=100 管辖`,
  );
  L.push(`  usage-ledger.jsonl    ${s.denominators.ledgerSessions}  有真实 API 调用，无清理`);
  L.push(
    `  session-index.jsonl   ${s.denominators.indexSessions}  指标索引，不受 LRU 影响（跨版本对比只能用这个）`,
  );
  L.push("");

  const row = (label: string, m: Metric) =>
    `  ${label.padEnd(18)} ${fmt(m).padStart(9)}   n=${String(m.n).padStart(4)}   ${m.source}`;

  L.push("更快（延迟）:");
  L.push(row("端到端 p50", s.faster.e2e_p50));
  L.push(row("端到端 p95", s.faster.e2e_p95));
  L.push(row("首字节 p50", s.faster.ttft_p50));
  L.push(row("首字节 p95", s.faster.ttft_p95));
  if (s.faster.e2e_p50.n === 0) {
    // 明说而不是留个 "—"：PR-4 之前的轨迹没有 TurnComplete，这里空是**预期**，
    // 不说清楚会被当成"埋点坏了"去查。
    L.push("  （端到端 n=0：该窗口内的会话由无 TurnComplete 埋点的版本产生，属预期）");
  }
  L.push("");

  L.push("更省（成本 / 缓存 / 上下文）:");
  L.push(row("单会话成本", s.cheaper.cost_per_session));
  L.push(row("缓存命中率", s.cheaper.cache_hit_rate));
  // 命中率的清洗账必须紧跟在那一行下面，且**排除量为 0 时也要说**。
  //
  // 两个理由：① 这个数现在是干净口径，与历史快照里的脏口径不可直接比较，不写清楚
  // 会有人把一次口径修复读成一次真实跃升；② "已排除 0 行"读起来像"总计干净"，
  // 而真相往往是脏数据没带标签所以排不掉（机制上线 ≠ 数据被治理）。
  L.push(...renderCacheHitCaliber(s));
  L.push(row("单会话轮数", s.cheaper.turns_per_session));
  L.push(row("单会话压缩数", s.cheaper.compactions_per_session));
  L.push("");

  L.push("更少返工:");
  L.push(row("单会话真错误", s.fewerRedos.real_errors_per_session));
  L.push(row("病态会话率", s.fewerRedos.pathological_session_rate));
  L.push("");

  L.push("底座（可度量）:");
  L.push(row("防线触发率", s.foundation.defense_trigger_rate));
  L.push(row("轨迹损坏率", s.foundation.traj_corrupt_rate));
  if (s.foundation.rows_without_version > 0) {
    L.push(
      `  ⚠ ${s.foundation.rows_without_version} 行无版本标记，无法参与版本对比（刻意不回填：` +
        `只能靠 mtime 猜，猜错比留空更糟）`,
    );
  }
  L.push("");

  L.push("一致性断言:");
  if (s.assertions.length === 0) {
    L.push("  （无可判定的断言：数据源为空，报 skip 比报 pass 诚实）");
  }
  for (const a of s.assertions) {
    L.push(`  ${a.ok ? "✅" : "❌"} ${a.name}  —— ${a.detail}`);
  }

  return L.join("\n");
}

export function renderComparison(
  beforeVer: string,
  afterVer: string,
  deltas: MetricDelta[],
): string {
  const L: string[] = [];
  L.push(`版本间对比  v${beforeVer} → v${afterVer}`);
  // 三条禁令之三：只报告不阻断。指标退步需要人判断（可能是采样变了、可能是新功能的
  // 合理代价），自动拦发版会逼人加 --skip 绕过，最后连报告都不看了。
  L.push("（只报告，不阻断发版）");
  L.push("");
  for (const d of deltas) {
    const pct =
      d.deltaRatio === null
        ? "—"
        : `${d.deltaRatio >= 0 ? "+" : ""}${(d.deltaRatio * 100).toFixed(1)}%`;
    const warn = d.underpowered ? `  ⚠ 样本不足(n=${d.nBefore}/${d.nAfter})，不足以下结论` : "";
    L.push(
      `  ${d.key.padEnd(24)} ${fmtValue(d.before, d.unit).padStart(10)} → ` +
        `${fmtValue(d.after, d.unit).padStart(10)}  ${pct.padStart(8)}${warn}`,
    );
  }
  return L.join("\n");
}

/**
 * P0-3：生成带时间戳与样本量的 markdown 块。
 *
 * 时间戳是这一整节的**核心**，不是装饰：现状数字腐烂看不出来才是三次漂移的根因。
 * 块里带 `生成于 <ISO>`，读者一眼能看出新鲜度；`--check-staleness` 靠同一行做机械校验。
 *
 * ⚠ 必须点破的现实约束：方案文档与路线图在 `docs-research/`，**不在 sid-code 仓库内**，
 * 所以 pre-push 门禁管不到它们。跨仓库门禁做不了 —— 生成块自带时间戳是唯一可行的
 * 防漂移手段。这是本项无法完全机制化的部分，写出来而不是假装解决了。
 */
export function renderMarkdown(s: NorthstarSnapshot): string {
  const L: string[] = [];
  L.push(
    `${MARKDOWN_BEGIN} 由 scripts/northstar-snapshot.ts 生成于 ${s.generatedAt}（v${s.appVersion}），勿手改 -->`,
  );
  L.push("");
  L.push("| 方向 | 主指标 | 当前值 | 样本 n | 数据源 |");
  L.push("|---|---|---|---|---|");
  const r = (dir: string, name: string, m: Metric) =>
    `| ${dir} | ${name} | ${fmt(m)} | ${m.n} | \`${m.source}\` |`;
  L.push(r("更快", "端到端 p50", s.faster.e2e_p50));
  L.push(r("更快", "端到端 p95", s.faster.e2e_p95));
  L.push(r("更快", "首字节 p50", s.faster.ttft_p50));
  L.push(r("更省", "单会话成本", s.cheaper.cost_per_session));
  L.push(r("更省", "缓存命中率", s.cheaper.cache_hit_rate));
  L.push(r("更少返工", "单会话真错误", s.fewerRedos.real_errors_per_session));
  L.push(r("更少返工", "病态会话率", s.fewerRedos.pathological_session_rate));
  L.push(r("底座", "防线触发率", s.foundation.defense_trigger_rate));
  L.push(r("底座", "轨迹损坏率", s.foundation.traj_corrupt_rate));
  L.push("");
  L.push(
    `会话数三个口径：active ${s.denominators.activeSessions} / 轨迹有效 ${s.denominators.trajValidSessions} / ` +
      `账本 ${s.denominators.ledgerSessions} / 索引 ${s.denominators.indexSessions}。` +
      `任何覆盖率必须标注用的是哪个分母。`,
  );
  L.push("");
  L.push(MARKDOWN_END);
  return L.join("\n");
}

// ─────────────────────────────────────────────────────────────
// 快照目录：找上一版 + 写 delta
// ─────────────────────────────────────────────────────────────

/** 语义化版本比较（只认 x.y.z 三段数字，非法段按 0 处理） */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/**
 * 在快照目录里找**严格早于** `currentVersion` 的最近一版。
 *
 * 按语义化版本排序而不是文件 mtime：mtime 会因为重跑、拷贝、git checkout 而乱序，
 * 而"上一个 release"是版本号语义上的概念。用 mtime 排会在补跑历史快照时把
 * "上一版"认成刚写的那个新文件，算出一个自己跟自己的 0% diff。
 */
export function findPreviousSnapshot(
  dir: string,
  currentVersion: string,
): { version: string; snapshot: NorthstarSnapshot } | null {
  try {
    if (!existsSync(dir)) return null;
    const candidates: Array<{ version: string; file: string }> = [];
    for (const f of readdirSync(dir)) {
      const m = f.match(/^v(\d+\.\d+\.\d+)\.json$/);
      if (!m) continue;
      if (compareSemver(m[1], currentVersion) >= 0) continue; // 严格早于
      candidates.push({ version: m[1], file: join(dir, f) });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => compareSemver(b.version, a.version));
    const pick = candidates[0];
    const parsed = JSON.parse(readFileSync(pick.file, "utf-8")) as NorthstarSnapshot;
    return { version: pick.version, snapshot: parsed };
  } catch {
    // 读不出上一版就当没有上一版：这条路径上"没有对比对象"与"对比对象坏了"
    // 的正确处理完全相同 —— 都不该阻断，也都不该编一个 0% 出来。
    return null;
  }
}

/**
 * 渲染 `latest-delta.md`。
 *
 * **首次发版（无上一版）时必须输出"基线已建立，无对比对象"** —— 不是崩溃，
 * 也不是报 0%。报 0% 是这里最容易犯的错：它会被读成"本版与上版持平"，
 * 而真相是"上版不存在"。两者在 release note 里的含义完全相反。
 */
export function renderDeltaMarkdown(
  current: NorthstarSnapshot,
  previous: { version: string; snapshot: NorthstarSnapshot } | null,
): string {
  const L: string[] = [];
  L.push(`# 北极星指标 · v${current.appVersion}`);
  L.push("");
  L.push(`生成于 ${current.generatedAt}`);
  L.push(
    current.scope === "version"
      ? `数据范围：仅 v${current.appVersion} 产生的行`
      : `⚠ 数据范围：窗口内**所有版本**的行 —— 本文件的 diff 不代表版本间差异`,
  );
  L.push("");

  if (!previous) {
    L.push("## 无对比对象");
    L.push("");
    L.push(
      `**基线已建立**（v${current.appVersion}），此前没有快照可比。` +
        `下一次发版起会在这里给出逐指标 diff。`,
    );
    L.push("");
    L.push("> 这里刻意不显示 0% —— 「与上版持平」和「上版不存在」在结论上完全相反。");
  } else {
    L.push(`## 与 v${previous.version} 的对比`);
    L.push("");
    L.push("| 指标 | 上版 | 本版 | 变化 | 样本 n |");
    L.push("|---|---|---|---|---|");
    for (const d of compareSnapshots(previous.snapshot, current)) {
      const pct =
        d.deltaRatio === null
          ? "—"
          : `${d.deltaRatio >= 0 ? "+" : ""}${(d.deltaRatio * 100).toFixed(1)}%`;
      const nCell = d.underpowered
        ? `${d.nBefore}/${d.nAfter} ⚠ 样本不足`
        : `${d.nBefore}/${d.nAfter}`;
      L.push(
        `| ${d.key} | ${fmtValue(d.before, d.unit)} | ${fmtValue(d.after, d.unit)} | ${pct} | ${nCell} |`,
      );
    }
    L.push("");
    L.push(
      `> ⚠ 标记「样本不足」的行样本量低于 ${MIN_SAMPLES_FOR_CONCLUSION}，**不足以下结论** —— ` +
        `两个 n=3 的快照之间能算出几十个百分点的"改善"，那是噪声不是收益。`,
    );
  }

  L.push("");
  L.push("## 会话数的三个口径（P2-13）");
  L.push("");
  L.push(
    `active ${current.denominators.activeSessions} / 轨迹有效 ${current.denominators.trajValidSessions} / ` +
      `账本 ${current.denominators.ledgerSessions} / 索引 ${current.denominators.indexSessions}`,
  );
  L.push("");
  L.push("三个数互不一致是**口径不同**，不是 bug。任何覆盖率必须标注用的是哪个分母。");
  L.push("");
  L.push("## 一致性断言");
  L.push("");
  if (current.assertions.length === 0) {
    L.push("（无可判定的断言：数据源为空）");
  }
  for (const a of current.assertions) {
    L.push(`- ${a.ok ? "✅" : "❌"} ${a.name} —— ${a.detail}`);
  }
  return L.join("\n") + "\n";
}

// ─────────────────────────────────────────────────────────────
// 陈旧检测（P0-3 B）
// ─────────────────────────────────────────────────────────────

export interface StalenessResult {
  /** 找到生成块了吗。找不到时**不算陈旧** —— 见下方 stale 字段注释 */
  found: boolean;
  generatedAt?: string;
  ageDays?: number;
  stale: boolean;
  message: string;
}

/**
 * 检查文本里的生成块是否超过 `maxAgeDays` 天。
 *
 * **找不到块时返回 `stale: false`**（不拦）。理由：门禁的职责是"拦住带着三个月前的数字
 * 去 push"，而不是"强制每个文件都必须有生成块"。找不到就拦会让这个 hook 在任何不相关的
 * 文件上误报，人会直接卸掉它 —— 一个被卸掉的门禁比没有门禁更糟（它还给人虚假的安全感）。
 *
 * 时间戳解析失败则**判为陈旧**（fail-closed）：块在但读不出时间，正是"有人手改了它"
 * 的形态，此时放行等于让手改绕过门禁。
 */
export function checkStaleness(text: string, maxAgeDays: number, now: Date): StalenessResult {
  const idx = text.indexOf(MARKDOWN_BEGIN);
  if (idx < 0) {
    return { found: false, stale: false, message: "未找到 NORTHSTAR 生成块（不拦）" };
  }
  const line = text.slice(idx, text.indexOf("-->", idx) + 3);
  const m = line.match(/生成于\s*(\S+?)（/) ?? line.match(/生成于\s*(\S+)/);
  if (!m) {
    return {
      found: true,
      stale: true,
      message: "生成块存在但读不出时间戳 —— 疑似被手改，按陈旧处理（fail-closed）",
    };
  }
  const ts = Date.parse(m[1]);
  if (Number.isNaN(ts)) {
    return {
      found: true,
      generatedAt: m[1],
      stale: true,
      message: `时间戳无法解析: ${m[1]} —— 按陈旧处理（fail-closed）`,
    };
  }
  const ageDays = (now.getTime() - ts) / 86400_000;
  const stale = ageDays > maxAgeDays;
  return {
    found: true,
    generatedAt: m[1],
    ageDays,
    stale,
    message: stale
      ? `生成块已 ${ageDays.toFixed(1)} 天未更新（阈值 ${maxAgeDays} 天）。` +
        `重跑 bun scripts/northstar-snapshot.ts --emit-markdown 刷新`
      : `生成块新鲜（${ageDays.toFixed(1)} 天 <= ${maxAgeDays} 天）`,
  };
}

// ─────────────────────────────────────────────────────────────
// self-test（禁令之二：CI 里只做这个）
// ─────────────────────────────────────────────────────────────

/**
 * 用**合成数据**跑通全链路（聚合 → 断言 → 渲染 → 对比 → markdown → 陈旧检测）。
 *
 * CI runner 上没有 `~/.sid-code/`，所以**绝不能**在 CI 里聚合真实用量：那只会产出一份
 * n=0 的快照，而 n=0 的快照比没有快照更危险 —— 它看起来像数据，会被当成"这个版本的
 * 端到端是 0"。self-test 验的是"脚本本身没坏"，不是"这台机器的指标是多少"。
 *
 * 返回失败原因列表（空 = 全绿）。
 */
export function selfTest(): string[] {
  const errors: string[] = [];
  const now = new Date("2026-08-14T00:00:00.000Z");

  const mkIndex = (i: number, over: Partial<SessionIndexEntry> = {}): SessionIndexEntry => ({
    session_id: `s${i}`,
    ts: Math.floor(now.getTime() / 1000) - i,
    app_version: "0.1.600",
    model: "claude-opus-4-8",
    exit_status: "end_turn",
    duration_ms: 60_000,
    turns: 5,
    total_steps: 5,
    cost_usd: 0.1,
    tokens_sent: 1000,
    tokens_received: 200,
    ttft_p50: 3000,
    ttft_p95: 5000,
    ttft_n: 4,
    e2e_p50: 30_000,
    e2e_p95: 60_000,
    e2e_n: 1,
    real_errors: 0,
    anomalies_count: 0,
    pathological: [],
    compactions: 0,
    defense_triggered: false,
    traj_corrupt: false,
    ...over,
  });

  const mkLedger = (i: number, over: Partial<UsageLedgerEntry> = {}): UsageLedgerEntry => ({
    ts: Math.floor(now.getTime() / 1000) - i,
    sessionId: `s${i}`,
    model: "claude-opus-4-8",
    provider: "anthropic",
    promptTotal: 1000,
    cacheHit: 800,
    cacheWrite: 100,
    uncachedInput: 100,
    output: 200,
    costUSD: 0.1,
    savingsUSD: 0.05,
    durationMs: 60_000,
    appVersion: "0.1.600",
    ...over,
  });

  const index = Array.from({ length: 30 }, (_, i) => mkIndex(i));
  const ledger = Array.from({ length: 30 }, (_, i) => mkLedger(i));
  const denominators = {
    activeSessions: 60,
    trajValidSessions: 20,
    ledgerSessions: 30,
    indexSessions: 30,
  };

  const snap = buildSnapshot({
    data: { index, ledger },
    denominators,
    appVersion: "0.1.600",
    now,
  });

  // 聚合正确性
  if (snap.faster.e2e_p50.value !== 30_000) {
    errors.push(`e2e_p50 期望 30000，实得 ${snap.faster.e2e_p50.value}`);
  }
  if (snap.faster.e2e_p50.n !== 30) {
    errors.push(`e2e_p50 样本数期望 30，实得 ${snap.faster.e2e_p50.n}`);
  }
  // 命中率在 token 总量上算：800×30 ÷ 1000×30 = 0.8
  if (
    snap.cheaper.cache_hit_rate.value === null ||
    Math.abs(snap.cheaper.cache_hit_rate.value - 0.8) > 1e-9
  ) {
    errors.push(`缓存命中率期望 0.8，实得 ${snap.cheaper.cache_hit_rate.value}`);
  }
  // 合成数据全部带 appVersion 且 sessionId 互不相同 → 三层清洗**一行都不该排除**，
  // 干净口径与含存量口径必须相等。期望值仍是 0.8（清洗是恒等变换），
  // 所以上面那条断言无需改动 —— 这正是「口径变了但合成数据不脏」的正确形态。
  if (snap.cacheHitCaliber.legacyRows !== 0 || snap.cacheHitCaliber.duplicateRows !== 0) {
    errors.push(
      `合成数据不该有任何排除，实得 存量 ${snap.cacheHitCaliber.legacyRows} 行 / ` +
        `重复 ${snap.cacheHitCaliber.duplicateRows} 行`,
    );
  }
  if (snap.cheaper.cache_hit_rate.n !== 30) {
    // n 必须是**贡献了这个比值的会话数**，不是账本行数。以前写 ledger.length
    // 在这份合成数据上碰巧也是 30，所以这条得配下面那个"脏数据"场景才测得出。
    errors.push(`命中率样本数期望 30，实得 ${snap.cheaper.cache_hit_rate.n}`);
  }

  // 反向自证：掺入存量行与重复行，干净口径必须**不动**，而含存量口径必须被拉低。
  // 只验"干净数据上算得对"测不出清洗是否真的在做 —— 恒等变换也能让上面全绿。
  const dirty = buildSnapshot({
    data: {
      index,
      ledger: [
        ...ledger,
        // 无 appVersion = 2026-08-08 前采集代码写的，已知漏采 cacheHit
        mkLedger(100, {
          sessionId: "legacy",
          appVersion: undefined,
          promptTotal: 300_000,
          cacheHit: 0,
        }),
        // append 时代的残留：同一 sessionId 两行
        mkLedger(101, { sessionId: "dup", promptTotal: 1_000, cacheHit: 0 }),
        mkLedger(101, { sessionId: "dup", promptTotal: 1_000, cacheHit: 1_000 }),
      ],
    },
    denominators,
    appVersion: "0.1.600",
    now,
  });
  if (
    dirty.cheaper.cache_hit_rate.value === null ||
    Math.abs(dirty.cheaper.cache_hit_rate.value - (800 * 30 + 1_000) / (1_000 * 30 + 1_000)) > 1e-9
  ) {
    errors.push(
      `掺脏后干净口径应只含带版本的行（含去重后的 dup），实得 ${dirty.cheaper.cache_hit_rate.value}`,
    );
  }
  if (dirty.cacheHitCaliber.legacyRows !== 1) {
    errors.push(`反向自证：存量行应被排除 1 行，实得 ${dirty.cacheHitCaliber.legacyRows}`);
  }
  if (dirty.cacheHitCaliber.duplicateRows !== 1) {
    errors.push(`反向自证：重复行应被去重 1 行，实得 ${dirty.cacheHitCaliber.duplicateRows}`);
  }
  const incl = dirty.cacheHitCaliber.hitRateIncludingLegacy;
  if (incl === null || incl >= dirty.cheaper.cache_hit_rate.value!) {
    // 含存量口径必须**明显更低** —— 若两者相等说明排除没接上（这正是对照值存在的理由）
    errors.push(
      `反向自证：含存量口径应低于干净口径，实得 ${incl} vs ${dirty.cheaper.cache_hit_rate.value}`,
    );
  }

  // scope 必须如实反映"有没有按版本过滤"。写错会让一份混着历史版本的快照
  // 被当成某个版本的数据，delta 恒 +0.0%（实测踩过）。
  if (snap.scope !== "cumulative") {
    errors.push(`未给 onlyVersion 时 scope 应为 cumulative，实得 ${snap.scope}`);
  }
  const scoped = buildSnapshot({
    data: { index, ledger },
    denominators,
    appVersion: "0.1.600",
    onlyVersion: "0.1.600",
    now,
  });
  if (scoped.scope !== "version") {
    errors.push(`给了 onlyVersion 时 scope 应为 version，实得 ${scoped.scope}`);
  }
  // 反向自证：过滤一个不存在的版本必须得到 n=0，而不是静默回落到全量
  const otherVer = buildSnapshot({
    data: { index, ledger },
    denominators,
    appVersion: "9.9.9",
    onlyVersion: "9.9.9",
    now,
  });
  if (otherVer.faster.e2e_p50.n !== 0) {
    errors.push(`过滤不存在的版本应得 n=0，实得 ${otherVer.faster.e2e_p50.n} —— 版本过滤没生效`);
  }

  // 断言必须全绿，且必须真的产出了断言（0 条断言的"全绿"是假绿）
  if (snap.assertions.length === 0) {
    errors.push("self-test 未产出任何断言 —— 0 条断言的全绿是假绿");
  }
  for (const a of snap.assertions) {
    if (!a.ok) errors.push(`断言失败: ${a.name}（${a.detail}）`);
  }

  // P2-13 反向自证：构造违反场景（账本 < 轨迹有效），断言必须变红。
  // 只验"正常时全绿"是不够的 —— 那个测不出断言是否真的在判。
  const violated = buildSnapshot({
    data: { index, ledger },
    denominators: { ...denominators, ledgerSessions: 5, trajValidSessions: 50 },
    appVersion: "0.1.600",
    now,
  });
  const ledgerAssert = violated.assertions.find((a) => a.name.startsWith("账本会话数"));
  if (!ledgerAssert) errors.push("反向自证：违反场景下找不到账本一致性断言");
  else if (ledgerAssert.ok) errors.push("反向自证：账本 5 < 轨迹 50 时断言竟然通过了");

  // 口径自证反向：e2e < ttft 必须变红
  const badCaliber = buildSnapshot({
    data: { index: index.map((e) => ({ ...e, e2e_p50: 1000, ttft_p50: 5000 })), ledger },
    denominators,
    appVersion: "0.1.600",
    now,
  });
  const caliber = badCaliber.assertions.find((a) => a.name.startsWith("端到端 p50"));
  if (!caliber) errors.push("反向自证：找不到端到端/首字节口径断言");
  else if (caliber.ok) errors.push("反向自证：e2e 1s < ttft 5s 时口径断言竟然通过了");

  // 渲染不抛，且三个分母都出现在输出里（P2-13 的验收）
  try {
    const text = renderSnapshot(snap);
    for (const needle of [
      "active-sessions/",
      "trajectories/sessions",
      "usage-ledger.jsonl",
      "session-index.jsonl",
    ]) {
      if (!text.includes(needle)) errors.push(`渲染缺少分母定义: ${needle}`);
    }
  } catch (e) {
    errors.push(`renderSnapshot 抛错: ${(e as Error).message}`);
  }

  // 对比链路 + 样本不足护栏
  const after = buildSnapshot({
    data: {
      index: index.slice(0, 3).map((e) => ({ ...e, app_version: "0.1.601", e2e_p50: 20_000 })),
      ledger: ledger.slice(0, 3).map((e) => ({ ...e, appVersion: "0.1.601" })),
    },
    denominators,
    appVersion: "0.1.601",
    now,
  });
  const deltas = compareSnapshots(snap, after);
  const e2eDelta = deltas.find((d) => d.key === "更快 · 端到端 p50");
  if (!e2eDelta) errors.push("对比缺少端到端 p50 项");
  else {
    if (e2eDelta.deltaRatio === null) errors.push("对比未算出端到端 delta");
    // n=3 必须被标成样本不足 —— 否则两个 n=3 的快照会算出 33% 的"改善"写进 release note
    if (!e2eDelta.underpowered) errors.push("n=3 的对比未被标记为样本不足");
  }
  try {
    renderComparison("0.1.600", "0.1.601", deltas);
  } catch (e) {
    errors.push(`renderComparison 抛错: ${(e as Error).message}`);
  }

  // markdown + 陈旧检测双向（只测一侧会漏掉边界写反）
  const md = renderMarkdown(snap);
  if (!md.includes(MARKDOWN_BEGIN) || !md.includes(MARKDOWN_END)) {
    errors.push("markdown 块缺少定界标记");
  }
  const fresh = checkStaleness(md, 30, new Date("2026-09-01T00:00:00.000Z")); // 18 天
  if (fresh.stale) errors.push(`18 天的块被判陈旧（阈值 30）: ${fresh.message}`);
  const old = checkStaleness(md, 30, new Date("2026-10-01T00:00:00.000Z")); // 48 天
  if (!old.stale) errors.push(`48 天的块未被判陈旧（阈值 30）: ${old.message}`);
  const missing = checkStaleness("没有生成块的普通文档", 30, now);
  if (missing.stale) errors.push("无生成块的文本被判陈旧（应不拦）");

  return errors;
}

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

function argOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(): void {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));

  // 未识别 flag 必须**早退而不是仅告警** —— 见 KNOWN_FLAGS 注释里 --health 那个教训：
  // 继续跑下去输出的仍是"用户没要的那个视图"，与静默忽略在结果上没有区别。
  const unknown = [...flags].filter((f) => !KNOWN_FLAGS.has(f));
  if (unknown.length > 0) {
    process.stderr.write(
      `⚠ 未识别参数: ${unknown.join(" ")}\n可用参数: ${[...KNOWN_FLAGS].join(" ")}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const json = flags.has("--json");

  // ── self-test（CI 唯一该跑的模式）──
  if (flags.has("--self-test")) {
    const errors = selfTest();
    if (errors.length > 0) {
      process.stderr.write("❌ northstar-snapshot self-test 失败:\n");
      for (const e of errors) process.stderr.write(`  · ${e}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write("✅ northstar-snapshot self-test 通过（合成数据，未读真实用量）\n");
    return;
  }

  // ── 陈旧检测 ──
  if (flags.has("--check-staleness")) {
    const raw = argOf(args, "--check-staleness");
    const maxAgeDays = Number(raw);
    if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
      process.stderr.write(`⚠ --check-staleness 需要一个正数天数，实得: ${raw}\n`);
      process.exitCode = 1;
      return;
    }
    // 位置参数即待检查的文件。缺省时不拦（同 checkStaleness 找不到块的理由）。
    const file = args.filter((a) => !a.startsWith("--") && a !== raw)[0];
    if (!file || !existsSync(file)) {
      process.stdout.write(`（--check-staleness: 文件不存在或未指定，跳过不拦）\n`);
      return;
    }
    const res = checkStaleness(readFileSync(file, "utf-8"), maxAgeDays, new Date());
    process.stdout.write(`${res.stale ? "❌" : "✅"} ${file}: ${res.message}\n`);
    if (res.stale) process.exitCode = 1;
    return;
  }

  const windowDaysRaw = argOf(args, "--days");
  const windowDays = windowDaysRaw !== undefined ? Number(windowDaysRaw) : undefined;
  if (windowDaysRaw !== undefined && (!Number.isFinite(windowDays!) || windowDays! <= 0)) {
    process.stderr.write(`⚠ --days 需要一个正数，实得: ${windowDaysRaw}\n`);
    process.exitCode = 1;
    return;
  }

  // ── 版本间对比 ──
  if (flags.has("--compare")) {
    const i = args.indexOf("--compare");
    const beforeVer = args[i + 1];
    const afterVer = args[i + 2];
    if (!beforeVer || !afterVer || beforeVer.startsWith("--") || afterVer.startsWith("--")) {
      process.stderr.write("⚠ --compare 需要两个版本号: --compare <before> <after>\n");
      process.exitCode = 1;
      return;
    }
    const before = buildSnapshot({ onlyVersion: beforeVer, windowDays, appVersion: beforeVer });
    const after = buildSnapshot({ onlyVersion: afterVer, windowDays, appVersion: afterVer });
    const deltas = compareSnapshots(before, after);
    process.stdout.write(
      json
        ? JSON.stringify({ before, after, deltas }, null, 2) + "\n"
        : renderComparison(beforeVer, afterVer, deltas) + "\n",
    );
    return;
  }

  // ── 周报（§五.3 第二层的"本地"那一半）──
  //
  // ⚠ 必须诚实标注为「人工触发的自动化脚本」，不是全自动。
  // 把它写成"已自动化"就是 §六（P0-3）要防的那类漂移 —— 真实的周趋势需要
  // 维护者本机每周跑一次，因为 CI runner 上没有 ~/.sid-code/。
  if (flags.has("--weekly")) {
    const week = buildSnapshot({
      windowDays: windowDays ?? 7,
      appVersion: argOf(args, "--version"),
    });
    if (json) {
      process.stdout.write(JSON.stringify(week, null, 2) + "\n");
      return;
    }
    process.stdout.write("北极星周报（人工触发的自动化脚本，非全自动 —— CI 里拿不到本地数据）\n\n");
    process.stdout.write(renderSnapshot(week) + "\n");
    // 与上一版对比：周报的价值一半在"这周比上周"，而版本号是唯一的分组键。
    const prevVer = week.appVersion;
    const prev = findPreviousSnapshot("northstar", prevVer);
    if (prev) {
      process.stdout.write(
        "\n" +
          renderComparison(prev.version, prevVer, compareSnapshots(prev.snapshot, week)) +
          "\n",
      );
    } else {
      process.stdout.write(
        `\n（northstar/ 下无早于 v${prevVer} 的快照，无对比对象 —— 不是 0% 持平）\n`,
      );
    }
    return;
  }

  // ── 快照 ──
  const appVersion = argOf(args, "--version");
  // 给了 --version 就**只聚合那个版本的行**（scope=version）。
  //
  // 这一条是本脚本最容易写错的地方，实测踩过：若 --version 只做标签而不过滤，
  // `--version 0.1.601 --emit` 会写出一个标着 v0.1.601、实际混着全部历史版本的快照。
  // 后果是连续两次发版的 delta 恒等于 +0.0%（两份的主体都是同一批旧数据），
  // 读起来像"性能稳定"，真相是分组键失效 —— 正是本方案要消灭的那类假信号。
  const snap = buildSnapshot({ windowDays, appVersion, onlyVersion: appVersion });

  if (flags.has("--emit-markdown")) {
    process.stdout.write(renderMarkdown(snap) + "\n");
    return;
  }

  const emitDir = argOf(args, "--emit");
  if (emitDir) {
    try {
      // 上一版必须在写本版之前找 —— 反过来会把刚写的本版认成"上一版"，
      // 算出一个自己跟自己的 0% diff。
      const previous = findPreviousSnapshot(emitDir, snap.appVersion);
      mkdirSync(emitDir, { recursive: true });
      const out = join(emitDir, `v${snap.appVersion}.json`);
      writeFileSync(out, JSON.stringify(snap, null, 2) + "\n", "utf-8");
      const deltaOut = join(emitDir, "latest-delta.md");
      writeFileSync(deltaOut, renderDeltaMarkdown(snap, previous), "utf-8");
      process.stdout.write(`✅ 快照已写入 ${out}\n`);
      process.stdout.write(
        previous
          ? `✅ 对比已写入 ${deltaOut}（对比对象 v${previous.version}）\n`
          : `✅ 对比已写入 ${deltaOut}（首次快照：基线已建立，无对比对象）\n`,
      );
    } catch (e) {
      // 写盘失败**不**非零退出：本脚本被 release.sh 调用，而快照只是观测产物，
      // 绝不该因为它写不下去而中止一次发布（禁令之三的同一精神）。
      process.stderr.write(`⚠ 快照写入失败（不阻断）: ${(e as Error).message}\n`);
      return;
    }
  }

  if (json) {
    process.stdout.write(JSON.stringify(snap, null, 2) + "\n");
  } else if (!emitDir) {
    process.stdout.write(renderSnapshot(snap) + "\n");
  }
}

// 仅在被直接执行时跑 CLI（被 import 时只暴露纯函数，供测试与其它脚本复用）
if (import.meta.main) main();
