/**
 * /perf：本机性能数据的产品内出口。
 *
 * 背景：TTFT / 生成耗时 / tok/s / 工具耗时 / 上下文峰值都已采集，但跨会话趋势只能在仓库里
 * 跑 `scripts/northstar-snapshot.ts` 才看得到 —— 只装了二进制的用户**没有任何入口**。
 * 这里把「当前会话卡在哪一段」与「本机近 N 天变快还是变慢」做成纯函数，命令层只做分派。
 *
 * 口径铁律（与 CLAUDE.md「更快」一节一致）：
 * - 只报 p50/p95，每个数都带 n；无样本渲染「无样本」，**绝不渲染 0**
 * - TTFT 按 model 分组展示；TTFB 只在单 model 内展示，绝不跨 model 汇总
 * - 跨会话分位数回到「每会话一个值」的分布上取，不对分位数求平均
 * - 无版本号的历史行在按版本视图里显式报数，不静默丢弃
 */
import { percentile as sortedPercentile } from "./digest.ts";
import type { SessionIndexEntry } from "./session-index.ts";
import type { ModelLatencyStats } from "./latency-by-model.ts";

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

export interface SessionPerfInput {
  sessionId: string;
  model: string;
  /** digest.sessionMetrics 的子集 */
  metrics?: {
    ttft_p50?: number;
    ttft_p95?: number;
    ttft_n: number;
    e2e_p50?: number;
    e2e_p95?: number;
    e2e_n: number;
    gen_p95?: number;
    gen_n?: number;
  };
  /** 按 model 的 TTFT/TTFB（digest providerStats[].latencyByModel 合并） */
  latencyByModel?: Record<string, ModelLatencyStats>;
  /** 模型整轮耗时累计（ms）= Σ AfterModelRaw.elapsed_ms（含握手+生成+重试） */
  modelTimeMs?: number;
  /** 来自 session.traj metadata */
  tps?: number;
  toolDurationMs?: number;
  contextPeakRatio?: number;
  contextPeakTokens?: number;
}

export interface SessionPerfReport {
  sessionId: string;
  model: string;
  ttft: { p50?: number; p95?: number; n: number };
  ttftByModel: Array<{ model: string; n: number; p50?: number; p95?: number; ttfbP50?: number }>;
  e2e: { p50?: number; p95?: number; n: number };
  gen: { p95?: number; n: number };
  tps?: number;
  /** 「慢在模型还是工具」：两者都是主动执行时间，不含等用户输入 */
  split?: { modelMs: number; toolMs: number; toolShare: number };
  contextPeak?: { ratio: number; tokens?: number };
}

export function buildSessionPerf(input: SessionPerfInput): SessionPerfReport {
  const m = input.metrics;
  const byModel = Object.entries(input.latencyByModel ?? {})
    .map(([model, s]) => ({
      model,
      n: s.n,
      p50: s.ttft_p50,
      p95: s.ttft_p95,
      ttfbP50: s.ttfb_p50,
    }))
    .sort((a, b) => b.n - a.n);
  const modelMs = input.modelTimeMs ?? 0;
  const toolMs = input.toolDurationMs ?? 0;
  return {
    sessionId: input.sessionId,
    model: input.model,
    ttft: { p50: m?.ttft_p50, p95: m?.ttft_p95, n: m?.ttft_n ?? 0 },
    ttftByModel: byModel,
    e2e: { p50: m?.e2e_p50, p95: m?.e2e_p95, n: m?.e2e_n ?? 0 },
    gen: { p95: m?.gen_p95, n: m?.gen_n ?? 0 },
    tps: input.tps && Number.isFinite(input.tps) && input.tps > 0 ? input.tps : undefined,
    split:
      modelMs + toolMs > 0
        ? { modelMs, toolMs, toolShare: toolMs / (modelMs + toolMs) }
        : undefined,
    contextPeak:
      input.contextPeakRatio && input.contextPeakRatio > 0
        ? { ratio: input.contextPeakRatio, tokens: input.contextPeakTokens }
        : undefined,
  };
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
  metrics: Record<TrendKey, PerfStat>;
}

