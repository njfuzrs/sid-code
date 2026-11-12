/**
 * /perf：本机性能数据的产品内出口。
 *
 * 背景：TTFT / 生成耗时 / tok/s / 工具耗时 / 上下文峰值都已采集，但跨会话趋势只能在仓库里
 * 跑 `scripts/northstar-snapshot.ts` 才看得到 —— 只装了二进制的用户**没有任何入口**。
 * 这里把「当前会话卡在哪一段」与「本机近 N 天变快还是变慢」做成纯函数，命令层只做分派。
 *
 * 分层（PR-B）：取数在 cli `perf.ts`，**报告模型与瓶颈判定在这里（纯函数、不带格式）**，
 * 渲染在 cli `command/commands/perf/render.ts`（要用 string-width 与 ANSI，core 不引这些依赖）。
 * `--json` 输出的就是这里的报告结构，字段即契约。
 *
 * 口径铁律（与 CLAUDE.md「更快」一节一致）：
 * - 报 p50/p95/p99，每个数都带 n；n<5 直接列样本、n<100 不报 P99；无样本渲染「无样本」，**绝不渲染 0**
 * - TTFT 按 model 分组展示；TTFB 只在单 model 内展示，绝不跨 model 汇总
 * - 跨会话分位数回到「每会话一个值」的分布上取，不对分位数求平均
 * - 无版本号的历史行在按版本视图里显式报数，不静默丢弃
 */
import { percentile as sortedPercentile, TTFT_P95_WARN_MS } from "./digest.ts";
import { isMainScopePerfRow, type SessionIndexEntry } from "./session-index.ts";
import { ROUTE_BUFFERING_GAP_THRESHOLD, type ModelLatencyStats } from "./latency-by-model.ts";
import {
  MIN_PERCENTILE_SAMPLES,
  type PerfDetail,
  type PerfSideGroup,
  type PerfSlowCall,
  type PerfTimeSplit,
  type PerfToolRow,
} from "./perf-detail.ts";

/** 未排序样本的分位数；空样本 → undefined（不是 0） */
export function pct(values: number[], p: number): number | undefined {
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length === 0) return undefined;
  return sortedPercentile(
    [...xs].sort((a, b) => a - b),
    p,
  );
}

/** 一个带样本量的数。value 为 undefined 即无样本 */
export interface PerfStat {
  value?: number;
  n: number;
}

function stat(values: Array<number | undefined>, p: number): PerfStat {
  const xs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return { value: pct(xs, p), n: xs.length };
}

// ───────────────────────────── 当前会话 ─────────────────────────────

/**
 * 一个延迟分布。`samples` 只在 n < MIN_PERCENTILE_SAMPLES 时给（降序），渲染层据此直接列样本、不写分位数（D5）。
 */
export interface Dist {
  p50?: number;
  p95?: number;
  p99?: number;
  n: number;
  samples?: number[];
}

export interface SessionPerfInput {
  sessionId: string;
  model: string;
  /** 会话是否已收尾（SessionEnd 已到）。false = 进行中，面板标「截至」 */
  ended?: boolean;
  /** session.traj 快照时刻（ISO），进行中时显示 */
  snapshotAt?: string;
  /** 会话墙钟（ms） */
  wallMs?: number;
  /** digest.sessionMetrics 的子集 */
  metrics?: {
    ttft_p50?: number;
    ttft_p95?: number;
    ttft_p99?: number;
    ttft_n: number;
    main_headers_p50?: number;
    main_headers_p95?: number;
    main_headers_n?: number;
    e2e_p50?: number;
    e2e_p95?: number;
    e2e_p99?: number;
    e2e_n: number;
    e2e_interrupted_n?: number;
    e2e_interrupted_max?: number;
    gen_p50?: number;
    gen_p95?: number;
    gen_p99?: number;
    gen_n?: number;
    subagent_ttft_p50?: number;
    subagent_ttft_n?: number;
  };
  /** 按 model 的 TTFT/TTFB（digest providerStats[].latencyByModel 合并） */
  latencyByModel?: Record<string, ModelLatencyStats>;
  /** 缓存分桶（单 provider 时才给；多 provider 不汇总） */
  ttftByCache?: {
    hit: { count: number; p50?: number; p95?: number };
    miss: { count: number; p50?: number; p95?: number };
  };
  /** digest.perfDetail */
  detail?: PerfDetail;
  /** 来自 session.traj metadata */
  tps?: number;
  reasoningShare?: number;
  contextPeakRatio?: number;
  contextPeakTokens?: number;
  contextWindow?: number;
}

