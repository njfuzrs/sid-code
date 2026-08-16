/**
 * cache-hit-aggregate.ts —— 缓存命中率聚合的**单一公共实现**
 *
 * ## 为什么需要这个模块：一套数据两个说法
 *
 * 命中率此前有**两个入口各写一份聚合**，读同一个 `usage-ledger.jsonl`、算同一个
 * 「cache_read ÷ 总 input」，却给出不同的数：
 *
 * | 入口 | 去重 | 排除 untrusted 渠道 | 排除无 appVersion 存量行 | 实测本机 |
 * |---|---|---|---|---|
 * | `trace/cache-report.ts`（/cache 视图） | ✅ | ✅ | ✅ | 76.4% |
 * | `scripts/northstar-snapshot.ts`（北极星曲线） | ❌ | ❌ | ❌ | 68.2% |
 *
 * 两个数字都自称「缓存命中率」，差 8.2 个百分点。北极星那份还是**进 release 曲线**
 * 的那个数 —— 也就是说四方向里「更省」这条线一直画在最脏的那份口径上。
 *
 * 光靠「以后记得两边都改」解决不了：清洗逻辑有三层（去重 / 渠道可信度 / 采集代码版本），
 * 每层都有自己的踩坑史（见下方各层注释），复制一份必然漂移。所以聚合收口到这里，
 * 两个入口都调它，**新增第三个消费方也只能调它**。
 *
 * ## 三层清洗，每层都不是可选项
 *
 * 1. **按 sessionId 去重**（`dedupeBySession`）：账本设计上每会话一行，但历史上有
 *    append 时代的多行残留。不去重 → 同一会话被累加多次。
 * 2. **排除 untrusted 渠道**：实测某月卡网关的 Anthropic usage 是**编造的**（全新前缀
 *    r1 就报大量 cache_read）。把伪造的「命中」混进去会凭空抬高整体数字，让"缓存做得好"
 *    这个结论建立在假数据上。判定是实测事实，读自 `channel-trust.json`。
 * 3. **排除无 `appVersion` 的存量行**：那批行是 2026-08-08 之前的采集代码写的，有两个
 *    已修的漏采缺陷（Responses API 缓存双漏采、savings 兜底）。实测同一模型同一渠道
 *    08-02 记 3.2%、08-09 记 81.1%，差异**全部**来自采集代码修复时点。混进总计会把
 *    命中率往下拉，读起来像"缓存没做好"。
 *
 * ## 一条铁律：排除必须可见
 *
 * 返回结构同时给出**干净口径**、**含存量的对照口径**、以及**每一层排除掉多少**。
 * 静默排除读起来像「全部数据都在这儿」，静默不排除读起来像「总计干净」——
 * 两种都是骗人。只报一个"已排除 N 行"而不给对照值同样不够：那分不清
 * 「存量数据本来就不脏」和「排除逻辑没接上」，而这两种情况都需要人看一眼。
 *
 * 数据源（只读）：`~/.sid-code/usage-ledger.jsonl` + `~/.sid-code/channel-trust.json`
 */

import { readUsageLedger, dedupeBySession, type UsageLedgerEntry } from "./usage-ledger.ts";
import {
  readChannelTrust,
  lookupChannelTrust,
  type ChannelTrustRegistry,
} from "./channel-trust.ts";

/**
 * 取数源字符串 —— 供消费侧的 `source` / `Metric.source` 字段**直接引用**。
 *
 * 为什么要导出成常量而不是让各消费方自己写：仓库铁律是「每个指标必须能指到源字段」，
 * 而清洗口径变了 source 串没跟着变，比不写 source 更糟 —— 它会让人以为这个数是
 * 裸账本除法的结果，从而拿它和别处的裸除法结果作对比。口径与描述必须同一处改。
 */
export const CACHE_HIT_SOURCE =
  "usage-ledger.jsonl:cacheHit÷promptTotal（按 sessionId 去重 · 排除 untrusted 渠道 · 排除无 appVersion 存量行）";

export interface CacheHitAggregateOptions {
  /** 只聚合最近 N 天；不传 = 全量 */
  windowDays?: number;
  /** 只聚合某个 `appVersion` 的行（版本间对比用） */
  onlyVersion?: string;
  /**
   * 注入账本行（测试 / self-test 用；不传则读真实盘）。
   * 传入的是**未去重的原始行**——去重由本函数负责，调用方不要自己先去重，
   * 否则 `excluded.duplicateRows` 恒为 0，那道防御是否生效就测不出来了。
   */
  entries?: UsageLedgerEntry[];
  /**
   * 注入渠道可信度登记表（不传则读真实盘）。
   *
   * 调用方已经为别的用途读过一次时应当传进来：读两次不只是浪费 IO，
   * 更会在两次读之间文件被改动时让「分行视图的 ⚠ 标注」与「总计的排除」
   * 依据不同的判定 —— 那正是本模块要消灭的那类不一致。
   */
  registry?: ChannelTrustRegistry;
  /** 当前时刻（时间窗基准）。**必须可注入**，否则结果不确定、测不了 */
  now?: Date;
}

