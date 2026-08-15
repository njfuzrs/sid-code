/**
 * ttft-cache-buckets.ts —— TTFT × 缓存命中的分桶配对（P2-3 的单一事实源）
 *
 * 为什么单独成模块：方案 §P2-3 明写"消费侧 `digest.ts` 与 `provider-health.ts` 的
 * `ttfts: number[]` 改分桶，**两处必须同步改（刻意同口径）**"。第一版只改了 digest，
 * provider-health 仍是裸数组 —— 于是 `/trace --health` 与 `scripts/provider-health.ts`
 * 输出不带分桶，而验收表与博客都写着"`trace-digest --health` 输出 hit/miss 两组分位数"，
 * 指了个不存在的入口。
 *
 * 把配对逻辑放这里而不是在两处各写一遍，是因为**这段逻辑的正确性依赖三个易错约定**
 * （分组键含 agentId、数量不等整组丢弃、Anthropic 与 OpenAI 两条 emit 时机不同），
 * 抄第二遍必然漂移。同病见记忆 `message-fidelity-silent-block-drop`：
 * 手写字段列表与手写分派链同病，根治都是"收口到一处"。
 *
 * ── 两条 emit 时机（必须都吃，只吃一条会静默漏掉半个族）──
 * - **Anthropic**：usage 在 `message_start` 就到，`first_content` 事件**自带** `cache_hit`
 *   → 直接分桶，零配对风险。
 * - **OpenAI 族**：usage 只在流尾部下发，`first_content` 时刻拿不到命中数，维度挂在
 *   同一次 fetch 的 `completed` 事件上 → 需要配对。
 *
 * ── 配对规则刻意保守 ──
 * 只在同一 `(session, index, agent)` 内 `first_content` 与 `completed` 数量**相等**时
 * 按出现顺序一对一配。数量不等说明这轮有 fetch 没走到 completed（超时/abort/error），
 * 此时任何配法都可能把 A 次的 ttft 配到 B 次的命中状态上 —— 宁可整组丢弃并计入
 * `dropped`。`index` 与 usage 是 1:N（实测同会话 index=3 有 6 条 first_content 却只有
 * 1 条 AfterModelRaw、另一会话 index=4 有 18 条），按 index 硬关联会把一次命中的 usage
 * 摊给同轮所有 fetch，得出的"命中组 TTFT"是假的。
 *
 * ⚠️ 猜错命中状态会**直接反转**"缓存是否更快"这个结论，比没有数据更糟 ——
 * 所以这里的默认永远是丢弃 + 计数，不是猜。
 */

/** 一个 provider 的分桶结果 */
export interface TtftCacheBucket {
  /** 命中桶的 TTFT 样本（ms） */
  hit: number[];
  /** 未命中桶的 TTFT 样本（ms） */
  miss: number[];
  /**
   * 该组**有**命中维度但数量对不上、因而整组弃用的样本数（0 表示无此情况）。
   *
   * 这是真正需要注意的信号：说明有 fetch 没走到 completed（超时/abort/error）。
   * 与 {@link noDimension} 严格分开 —— 见那个字段的注释。
   */
  dropped: number;
  /**
   * 该组的 completed 事件**完全不带** `cache_hit` 而未进桶的样本数。
   *
   * 成因是**老轨迹**：`cache_hit` 维度 2026-08-08 才随 P2-3 上线，之前的会话
   * 根本没有这个字段。实测本机 7 天窗口内 512 个这类样本全部来自 08-08 16:12
   * 之前的会话，之后的 8 个会话覆盖率 100%。
   *
   * ⚠️ **必须与 `dropped` 分开计数**：把两者合并会让"这批数据还没有这个维度"
   * 显示成"命中状态无法判定"，读起来像埋点坏了 —— 而它其实是预期的历史空档。
   * 这正是本仓库反复踩的那个坑的同类：**"不知道"与"知道且为某值"是两件事**
   *（见 `stream-observer.ts:36-39` 关于不落假 `cache_hit:false` 的同一条理由）。
   */
  noDimension: number;
  /**
   * P2-8：该 provider 观察到的 `first_content` 样本总数（= 进桶 + 弃用 + 历史空档）。
   *
   * 存在的唯一理由是**让分母可对账**：不落这个字段时，唯一能和分桶 n 并排看的数字
   * 就是看板上的「请求」列，而那一列数的是 `AfterModelRaw`（**每轮一条**），
   * 分桶 n 数的是 `first_content`（**每次 fetch 一条**）—— 两者单位不同。
   * 实测本机 7 天窗口：anthropic 30 轮却有 39 条 first_content（4 轮里发生了重试，
   * 分别是 4/1、3/1、3/1、3/1），于是看板显示「30 请求 · 命中 n=39」，
   * 子集看起来大于全集。
   *
   * 不变量：`total === hit.length + miss.length + dropped + noDimension`
   *（`ttft-cache-buckets.test.ts` 与 `provider-health.test.ts` 两侧都断言它）。
   */
  total: number;
}