export type BottleneckPrimary = "ttfb" | "gen" | "tool" | "other" | "insufficient";

export interface BottleneckVerdict {
  primary: BottleneckPrimary;
  /** primary 那一项占活跃时间的比例（insufficient 时无） */
  share?: number;
  /** 第一条是主结论之后的补充，能指回下面的数字，不写「可能」 */
  reasons: string[];
  /** 黄色警示：必须能行动（工具高失败率 / TTFT P95 过高）。后台被中止在「后台辅助」段自己标 */
  warnings: string[];
}

export interface SessionPerfReport {
  sessionId: string;
  model: string;
  header: {
    shortId: string;
    wallMs?: number;
    activeMs?: number;
    mainCalls: number;
    live: boolean;
    snapshotAt?: string;
  };
  verdict: BottleneckVerdict;
  timeSplit?: PerfTimeSplit;
  latency: {
    ttft: Dist;
    /**
     * 主循环 TTFB。只在单 model 时给 —— 跨 model 汇总 TTFB 是假数（latency-by-model.ts 文件头）。
     * 字段名不叫 ttfb：结构门禁（observability-d22-d30 缺陷 26）只许 latency-by-model.ts 声明 ttfb 分位键。
     */
    headers?: Dist;
    gen: Dist;
    tps?: number;
    reasoningShare?: number;
    /** 单模型时才有：(TTFT−TTFB)/TTFT 的中位数，路由缓冲指纹 */
    gapRatioP50?: number;
    ttftByCache?: { hit: Dist; miss: Dist };
    e2e: Dist;
    e2eInterrupted?: { n: number; maxMs?: number };
  };
  /**
   * 按 model 的延迟，**原样引用** `latency-by-model.ts` 的结构而不复制 TTFB 字段。只在 >1 个模型时渲染。
   */
  byModel: Array<{ model: string; stats: ModelLatencyStats }>;
  slowest: PerfSlowCall[];
  events: { unpaired: number; stalls: number; timeouts: number; retries: number };
  /** 主循环工具，按合计降序（全部；渲染截前 5） */
  tools: PerfToolRow[];
  side: {
    groups: Array<{
      key: string;
      label: string;
      n: number;
      ttftP50?: number;
      aborted: number;
      abortedMaxMs?: number;
    }>;
    subagent?: { fetches: number; ttftP50?: number; genMs: number };
  };
  contextPeak?: { ratio: number; tokens?: number; window?: number };
}

// ── judgeBottleneck 阈值：规则只写在这一处，**不按模型名分档** ──
/** 生成是瓶颈、且 reasoning 占输出 ≥ 它 → 提示降 effort */
export const BOTTLENECK_REASONING_SHARE = 0.5;
/**
 * (TTFT−TTFB)/TTFT 中位数超过它 = 网关抢先回响应头。必须与 `northstar/README.md` 的「> 50%」、
 * `latency-by-model.ts` 的 `ROUTE_BUFFERING_GAP_THRESHOLD` 同值（测试锁住，防漂移）。
 */
export const TTFB_BUFFER_GAP_RATIO = ROUTE_BUFFERING_GAP_THRESHOLD;
/** 缓存未命中桶 P50 ÷ 命中桶 P50 ≥ 它 → 补「缓存未命中时首字慢 X 倍」 */
export const CACHE_MISS_SLOWDOWN = 2;
/** 工具失败率 ≥ 它且次数 ≥ TOOL_FAILURE_WARN_MIN_N → 黄色提示 */
export const TOOL_FAILURE_WARN_RATIO = 0.5;
export const TOOL_FAILURE_WARN_MIN_N = 3;
/** 单会话 P99：n 小于它时 P99 ≈ 最大值，面板写「—」 */
export const MIN_P99_SAMPLES = 100;