/** 各层排除量。让「排除了什么」可见 —— 不要静默排除 */
export interface CacheHitExclusions {
  /** 去重掉的重复会话行数（>0 说明账本里有 append 时代的残留） */
  duplicateRows: number;
  /** 被判 untrusted 因而整行排除的会话行数 */
  untrustedRows: number;
  /** 上述被排除行的输入 token 数 */
  untrustedPromptTotal: number;
  /** 上述被排除行的命中 token 数 */
  untrustedCacheHit: number;
  /**
   * **无 `endpointHost` 因而无法参与可信度判定**的行数（可信渠道内）。
   *
   * 这些行按 unknown（= 可信）计入，但那不是"已确认可信"，而是"判不了"。
   * `endpointHost` 2026-08-08 才落地，之前的账本行一条都没有 host。
   *
   * ⚠️ 消费侧必须在 `untrustedRows === 0` 时也把这个数说出来，否则
   * "已排除 0 行"读起来像"总计干净"，而真相是脏数据没带标签所以排不掉。
   * 这正是本仓反复栽的跟头：**机制上线 ≠ 数据被治理**，中间隔着一段
   * 只有新数据才有字段的过渡期。
   */
  rowsWithoutHost: number;
  /** 无 `appVersion` 因而被判存量、排除出干净口径的行数（可信渠道内） */
  legacyRows: number;
  /** 上述存量行的输入 token 数 */
  legacyPromptTotal: number;
  /** 上述存量行的命中 token 数 */
  legacyCacheHit: number;
}

export interface CacheHitAggregate {
  /**
   * **干净口径**命中率 0~1；无干净样本时为 `null`。
   *
   * 全是存量数据时给 `null` 而**不回落**到含存量的数字：回落会让"这个总计是干净的"
   * 这个承诺在最需要它的场景下静默失效。`null` + 排除量能让人看出"暂时无可信样本"。
   */
  hitRate: number | null;
  /** 干净口径的分子分母（可复算 `hitRate`，也让"分母有多小"可见） */
  cleanPromptTotal: number;
  cleanCacheHit: number;
  /** 贡献了干净口径的会话行数 —— 消费侧的样本量 `n` 必须用这个，不是账本总行数 */
  cleanSessions: number;

  /**
   * **含存量行**的命中率 —— 仅供对照，不要拿它下结论。
   *
   * 它就是修复前 northstar 报的那个被拉低的数字。与 `hitRate` 并列输出，
   * 让"排除了多少脏数据"变成一个能看见的差值而不是一句承诺。
   */
  hitRateIncludingLegacy: number | null;
  /**
   * 存量行自己的命中率（可为 `null`）。
   *
   * 单独给出来是为了**自证排除真的生效了**：若它与 `hitRate` 相差无几，说明要么
   * 存量数据本来就不脏、要么排除逻辑没接上 —— 两种都需要人看一眼。只报一个
   * "已排除"计数而不给对照值，无法区分这两种情况。
   */
  legacyHitRate: number | null;
  /** 可信渠道内的全部会话行数（含存量）—— `hitRateIncludingLegacy` 的样本量 */
  countedSessions: number;
  /** 可信渠道内的全部分子分母（含存量） */
  countedPromptTotal: number;
  countedCacheHit: number;

  excluded: CacheHitExclusions;

  /**
   * 去重 + 时间窗 + 版本过滤之后的**全集**（仍含 untrusted 与存量行）。
   *
   * 导出它是为了让需要自己做分行视图的调用方（`trace/cache-report.ts` 要出
   * 「模型 × 渠道」分组）**在同一份行上**分组，而不是各自再读一次账本再各自去重 ——
   * 那样分行数字与总计数字就可能对不上，正是本模块要消灭的那类不一致。
   */
  entries: UsageLedgerEntry[];
  /** 本次聚合实际使用的可信度登记表（调用方可复用，避免二次读盘） */
  registry: ChannelTrustRegistry;
  /** 取数源描述，等同 {@link CACHE_HIT_SOURCE} */
  source: string;
}

/**
 * 聚合缓存命中率 —— **命中率口径的唯一实现**，全部消费方都必须走这里。
 *
 * 纯函数（数据可注入），无副作用、不写盘。
 */