/** 事件的最小形状 —— 两个消费方的事件类型不同，这里只约束用到的字段 */
interface BucketableEvent {
  event?: string;
  session_id?: string;
  data?: Record<string, unknown>;
}

/**
 * 配对分组键。**必须含 agent_id**：子代理与主循环的事件共享 index 空间
 *（`stream-observer.ts` 的 B4 注释即为此加了 agentId），不分开会把子代理的
 * ttft 配到主循环的命中状态上。
 */
function bucketKey(e: BucketableEvent): string {
  const sid = e.session_id ?? (e.data?.session_id as string | undefined) ?? "";
  const idx = e.data?.index ?? "";
  const agent = e.data?.agent_id ?? "main";
  return `${sid}|${idx}|${agent}`;
}

/**
 * TTFT 分桶累加器。用法（两个消费方一致）：
 *
 * ```ts
 * const bucketer = new TtftCacheBucketer();
 * for (const e of events) {
 *   // first_content 分支里，拿到 provider 与 ttft 后：
 *   bucketer.observeFirstContent(e, provider, ttft);
 *   // completed 分支里：
 *   bucketer.observeCompleted(e);
 * }
 * const buckets = bucketer.finalize();  // Map<provider, TtftCacheBucket>
 * ```
 *
 * `finalize()` 必须在**遍历完所有事件之后**调用 —— completed 事件可能出现在
 * first_content 之后（正常）也可能因写入乱序而更早，边遍历边配对会漏掉后到的那一半。
 */
export class TtftCacheBucketer {
  private buckets = new Map<string, TtftCacheBucket>();
  /** key → 该组待配对的 ttft（按事件出现顺序） */
  private pendingTtft = new Map<string, number[]>();
  /** key → 该组的命中状态（按事件出现顺序） */
  private pendingHit = new Map<string, boolean[]>();
  /** key → provider（first_content 只带 model，provider 由调用方解析后传入） */
  private pendingProvider = new Map<string, string>();
  /** key → 该组见过多少条**不带** cache_hit 的 completed（区分老轨迹 vs 配对失败） */
  private dimensionlessCompleted = new Map<string, number>();
  private finalized = false;

  private ensure(provider: string): TtftCacheBucket {
    let b = this.buckets.get(provider);
    if (!b) {
      b = { hit: [], miss: [], dropped: 0, noDimension: 0, total: 0 };
      this.buckets.set(provider, b);
    }
    return b;
  }

  private static push<T>(m: Map<string, T[]>, k: string, v: T): void {
    const arr = m.get(k);
    if (arr) arr.push(v);
    else m.set(k, [v]);
  }

  /**
   * 观察一条 `first_content` 事件。
   *
   * @param provider 调用方已解析好的 provider（first_content 事件只带 model）
   * @param ttft     首内容延迟（ms），调用方需自行保证 > 0
   */
  observeFirstContent(e: BucketableEvent, provider: string, ttft: number): void {
    // P2-8：先记分母。放在两条分支**之前**，因为 total 的定义是"观察到多少条
    // first_content"，与它最终进了哪个桶无关 —— 写在分支里就会漏掉待配对那一路。
    this.ensure(provider).total++;
    if (typeof e.data?.cache_hit === "boolean") {
      // Anthropic：事件自带命中维度，直接分桶
      const b = this.ensure(provider);
      (e.data.cache_hit ? b.hit : b.miss).push(ttft);
      return;
    }
    // OpenAI 族：维度在同次 fetch 的 completed 事件上，暂存待配对
    const key = bucketKey(e);
    TtftCacheBucketer.push(this.pendingTtft, key, ttft);
    this.pendingProvider.set(key, provider);
  }

  /**
   * 观察一条 `completed` 事件。
   *
   * 带 `cache_hit` → 进配对表。不带 → 记一次"该组见过 completed 但无维度"，
   * 供 `finalize()` 把它与"配对数量不等"区分开（见 {@link TtftCacheBucket.noDimension}）。
   */
  observeCompleted(e: BucketableEvent): void {
    const key = bucketKey(e);
    if (typeof e.data?.cache_hit === "boolean") {
      TtftCacheBucketer.push(this.pendingHit, key, e.data.cache_hit);
      return;
    }
    this.dimensionlessCompleted.set(key, (this.dimensionlessCompleted.get(key) ?? 0) + 1);
  }