/** 已知后台任务的中文名。未登记的原样显示 key —— 宁可显示英文也不猜 */
const SIDE_LABEL: Record<string, string> = {
  "fork:session-memory-update": "记忆 fork",
  "fork:memory-extract": "记忆 fork",
  title_generation: "标题生成",
  "title-generation": "标题生成",
};

function sideLabel(key: string): string {
  return SIDE_LABEL[key] ?? key;
}

function dist(
  p50: number | undefined,
  p95: number | undefined,
  p99: number | undefined,
  n: number | undefined,
  samples?: number[],
): Dist {
  const nn = n ?? 0;
  return {
    p50,
    p95,
    p99,
    n: nn,
    ...(nn > 0 && nn < MIN_PERCENTILE_SAMPLES && samples?.length === nn ? { samples } : {}),
  };
}

const finite = (v: number | undefined): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;

/** 面板用的时长格式（D15-6）：<10s 一位小数，<60s 整秒，<1h `XmYYs`，≥1h `XhYYm` */
export function fmtDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  if (totalSec < 3600) {
    const m = Math.floor(totalSec / 60);
    return `${m}m${String(totalSec % 60).padStart(2, "0")}s`;
  }
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  return `${h}h${String(totalMin % 60).padStart(2, "0")}m`;
}

const pctText = (r: number) => `${Math.round(r * 100)}%`;

/**
 * 瓶颈判定（D7）。规则：
 * 1. 时间构成中占比最大的一项是 primary；
 * 2. primary=生成 且 reasoning 占输出 ≥ 50% → 「thinking 占输出 X%，可考虑降低 effort」；
 * 3. primary=等首字节：gapRatio < 50% → 网关缓冲；≥ 50% → 模型 prefill 慢；未命中桶慢 ≥2 倍 → 补一句；
 * 4. primary=工具 → 列耗时前 2 的工具；
 * 5. 任一工具失败率 ≥ 50% 且次数 ≥ 3 → 黄色提示（不论是否瓶颈）。
 * 主循环调用 < 5 次不下结论（insufficient）。另一条警示：TTFT P95 > 30s（与 /trace 健康告警同阈值）。
 */