export function aggregateCacheHit(opts: CacheHitAggregateOptions = {}): CacheHitAggregate {
  const now = opts.now ?? new Date();
  const registry = opts.registry ?? readChannelTrust();

  const raw = opts.entries ?? readUsageLedger();

  // ① 去重：账本设计上每会话一行，但历史上有 append 时代的多行残留。
  //    不去重 → 同一会话的 token 被累加多次，分子分母同时虚高且比值偏向重复的那几行。
  const deduped = dedupeBySession(raw);
  const duplicateRows = raw.length - deduped.length;

  // 时间窗与版本过滤 —— 这两条是 northstar（--weekly / --compare）独有的需求，
  // 但放在这里而不是留给调用方自己 filter：过滤必须发生在**去重之后、清洗之前**。
  // 顺序写错的后果不对称：先按窗口切再去重，会把窗口边界外的那次 upsert 当成
  // 「窗口内唯一的一行」而留下更早的脏值。
  let entries = deduped;
  if (opts.windowDays !== undefined) {
    const cutoff = Math.floor(now.getTime() / 1000) - opts.windowDays * 86400;
    entries = entries.filter((e) => e.ts >= cutoff);
  }
  if (opts.onlyVersion !== undefined) {
    entries = entries.filter((e) => e.appVersion === opts.onlyVersion);
  }

  let untrustedRows = 0;
  let untrustedPromptTotal = 0;
  let untrustedCacheHit = 0;
  let rowsWithoutHost = 0;
  let legacyRows = 0;
  let legacyPromptTotal = 0;
  let legacyCacheHit = 0;
  let countedPromptTotal = 0;
  let countedCacheHit = 0;
  let countedSessions = 0;

  for (const e of entries) {
    // 字段可能缺失或类型不对（账本容错读，损坏行只跳过 JSON 解析失败的那种），
    // 所以取值一律过一遍类型判断而不是直接相加 —— NaN 一旦进了累加器，
    // 整个比值变成 NaN 且没有任何报错，是最难查的一类脏数据。
    const prompt = typeof e.promptTotal === "number" ? e.promptTotal : 0;
    const hit = typeof e.cacheHit === "number" ? e.cacheHit : 0;

    // ② 渠道可信度：只有**明确判定为 untrusted** 才排除；unknown 计入。
    //    把没探测过的渠道一律排除会让绝大多数数据消失（host 字段是新加的），
    //    而那不是"更严谨"，是把指标变成空值。
    if (lookupChannelTrust(e.endpointHost, registry).verdict === "untrusted") {
      untrustedRows++;
      untrustedPromptTotal += prompt;
      untrustedCacheHit += hit;
      continue;
    }

    if (!e.endpointHost) rowsWithoutHost++;

    countedSessions++;
    countedPromptTotal += prompt;
    countedCacheHit += hit;

    // ③ 存量行判据是"字段缺失"而非任何版本号比较。
    //
    //    刻意不写 `if (e.appVersion < "0.1.601")` 这类比较：字符串比版本号会在
    //    0.1.99 vs 0.1.100 上排错，而语义化比较需要引一个解析器 —— 而这里真正要区分的
    //    只有一件事：**这行是不是用带修复的采集代码写的**。修复落地即开始写这个字段，
    //    所以"有没有字段"正好就是那条分界线，比任何数值比较都准。
    //
    //    只在可信渠道内累加：untrusted 的行上面已整行 continue 掉，再把它的存量份额
    //    算进"排除量"会重复计数，让"排除了多少"这个数字本身失真。
    if (!e.appVersion) {
      legacyRows++;
      legacyPromptTotal += prompt;
      legacyCacheHit += hit;
    }
  }

  const cleanPromptTotal = countedPromptTotal - legacyPromptTotal;
  const cleanCacheHit = countedCacheHit - legacyCacheHit;
  const cleanSessions = countedSessions - legacyRows;

  return {
    // 分母为 0 时给 null 而不是 0：没有分母就没有比率，落 0 会被读成"命中率 0%"
    hitRate: cleanPromptTotal > 0 ? cleanCacheHit / cleanPromptTotal : null,
    cleanPromptTotal,
    cleanCacheHit,
    cleanSessions,
    hitRateIncludingLegacy: countedPromptTotal > 0 ? countedCacheHit / countedPromptTotal : null,
    legacyHitRate: legacyPromptTotal > 0 ? legacyCacheHit / legacyPromptTotal : null,
    countedSessions,
    countedPromptTotal,
    countedCacheHit,
    excluded: {
      duplicateRows,
      untrustedRows,
      untrustedPromptTotal,
      untrustedCacheHit,
      rowsWithoutHost,
      legacyRows,
      legacyPromptTotal,
      legacyCacheHit,
    },
    entries,
    registry,
    source: CACHE_HIT_SOURCE,
  };
}
