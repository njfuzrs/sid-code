/**
 * latency-by-model.ts —— TTFT/TTFB **按 model 分组**的分位数（P1 · 跨网关路由不可比）
 *
 * ## 为什么必须按 model 分组，而不是只按 provider
 *
 * `deepseek-v4-pro` 与 `origin-deepseek-v4-pro` 是**同一个底层模型、不同网关路由**，
 * 而且**同属 provider `openai`** —— 按 provider 聚合会把两者合成一个数。实测
 * （51 会话 / 1372 对，2026-08-16 窗口）：
 *
 * | model | n | ttfb p50 | ttft p50 | gap 占 TTFT p50 |
 * |---|---|---|---|---|
 * | `deepseek-v4-pro`        | 231 | **484ms**  | 3983ms | **86.77%** |
 * | `origin-deepseek-v4-pro` |  99 | 3151ms | 3329ms | 5.02% |
 *
 * 同族同模型不同路由，gap 差 **17 倍**。跨路由汇总出的 `ttfb p50 = 2665ms` 是个
 * **假数**：它既不描述前一条路由（真实 484ms），也不描述后一条（真实 3151ms）。
 * 拿它下"首字节很快"的结论时，`deepseek-v4-pro` 的用户实际等了 3.98 秒。
 *
 * ## gap 是什么（这条决定了本模块的措辞，不能省）
 *
 * 单次时间轴（实测 `deepseek-v4-pro`）：
 *
 * ```
 * 21:00:32.934  fetch_sent
 * 21:00:33.455  headers_received   ttfb=521      ← 网关 521ms 就把响应头回来了
 * 21:00:50.624  first_content      ttft=17689    ← 之后干等 17.2s
 * ```
 *
 * 握手 521ms，然后等 17 秒。**这 17 秒是「网关抢先回 header」+「模型 thinking prefill」，
 * 不是 SSE 解析和框架回调。** 判据是反向的：gap 占比 > 50% 的样本里 `ttfb`
 * 分布是 p50=483ms / p95=807ms / max=1371ms —— **gap 大恰恰发生在网关响应最快的时候**，
 * 与"框架开销"的因果方向相反。
 *
 * 所以 `ttfb` 在不同路由下**语义不同**：一路是"模型开始出字"（gap≈0，如 `glm-5.3`
 * 的 0.04%），另一路是"网关接单了"（gap≈87%）。**协议层同口径，语义层不可比。**
 *
 * ⚠️ 由此推出本模块**刻意不提供**的东西：**没有跨 model 汇总的 TTFB 分位数 API**。
 * 不是忘了写 —— 提供了就一定有人去用，那个数必然是假的。要总览就逐行看 model。
 * 同理不要拿本模块的 `gapRatio` 去做「框架 overhead 拆解」（见方案 §7.1：
 * 那个减法两端都是本地观测点、中间夹着网关行为，测不出框架开销）。
 *
 * ## 配对规则：按时间序，不按 (session, index)
 *
 * `(session_id, index)` **不是唯一键** —— 重试复用同一 index，实测
 * `20260806-182533-a927c544` 的 `index=4` 下有 **7 组**完整 phase 序列，而
 * `StreamPhase` 当前没有 `attempt` 字段。dict 式配对会把第 1 次 attempt 的 ttfb
 * 配到第 7 次的 ttft 上，且**"负值 0 条"不构成自洽性证明**（后一次 attempt 的
 * ttft 通常比前一次的 ttfb 大，错配不产生负值）。
 *
 * 故这里用「组内按到达顺序，`headers_received` → 其后第一个 `first_content`」配对，
 * 未闭合的 headers（重试/error 中断）计入 {@link ModelLatencyStats.unpairedHeaders}
 * 而不是硬凑。实测该法得 1372 对 / 0 负值 / 36 个未配对。
 *
 * 同病见 `ttft-cache-buckets.ts` 文件头："`index` 与 usage 是 1:N，按 index 硬关联
 * 得出的结论是假的" —— 那里已经刻意拒绝按 index 关联，本模块沿用同一条纪律。
 */

/** 事件的最小形状 —— 两个消费方的事件类型不同，这里只约束用到的字段 */
interface LatencyEvent {
  event?: string;
  session_id?: string;
  data?: Record<string, unknown>;
}