  /**
   * 完成配对并返回 `provider → 分桶` 映射。幂等：重复调用返回同一结果
   *（配对是破坏性的，第二次调用若重跑会把 pending 再算一遍）。
   */
  finalize(): Map<string, TtftCacheBucket> {
    if (this.finalized) return this.buckets;
    this.finalized = true;
    for (const [key, ttfts] of this.pendingTtft) {
      const provider = this.pendingProvider.get(key) ?? "unknown";
      const b = this.ensure(provider);
      const hits = this.pendingHit.get(key) ?? [];
      if (hits.length !== ttfts.length) {
        // 数量不等 → 整组弃用（见文件头注释：猜错会反转结论）。
        // 但要分清两种成因，否则"老轨迹没这个字段"会显示成"埋点判不出来"：
        //   · 该组一条带维度的 completed 都没有，却见过不带维度的 → 老轨迹
        //   · 其余 → 真的有 fetch 没走到 completed（超时/abort/error）
        if (hits.length === 0 && (this.dimensionlessCompleted.get(key) ?? 0) > 0) {
          b.noDimension += ttfts.length;
        } else {
          b.dropped += ttfts.length;
        }
        continue;
      }
      for (let i = 0; i < ttfts.length; i++) {
        (hits[i] ? b.hit : b.miss).push(ttfts[i]!);
      }
    }
    return this.buckets;
  }
}

/**
 * 单桶的样本数 + 分位数。桶为空时**只给 count，不给假分位数** ——
 * 落一个 `p50: 0` 会让"没采到样本"读起来像"首字节 0 秒"。
 *
 * @param percentileFn 分位数函数由调用方注入（digest 与 provider-health 共用
 *   `digest.ts` 的 `percentile`，这里不 import 以免制造反向依赖）
 */
export function bucketStats(
  samples: number[],
  percentileFn: (sorted: number[], p: number) => number | undefined,
): { count: number; p50?: number; p95?: number } {
  if (samples.length === 0) return { count: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  return { count: sorted.length, p50: percentileFn(sorted, 0.5), p95: percentileFn(sorted, 0.95) };
}

/**
 * 渲染分桶行的共享文案（`/trace`、`/trace --health`、两个脚本四处共用一句话）。
 *
 * 五条渲染约定固化在这里，避免四个入口各写一遍后措辞漂移：
 * 1. **两桶都有样本才给差值** —— 只有一桶时给差值等于拿空气做对照；
 * 2. 空桶显示"无样本"而不是 `0.0s`；
 * 3. `dropped > 0` 必须显式写出来 —— 静默截断读起来像全覆盖；
 * 4. **`noDimension` 与 `dropped` 分开措辞** —— 前者是"这批轨迹早于埋点上线"
 *    （预期，不用管），后者是"有 fetch 没走到 completed"（值得看一眼）。
 *    合并成一句会让历史空档看起来像埋点故障。
 * 5. **P2-8：给出 `total` 时必须把分桶分母写出来，并点明它与"请求"列不同源**。
 *    这一条是修 bug 修出来的：此前分桶 n 与看板「请求」列并排放着，读者自然会去加减，
 *    而两者单位根本不同（前者每次 fetch 一条，后者每轮一条），于是出现
 *    「30 请求 · 命中 n=39」这种"子集大于全集"的观感。不可加减的两个数并排放着，
 *    就必须自己声明不可加减。
 *
 * @returns 分桶行文本；两桶都空时返回 null（调用方据此整行不渲染）
 */
export function formatTtftBucketLine(
  bucket: { hit: { count: number; p50?: number }; miss: { count: number; p50?: number } },
  dropped: number | undefined,
  opts?: {
    colorize?: (kind: "green" | "gray", text: string) => string;
    /** 因轨迹早于 cache_hit 维度上线而未进桶的样本数（与 dropped 分开显示） */
    noDimension?: number;
    /**
     * P2-8：该 provider 的 first_content 样本总数（分桶的真实分母）。
     * 传了就渲染"样本 N 条(每次 fetch 一条…)"，不传则整段不出现（向后兼容旧调用方）。
     */
    total?: number;
  },
): string | null {
  const { hit, miss } = bucket;
  if (hit.count === 0 && miss.count === 0) return null;
  const c = opts?.colorize ?? ((_k: "green" | "gray", t: string) => t);
  const fmt = (b: { count: number; p50?: number }) =>
    b.count > 0 ? `${(b.p50! / 1000).toFixed(1)}s(n=${b.count})` : "无样本";
  const delta =
    hit.count > 0 && miss.count > 0
      ? c("green", `  提速 ${((miss.p50! - hit.p50!) / 1000).toFixed(1)}s`)
      : c("gray", "  （单侧无样本，不给差值）");
  const drop = dropped ? c("gray", `  弃用 ${dropped}(有 fetch 未走到 completed)`) : "";
  const legacy = opts?.noDimension
    ? c("gray", `  另 ${opts.noDimension} 个样本来自埋点上线前的轨迹`)
    : "";
  // P2-8：分桶分母。措辞刻意点明"每次 fetch 一条"并与"请求(每轮)"对举 ——
  // 只写个数字仍然会被拿去和「请求」列加减。
  const denom =
    opts?.total !== undefined
      ? c("gray", `  [分桶样本 ${opts.total} 条=每次 fetch 一条，与"请求"列(每轮一条)不同源]`)
      : "";
  return `TTFT 命中:${fmt(hit)} 未命中:${fmt(miss)}${delta}${drop}${legacy}${denom}`;
}