export function judgeBottleneck(r: Omit<SessionPerfReport, "verdict">): BottleneckVerdict {
  const warnings: string[] = [];
  for (const t of r.tools) {
    if (t.n >= TOOL_FAILURE_WARN_MIN_N && t.failed / t.n >= TOOL_FAILURE_WARN_RATIO) {
      warnings.push(`${t.name} 失败 ${t.failed}/${t.n} 次`);
    }
  }
  // 后台调用被中止不进这里：「后台辅助」一段自己用黄色标出，结论区再写一遍是重复
  if (r.latency.ttft.p95 !== undefined && r.latency.ttft.p95 > TTFT_P95_WARN_MS) {
    warnings.push(
      `首字 TTFT P95 ${fmtDuration(r.latency.ttft.p95)}，超过 ${TTFT_P95_WARN_MS / 1000}s`,
    );
  }

  const split = r.timeSplit;
  if (r.header.mainCalls < MIN_PERCENTILE_SAMPLES || !split || split.activeMs <= 0) {
    return { primary: "insufficient", reasons: [], warnings };
  }
  const parts: Array<[Exclude<BottleneckPrimary, "insufficient">, number]> = [
    ["ttfb", split.ttfbMs],
    ["gen", split.genMs],
    ["tool", split.toolMs],
    ["other", split.otherMs],
  ];
  const [primary, ms] = parts.reduce((a, b) => (b[1] > a[1] ? b : a));
  const share = ms / split.activeMs;
  const reasons: string[] = [];
  const lat = r.latency;

  if (primary === "gen") {
    if (lat.reasoningShare !== undefined && lat.reasoningShare >= BOTTLENECK_REASONING_SHARE) {
      reasons.push(`thinking 占输出 ${pctText(lat.reasoningShare)}，可考虑降低 effort`);
    } else if (lat.tps !== undefined) {
      reasons.push(`生成速度 ${Math.round(lat.tps)} tok/s，输出越长越慢`);
    }
  } else if (primary === "ttfb") {
    if (lat.gapRatioP50 !== undefined) {
      reasons.push(
        lat.gapRatioP50 >= TTFB_BUFFER_GAP_RATIO
          ? `网关先回响应头（TTFT−TTFB 占 ${pctText(lat.gapRatioP50)}），慢在模型 prefill`
          : `网关等模型出字才回响应头（TTFT≈TTFB），分不清排队还是 prefill，用 /trace --health 对比路由`,
      );
    }
  } else if (primary === "tool") {
    const top = r.tools.slice(0, 2).map((t) => `${t.name} ${fmtDuration(t.totalMs)}`);
    if (top.length > 0) reasons.push(`最耗时：${top.join("、")}`);
  } else {
    reasons.push("轮间开销与权限确认等待，模型和工具都不是瓶颈");
  }

  // 首字等待不是主瓶颈时，占比 ≥15% 也值得一句（取证会话 19%）——指出缓冲形态
  if (
    primary !== "ttfb" &&
    split.ttfbMs / split.activeMs >= 0.15 &&
    lat.gapRatioP50 !== undefined
  ) {
    reasons.push(
      `首字等待 ${pctText(split.ttfbMs / split.activeMs)}，` +
        (lat.gapRatioP50 >= TTFB_BUFFER_GAP_RATIO
          ? `网关先回响应头，慢在模型 prefill`
          : `网关等模型出字才回响应头（TTFT≈TTFB），分不清是排队还是 prefill`),
    );
  }
  const hit = lat.ttftByCache?.hit.p50;
  const miss = lat.ttftByCache?.miss.p50;
  if (
    hit &&
    miss &&
    miss / hit >= CACHE_MISS_SLOWDOWN &&
    (primary === "ttfb" || reasons.length < 3)
  ) {
    reasons.push(`缓存未命中时首字慢 ${(miss / hit).toFixed(1)}×`);
  }
  return { primary, share, reasons, warnings };
}

export function buildSessionPerf(input: SessionPerfInput): SessionPerfReport {
  const m = input.metrics;
  const d = input.detail;
  const byModel = Object.entries(input.latencyByModel ?? {})
    .map(([model, stats]) => ({ model, stats }))
    .sort((a, b) => b.stats.n - a.stats.n);
  const single = byModel.length === 1 ? byModel[0]!.stats : undefined;
  const cache = input.ttftByCache;
  const cacheDist = (b: { count: number; p50?: number; p95?: number }): Dist =>
    dist(b.p50, b.p95, undefined, b.count);
  const subTtftP50 = m?.subagent_ttft_p50;

  const base: Omit<SessionPerfReport, "verdict"> = {
    sessionId: input.sessionId,
    model: input.model,
    header: {
      shortId: input.sessionId.slice(-8),
      wallMs: finite(input.wallMs),
      activeMs: d?.timeSplit.activeMs || undefined,
      mainCalls: d?.mainCalls ?? 0,
      live: input.ended === false,
      snapshotAt: input.ended === false ? input.snapshotAt : undefined,
    },
    timeSplit: d && d.timeSplit.activeMs > 0 ? d.timeSplit : undefined,
    latency: {
      ttft: dist(m?.ttft_p50, m?.ttft_p95, m?.ttft_p99, m?.ttft_n, d?.smallSamples.ttft),
      headers: single
        ? dist(m?.main_headers_p50, m?.main_headers_p95, single.ttfb_p99, m?.main_headers_n)
        : undefined,
      gen: dist(m?.gen_p50, m?.gen_p95, m?.gen_p99, m?.gen_n, d?.smallSamples.gen),
      tps: finite(input.tps),
      reasoningShare: finite(input.reasoningShare),
      gapRatioP50: single?.gapRatioP50,
      ttftByCache:
        cache && cache.hit.count > 0 && cache.miss.count > 0
          ? { hit: cacheDist(cache.hit), miss: cacheDist(cache.miss) }
          : undefined,
      e2e: dist(m?.e2e_p50, m?.e2e_p95, m?.e2e_p99, m?.e2e_n, d?.smallSamples.e2e),
      e2eInterrupted: m?.e2e_interrupted_n
        ? { n: m.e2e_interrupted_n, maxMs: m.e2e_interrupted_max }
        : undefined,
    },
    byModel,
    slowest: d?.slowest ?? [],
    events: d?.events ?? { unpaired: 0, stalls: 0, timeouts: 0, retries: 0 },
    tools: d?.tools ?? [],
    side: {
      groups: mergeSideGroups(d?.side ?? []),
      subagent:
        d && (d.subagent.fetches > 0 || d.subagent.ttfts.length > 0)
          ? {
              fetches: d.subagent.fetches,
              ttftP50: subTtftP50 ?? pct(d.subagent.ttfts, 0.5),
              genMs: d.subagent.genMs,
            }
          : undefined,
    },
    contextPeak:
      input.contextPeakRatio && input.contextPeakRatio > 0
        ? {
            ratio: input.contextPeakRatio,
            tokens: input.contextPeakTokens,
            window: input.contextWindow,
          }
        : undefined,
  };
  return { ...base, verdict: judgeBottleneck(base) };
}