/** 单个 model 的延迟分位数 */
export interface ModelLatencyStats {
  /** 该 model 归属的 provider（由调用方的 model→provider 映射解析后传入） */
  provider: string;
  /** TTFT 样本数（= 配对成功的 first_content 数） */
  n: number;
  ttft_p50?: number;
  ttft_p95?: number;
  ttft_p99?: number;
  /**
   * TTFB 分位数（ms）。取自 `StreamPhase("headers_received").ttfb_ms`。
   *
   * ⚠️ **只能在同 model 内比较**。跨 model/路由对比这个数会得出假结论，
   * 因为它的语义受网关缓冲策略影响（见文件头注释）。
   */
  ttfb_p50?: number;
  ttfb_p95?: number;
  ttfb_p99?: number;
  /**
   * **路由缓冲指纹**：`(ttft − ttfb) / ttft` 的中位数，0..1。
   *
   * 判据（来自方案 §0.1b）：**> 0.5 即该路由在抢先回 header** —— 此时它的 `ttfb`
   * 表达的是"网关接单了"而非"模型开始出字"，不可与低 gap 的路由并列比较。
   *
   * 为什么落比值而不是差值的绝对毫秒数：绝对值会随模型快慢一起变（慢模型的
   * gap 天然大），比值才是**路由行为**的指纹，可跨模型判读。
   */
  gapRatioP50?: number;
  /** 同上口径的 p95，用于看"这条路由是否偶发抢先回 header" */
  gapRatioP95?: number;
  /**
   * 有 `headers_received` 但没等到 `first_content` 的次数（重试/error 中断导致）。
   *
   * 必须显式落数：静默丢弃读起来像"全部配对成功"。它 > 0 是**预期**的
   * （重试与中断本来就会产生），不是故障信号 —— 与 `ttftByCache` 的 `dropped`
   * 不同，那个是"有维度但对不上"的异常。
   */
  unpairedHeaders: number;
}

/** gap 占比超过此值即判定"该路由在抢先回 header"（方案 §0.1b 的判据） */
export const ROUTE_BUFFERING_GAP_THRESHOLD = 0.5;

/**
 * 按 model 分组聚合 TTFT/TTFB 分位数。
 *
 * @param events        events.jsonl 的事件列表（两个消费方各自读入）
 * @param resolveProvider  model → provider 解析函数（调用方已有 AfterModelRaw 映射，
 *                         这里不重复扫，避免两处各建一份映射后漂移）
 * @param percentileFn  分位数函数由调用方注入（与 `ttft-cache-buckets.ts` 同样的
 *                      理由：不 import `digest.ts` 以免制造反向依赖）
 * @returns model → 分位数。**无跨 model 汇总项**，见文件头 ⚠️ 那段。
 */
export function aggregateLatencyByModel(
  events: LatencyEvent[],
  resolveProvider: (model: string) => string,
  percentileFn: (sorted: number[], p: number) => number | undefined,
): Map<string, ModelLatencyStats> {
  /** 分组键：与 `ttft-cache-buckets.ts` 的 `bucketKey` 同构 —— **必须含 agent_id**，
   * 子代理与主循环共享 index 空间，不分开会把子代理的 ttfb 配到主循环的 ttft 上。 */
  const pairKey = (e: LatencyEvent): string => {
    const sid = e.session_id ?? (e.data?.session_id as string | undefined) ?? "";
    const idx = e.data?.index ?? "";
    const agent = e.data?.agent_id ?? "main";
    return `${sid}|${idx}|${agent}`;
  };

  interface Acc {
    ttfts: number[];
    ttfbs: number[];
    gapRatios: number[];
    unpairedHeaders: number;
  }
  const byModel = new Map<string, Acc>();
  const ensure = (model: string): Acc => {
    let a = byModel.get(model);
    if (!a) {
      a = { ttfts: [], ttfbs: [], gapRatios: [], unpairedHeaders: 0 };
      byModel.set(model, a);
    }
    return a;
  };

  /**
   * key → 尚未闭合的 headers_received（ttfb + model）。
   *
   * 单槽而非队列：同一 (session,index,agent) 内连续两个 headers_received 意味着
   * 前一次 fetch 没走到 first_content（重试），此时前一个必须计 unpaired 并让位，
   * 而不是排队等着被后面的 first_content 配走 —— 那正是跨 attempt 错配。
   */
  const pending = new Map<string, { ttfb: number; model: string }>();

  for (const e of events) {
    if (e.event !== "StreamPhase" || !e.data) continue;
    const phase = e.data.phase;
    const key = pairKey(e);

    if (phase === "headers_received") {
      const ttfb = e.data.ttfb_ms;
      const model = (e.data.model as string) || "";
      // 前一个 headers 还没闭合 → 那次 fetch 中断了，计 unpaired 后让位
      const prev = pending.get(key);
      if (prev) ensure(prev.model).unpairedHeaders++;
      if (typeof ttfb === "number" && ttfb >= 0 && model) {
        pending.set(key, { ttfb, model });
      } else {
        // ttfb/model 缺失（老轨迹或 emit 失败）→ 不占槽，否则会吞掉下一个 first_content
        pending.delete(key);
      }
      continue;
    }

    if (phase === "first_content") {
      const ttft = e.data.ttft_ms;
      // model 优先取 first_content 自己的，缺失时回退到配对的 headers
      const held = pending.get(key);
      const model = (e.data.model as string) || held?.model || "";
      if (typeof ttft !== "number" || ttft <= 0 || !model) {
        // TTFT 不可用：不能让 pending 悬着（下一次 fetch 的 first_content 会误配它）
        if (held) {
          ensure(held.model).unpairedHeaders++;
          pending.delete(key);
        }
        continue;
      }
      const acc = ensure(model);
      acc.ttfts.push(ttft);
      if (held) {
        pending.delete(key);
        acc.ttfbs.push(held.ttfb);
        // gap 比值只在 ttft > 0 时有意义（上面已保证）。负值理论上不该出现
        // （headers 必先于 first_content），真出现说明时钟/写序异常，此时丢弃比
        // 落一个负指纹好 —— 负的"缓冲程度"读不出任何东西。
        const gap = (ttft - held.ttfb) / ttft;
        if (gap >= 0) acc.gapRatios.push(gap);
      }
      continue;
    }
  }

  // 遍历结束仍悬着的 headers：会话末尾被 kill / error 中断，计入未配对
  for (const held of pending.values()) ensure(held.model).unpairedHeaders++;

  const out = new Map<string, ModelLatencyStats>();
  for (const [model, acc] of byModel) {
    const ttfts = [...acc.ttfts].sort((a, b) => a - b);
    const ttfbs = [...acc.ttfbs].sort((a, b) => a - b);
    const gaps = [...acc.gapRatios].sort((a, b) => a - b);
    out.set(model, {
      provider: resolveProvider(model),
      n: ttfts.length,
      ttft_p50: percentileFn(ttfts, 0.5),
      ttft_p95: percentileFn(ttfts, 0.95),
      ttft_p99: percentileFn(ttfts, 0.99),
      ttfb_p50: percentileFn(ttfbs, 0.5),
      ttfb_p95: percentileFn(ttfbs, 0.95),
      ttfb_p99: percentileFn(ttfbs, 0.99),
      gapRatioP50: percentileFn(gaps, 0.5),
      gapRatioP95: percentileFn(gaps, 0.95),
      unpairedHeaders: acc.unpairedHeaders,
    });
  }
  return out;
}