/**
 * 一组会话的统计。分位数口径：每会话贡献一个值（该会话自己的 p50/p95/均速），
 * 再在这些值上取分位 —— 与 northstar 快照同口径（p95 取每会话 p95 的 p95）。
 */
export function windowStats(rows: SessionIndexEntry[]): WindowStats {
  return {
    sessions: rows.length,
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
export const MIN_TREND_SAMPLES = 5;
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

/** 增量行（还在跑 / 崩溃）只算到一半，混进来会把延迟与成本系统性拉低 */
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
  versions: Array<{ version: string } & WindowStats>;
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

export function buildByVersion(index: SessionIndexEntry[], limit: number): VersionReport {
  const rows = settled(index);
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
    .map((version) => ({ version, ...windowStats(groups.get(version)!) }));
  return { versions, rowsWithoutVersion };
}

// ───────────────────────────── 渲染 ─────────────────────────────

/** 无值统一渲染「—」；由调用方决定要不要附「无样本」字样 */
export function fmtValue(v: number | undefined, unit: PerfUnit): string {
  if (v === undefined) return "—";
  switch (unit) {
    case "ms":
      return v >= 10_000
        ? `${(v / 1000).toFixed(0)}s`
        : v >= 1000
          ? `${(v / 1000).toFixed(1)}s`
          : `${Math.round(v)}ms`;
    case "tps":
      return `${v.toFixed(0)} tok/s`;
    case "ratio":
      return `${(v * 100).toFixed(0)}%`;
    case "usd":
      return `$${v.toFixed(v < 1 ? 3 : 2)}`;
    case "count":
      return `${Math.round(v)}`;
  }
}

function fmtStat(s: PerfStat, unit: PerfUnit): string {
  return s.value === undefined ? "无样本" : `${fmtValue(s.value, unit)} (n=${s.n})`;
}

function shortModel(model: string): string {
  return model.split("/").pop() || model;
}

export function renderSessionPerf(r: SessionPerfReport): string {
  const lines: string[] = [`性能 · 本会话 ${r.sessionId}`, "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"];
  const ms = (v: number | undefined) => fmtValue(v, "ms");
  if (r.ttft.n === 0) {
    lines.push("  首字延迟 TTFT   无样本");
  } else {
    lines.push(`  首字延迟 TTFT   P50 ${ms(r.ttft.p50)}  P95 ${ms(r.ttft.p95)}  (n=${r.ttft.n})`);
  }
  // 多 model（fallback / 切模型）时必须分开看：跨 model 的 TTFT 汇总是假数
  if (r.ttftByModel.length > 1 || r.ttftByModel.some((m) => m.ttfbP50 !== undefined)) {
    for (const m of r.ttftByModel) {
      const ttfb = m.ttfbP50 !== undefined ? `  TTFB P50 ${ms(m.ttfbP50)}` : "";
      lines.push(
        `    ${shortModel(m.model)}: TTFT P50 ${ms(m.p50)} / P95 ${ms(m.p95)} (n=${m.n})${ttfb}`,
      );
    }
  }
  lines.push(
    r.gen.n === 0
      ? "  生成耗时        无样本"
      : `  生成耗时        P95 ${ms(r.gen.p95)}  (n=${r.gen.n}，响应头→流结束，单次请求)`,
  );
  lines.push(`  生成速度        ${r.tps !== undefined ? fmtValue(r.tps, "tps") : "无样本"}`);
  lines.push(
    r.e2e.n === 0
      ? "  端到端          无样本"
      : `  端到端          P50 ${ms(r.e2e.p50)}  P95 ${ms(r.e2e.p95)}  (n=${r.e2e.n}，回车→最终答复)`,
  );
  if (r.split) {
    const toolPct = Math.round(r.split.toolShare * 100);
    lines.push(
      `  时间花在哪      模型 ${100 - toolPct}% (${ms(r.split.modelMs)}) / 工具 ${toolPct}% (${ms(r.split.toolMs)})`,
    );
  } else {
    lines.push("  时间花在哪      无样本");
  }
  if (r.contextPeak) {
    const tok = r.contextPeak.tokens
      ? `（${Math.round(r.contextPeak.tokens / 1000)}k tokens）`
      : "";
    lines.push(`  上下文峰值      ${fmtValue(r.contextPeak.ratio, "ratio")}${tok}`);
  }
  lines.push("", "跨会话趋势：/perf --days 7    按版本：/perf --by-version    排障：/trace");
  return lines.join("\n");
}

const VERDICT_MARK: Record<Verdict, string> = {
  better: "改善",
  worse: "变差",
  same: "≈",
  insufficient: "样本不足",
};

function fmtChange(row: TrendRow): string {
  if (row.verdict === "insufficient") return VERDICT_MARK.insufficient;
  if (row.verdict === "same") return "≈";
  const sign = row.change! > 0 ? "▲" : "▼";
  return `${sign} ${Math.abs(row.change! * 100).toFixed(0)}% ${VERDICT_MARK[row.verdict]}${row.warn ? " ⚠" : ""}`;
}

function pad(s: string, w: number): string {
  // 中文按 2 列宽估算，保证表格大致对齐
  let width = 0;
  for (const ch of s) width += /[^\x00-\xff]/.test(ch) ? 2 : 1;
  return s + " ".repeat(Math.max(1, w - width));
}

export function renderTrend(t: TrendReport): string {
  const lines: string[] = [
    `性能趋势 · 近 ${t.days} 天 vs 前 ${t.days} 天`,
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    `  会话数：本期 ${t.current.sessions} / 上期 ${t.previous.sessions}（不含未正常结束的会话）`,
  ];
  if (t.current.sessions === 0) {
    lines.push("", "  本期没有已结束的会话。");
    return lines.join("\n");
  }
  lines.push("");
  lines.push(`  ${pad("指标", 20)}${pad("本期", 18)}${pad("上期", 18)}变化`);
  for (const row of t.rows) {
    lines.push(
      `  ${pad(row.label, 20)}${pad(fmtStat(row.current, row.unit), 18)}${pad(fmtStat(row.previous, row.unit), 18)}${fmtChange(row)}`,
    );
  }
  if (t.ttftByModel.length > 0) {
    lines.push("", "  TTFT 按模型（本期，每会话 P50 的中位数）：");
    for (const m of t.ttftByModel.slice(0, 6)) {
      lines.push(
        `    ${pad(shortModel(m.model), 28)}${m.p50 !== undefined ? fmtValue(m.p50, "ms") : "无样本"}  (${m.n}/${m.sessions} 会话有样本)`,
      );
    }
  }
  lines.push(
    "",
    `  判读：两侧都 ≥${MIN_TREND_SAMPLES} 个样本才下结论；变化 <${TREND_NOISE_RATIO * 100}% 记 ≈；退步 ≥${TREND_WARN_RATIO * 100}% 标 ⚠。`,
    "  P95 = 每会话 P95 的 P95，分位数不做平均。模型混用时 TTFT 总数只作参考，以按模型那几行为准。",
  );
  return lines.join("\n");
}

export function renderByVersion(v: VersionReport): string {
  const lines: string[] = ["性能 · 按版本", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"];
  if (v.versions.length === 0) {
    lines.push("  没有带版本号的已结束会话。");
  } else {
    lines.push(
      `  ${pad("版本", 12)}${pad("会话", 6)}${pad("TTFT P50", 16)}${pad("TTFT P95", 16)}${pad("tok/s P50", 18)}端到端 P95`,
    );
    for (const ver of v.versions) {
      const m = ver.metrics;
      lines.push(
        `  ${pad(ver.version, 12)}${pad(String(ver.sessions), 6)}${pad(fmtStat(m.ttft_p50, "ms"), 16)}${pad(fmtStat(m.ttft_p95, "ms"), 16)}${pad(fmtStat(m.tps_p50, "tps"), 18)}${fmtStat(m.e2e_p95, "ms")}`,
      );
    }
  }
  if (v.rowsWithoutVersion > 0) {
    lines.push("", `  另有 ${v.rowsWithoutVersion} 个会话缺版本号（早期版本写的行），未计入上表。`);
  }
  return lines.join("\n");
}