/** 同一中文名的后台任务合并成一行（记忆 fork 有两个 agent_id：update / extract） */
function mergeSideGroups(groups: PerfSideGroup[]): SessionPerfReport["side"]["groups"] {
  const merged = new Map<
    string,
    {
      label: string;
      keys: string[];
      n: number;
      ttfts: number[];
      aborted: number;
      abortedMaxMs?: number;
    }
  >();
  for (const g of groups) {
    const label = sideLabel(g.key);
    const cur = merged.get(label) ?? { label, keys: [], n: 0, ttfts: [], aborted: 0 };
    cur.keys.push(g.key);
    cur.n += g.n;
    cur.ttfts.push(...g.ttfts);
    cur.aborted += g.aborted;
    if (g.abortedMaxMs !== undefined)
      cur.abortedMaxMs = Math.max(cur.abortedMaxMs ?? 0, g.abortedMaxMs);
    merged.set(label, cur);
  }
  return [...merged.values()]
    .map((g) => ({
      key: g.keys.join(","),
      label: g.label,
      n: g.n,
      ttftP50: pct(g.ttfts, 0.5),
      aborted: g.aborted,
      ...(g.abortedMaxMs !== undefined ? { abortedMaxMs: g.abortedMaxMs } : {}),
    }))
    .sort((a, b) => b.n - a.n);
}

// ───────────────────────────── 跨会话趋势 ─────────────────────────────

/** 进趋势的指标。direction 决定「变大」是退步还是改善 */
export const TREND_METRICS = [
  { key: "ttft_p50", label: "TTFT P50", unit: "ms", lowerIsBetter: true },
  { key: "ttft_p95", label: "TTFT P95", unit: "ms", lowerIsBetter: true },
  { key: "gen_p95", label: "生成耗时 P95", unit: "ms", lowerIsBetter: true },
  { key: "tps_p50", label: "生成速度 P50", unit: "tps", lowerIsBetter: false },
  { key: "e2e_p95", label: "端到端 P95", unit: "ms", lowerIsBetter: true },
  { key: "tool_p50", label: "工具耗时/会话 P50", unit: "ms", lowerIsBetter: true },
  { key: "ctx_p95", label: "上下文峰值 P95", unit: "ratio", lowerIsBetter: true },
  { key: "cost_p50", label: "成本/会话 P50（已计价）", unit: "usd", lowerIsBetter: true },
  { key: "turns_p50", label: "轮数/会话 P50", unit: "count", lowerIsBetter: true },
] as const;

export type TrendKey = (typeof TREND_METRICS)[number]["key"];
export type PerfUnit = (typeof TREND_METRICS)[number]["unit"];

export interface WindowStats {
  sessions: number;
  /**
   * PR-A（A8）：其中旧口径行数（`perf_scope` 不是 `"main"`，TTFT / 生成耗时含后台调用）。
   * 不做换算，只报数：消费侧据此提示「对比偏乐观」。
   */
  legacyScopeSessions: number;
  metrics: Record<TrendKey, PerfStat>;
}