/**
 * 渲染一行 model 级延迟（`/trace` 与 `/trace --health` 共用同一句话）。
 *
 * 四条渲染约定固化在这里，避免两个入口各写一遍后措辞漂移
 * （同 `formatTtftBucketLine` 的理由）：
 *
 * 1. **TTFB 必须与 gap 同行出现**。单独给一个 `TTFB 0.5s` 就是本 PR 要消灭的那个
 *    假结论；只有并排看到 `缓冲 87%` 才知道这 0.5s 是"网关接单"不是"模型出字"。
 * 2. **gap > 阈值时显式点破**"网关抢先回 header"，不留给读者自己推。
 * 3. 无 TTFB 样本（老轨迹早于 headers_received 埋点）时**不显示 `0.0s`**，
 *    整段省略 —— 落 0 会被读成"首字节 0 秒"。
 * 4. `unpairedHeaders > 0` 时写出来，但**措辞为中性**（"未闭合"）而非告警：
 *    重试与中断本来就会产生它，标红会让人去排查一个预期行为。
 */
export function formatModelLatencyLine(
  model: string,
  s: ModelLatencyStats,
  opts?: { colorize?: (kind: "yellow" | "gray" | "cyan", text: string) => string },
): string {
  const c = opts?.colorize ?? ((_k: "yellow" | "gray" | "cyan", t: string) => t);
  const sec = (ms?: number) => (ms === undefined ? "—" : `${(ms / 1000).toFixed(1)}s`);
  const parts = [`${c("cyan", model)} n=${s.n} TTFT P50=${sec(s.ttft_p50)}`];
  if (s.ttfb_p50 !== undefined) {
    parts.push(`TTFB P50=${sec(s.ttfb_p50)}`);
    if (s.gapRatioP50 !== undefined) {
      const pctText = `${(s.gapRatioP50 * 100).toFixed(0)}%`;
      parts.push(
        s.gapRatioP50 > ROUTE_BUFFERING_GAP_THRESHOLD
          ? c("yellow", `缓冲 ${pctText}(网关抢先回 header，TTFB 不代表模型出字)`)
          : c("gray", `缓冲 ${pctText}`),
      );
    }
  }
  if (s.unpairedHeaders > 0) {
    parts.push(c("gray", `未闭合 ${s.unpairedHeaders}(重试/中断)`));
  }
  return parts.join(" ");
}