/**
 * 一组会话的统计。分位数口径：每会话贡献一个值（该会话自己的 p50/p95/均速），
 * 再在这些值上取分位 —— 与 northstar 快照同口径（p95 取每会话 p95 的 p95）。
 */
export function windowStats(rows: SessionIndexEntry[]): WindowStats {
  return {
    sessions: rows.length,
    legacyScopeSessions: rows.filter((r) => !isMainScopePerfRow(r)).length,
    metrics: {
      ttft_p50: stat(
        rows.map((r) => r.ttft_p50),
        0.5,
      ),
      ttft_p95: stat(
        rows.map((r) => r.ttft_p95),
        0.95,
      ),
      gen_p95: stat(
        rows.map((r) => r.gen_p95),
        0.95,
      ),
      tps_p50: stat(
        rows.map((r) => r.tps),
        0.5,
      ),
      e2e_p95: stat(
        rows.map((r) => r.e2e_p95),
        0.95,
      ),
      tool_p50: stat(
        rows.map((r) => r.tool_duration_ms),
        0.5,
      ),
      ctx_p95: stat(
        rows.map((r) => r.context_peak_ratio),
        0.95,
      ),
      // 只取 >0：实测本机近 7 天 48 个会话里大半 cost=0（网关未回价 / 未计价模型），
      // 混进来中位数直接塌成 $0，再被判成「成本降了 100%」—— 那是没计价，不是变省了
      cost_p50: stat(
        rows.filter((r) => r.cost_usd > 0).map((r) => r.cost_usd),
        0.5,
      ),
      turns_p50: stat(
        rows.filter((r) => r.turns > 0).map((r) => r.turns),
        0.5,
      ),
    },
  };
}

/** 两侧都至少这么多样本才下「变好/变差」结论；少于它只报数不判 */
export const MIN_TREND_SAMPLES = MIN_PERCENTILE_SAMPLES;
/** 相对变化超过它才算「变了」，否则标 ≈（单机样本噪声大） */
export const TREND_NOISE_RATIO = 0.1;
/** 退步超过它加 ⚠ */
export const TREND_WARN_RATIO = 0.2;

export type Verdict = "better" | "worse" | "same" | "insufficient";

export interface TrendRow {
  key: TrendKey;
  label: string;
  unit: PerfUnit;
  current: PerfStat;
  previous: PerfStat;
  /** (current - previous) / previous；任一侧无值时 undefined */
  change?: number;
  verdict: Verdict;
  warn: boolean;
}

export function compareWindows(cur: WindowStats, prev: WindowStats): TrendRow[] {
  return TREND_METRICS.map((def) => {
    const c = cur.metrics[def.key];
    const p = prev.metrics[def.key];
    const change =
      c.value !== undefined && p.value !== undefined && p.value > 0
        ? (c.value - p.value) / p.value
        : undefined;
    let verdict: Verdict = "insufficient";
    let warn = false;
    if (change !== undefined && c.n >= MIN_TREND_SAMPLES && p.n >= MIN_TREND_SAMPLES) {
      if (Math.abs(change) < TREND_NOISE_RATIO) verdict = "same";
      else {
        const worse = def.lowerIsBetter ? change > 0 : change < 0;
        verdict = worse ? "worse" : "better";
        warn = worse && Math.abs(change) >= TREND_WARN_RATIO;
      }
    }
    return {
      key: def.key,
      label: def.label,
      unit: def.unit,
      current: c,
      previous: p,
      change,
      verdict,
      warn,
    };
  });
}

export interface TrendReport {
  days: number;
  /** 窗口边界（秒） */
  currentSince: number;
  previousSince: number;
  current: WindowStats;
  previous: WindowStats;
  rows: TrendRow[];
  /** 本窗口内按 model 的会话级 TTFT P50（每会话 p50 的中位数），会话数降序 */
  ttftByModel: Array<{ model: string; sessions: number; p50?: number; n: number }>;
}

/**
 * 增量行（还在跑 / 崩溃）只算到一半，混进来会把延迟与成本系统性拉低。
 *
 * 只排除 `incomplete`，刻意不排除 user_interrupt / abort / error / max_turns /
 * budget_exceeded：这些会话已收尾、数据是完整的，而慢样本往往正是被打断的那些，
 * 筛掉它们会让 p95 系统性偏低（同 query/turn-complete.ts「异常轮次也必须发」）。
 * 渲染文案必须与这里同口径，不能写成「不含未正常结束的会话」—— 那会被读成
 * 中断/报错会话都已剔除。
 */
function settled(rows: SessionIndexEntry[]): SessionIndexEntry[] {
  return rows.filter((r) => r.exit_status !== "incomplete");
}

export function buildTrend(
  index: SessionIndexEntry[],
  opts: { days: number; nowSec: number },
): TrendReport {
  const span = opts.days * 86400;
  const currentSince = opts.nowSec - span;
  const previousSince = currentSince - span;
  const rows = settled(index);
  const cur = rows.filter((r) => r.ts >= currentSince && r.ts <= opts.nowSec);
  const prev = rows.filter((r) => r.ts >= previousSince && r.ts < currentSince);
  const current = windowStats(cur);
  const previous = windowStats(prev);

  const byModel = new Map<string, number[]>();
  const sessionsByModel = new Map<string, number>();
  for (const r of cur) {
    const model = r.model || "?";
    sessionsByModel.set(model, (sessionsByModel.get(model) ?? 0) + 1);
    if (typeof r.ttft_p50 === "number") {
      const arr = byModel.get(model) ?? [];
      arr.push(r.ttft_p50);
      byModel.set(model, arr);
    }
  }
  const ttftByModel = [...sessionsByModel.entries()]
    .map(([model, sessions]) => {
      const xs = byModel.get(model) ?? [];
      return { model, sessions, p50: pct(xs, 0.5), n: xs.length };
    })
    .sort((a, b) => b.sessions - a.sessions);

  return {
    days: opts.days,
    currentSince,
    previousSince,
    current,
    previous,
    rows: compareWindows(current, previous),
    ttftByModel,
  };
}

export interface VersionReport {
  /**
   * `incompleteSessions`（D12）：该版本被 `settled()` 剔除的 `incomplete` 行数。0.1.606–0.1.611 有约 140 行
   * 实际已收尾却仍标 incomplete（当时写入路径的缺陷），渲染时占比 >30% 加一行说明「样本偏少」。
   * 不回填历史索引：latest-wins 语义 + 用户本机数据，改写风险大于收益。
   */
  versions: Array<{ version: string; incompleteSessions: number } & WindowStats>;
  /** 没有 app_version 的行数 —— 显式报，不静默丢 */
  rowsWithoutVersion: number;
}

/** 语义化版本比较（x.y.z），非法串排最前 */
function cmpSemver(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10));
  const pb = b.split(".").map((x) => parseInt(x, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 某版本 incomplete 行占比超过它，按版本视图加脚注（D12） */
export const VERSION_INCOMPLETE_NOTE_RATIO = 0.3;

export function buildByVersion(index: SessionIndexEntry[], limit: number): VersionReport {
  const rows = settled(index);
  const incomplete = new Map<string, number>();
  for (const r of index) {
    if (r.exit_status === "incomplete" && r.app_version)
      incomplete.set(r.app_version, (incomplete.get(r.app_version) ?? 0) + 1);
  }
  const groups = new Map<string, SessionIndexEntry[]>();
  let rowsWithoutVersion = 0;
  for (const r of rows) {
    if (!r.app_version) {
      rowsWithoutVersion++;
      continue;
    }
    const arr = groups.get(r.app_version) ?? [];
    arr.push(r);
    groups.set(r.app_version, arr);
  }
  const versions = [...groups.keys()]
    .sort(cmpSemver)
    .slice(-limit)
    .map((version) => ({
      version,
      incompleteSessions: incomplete.get(version) ?? 0,
      ...windowStats(groups.get(version)!),
    }));
  return { versions, rowsWithoutVersion };
}
