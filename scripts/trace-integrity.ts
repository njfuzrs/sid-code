#!/usr/bin/env bun
/**
 * trace-integrity —— traces.jsonl 的结构完整性判据（X1H2 T4）
 *
 * 交付两条判据，供 T1（信号退出丢根）与 T2（工具 span 事后补建）验收出数：
 *   1. 每个 trace 恰好一个根
 *   2. 没有找不到的父（parentSpanId 指向的 span 就在本地现存文件里）
 *
 * 设计取舍（每条都是踩过或算过才定的）：
 *
 * 1. **必须合并轮转文件再判。** 父 span 可能落在 `traces.1.jsonl`、子 span 落在
 *    `traces.jsonl`，只看当前文件会把正常父子判成悬空。代价是已删除的更早轮转
 *    文件里的父仍会被判悬空 —— 输出里显式声明「只在现存文件内查找」，不假装能判全。
 *
 * 2. **「进行中」不算违例。** 根 span 只在 `end()` 时入队落盘（`SpanHandle.end()`
 *    → `enqueueSpan`，见 `telemetry/bus.ts` 关于「入队 ≠ 落盘」的注释），正在跑的
 *    会话必然还没有根。判收尾只认会话 metadata 的 `end_time` / `end_source`，
 *    与 `trace/builder.ts:1011-1013`（S12）同一口径；找不到会话目录时用「最后
 *    span 距今 < 60s」兜底。
 *
 * 3. **无根 trace 只能用时间窗关联会话。** `gen_ai.conversation.id` 只挂在根上，
 *    子 span（chat / execute_tool）不带，所以无根 trace 没有会话 id 可用。按会话
 *    窗口 `[start_time, end_time]` 与 trace 首 span 比对，±1s 容差沿用剖析附 B
 *    的口径。输出里标明匹配方式（conversation_id / 时间窗 / 未知），不把推断当事实。
 *
 * 4. **默认 exit 0。** 这是取数工具不是运行时检测器（文档 T4 明确不做检测器），
 *    有违例只报告。`--strict` 留给将来接 CI 时用。
 *
 * 用法:
 *   bun scripts/trace-integrity.ts                     # 全量报告
 *   bun scripts/trace-integrity.ts --days 7            # 只看最近 7 天开始的 trace
 *   bun scripts/trace-integrity.ts --json              # 机器可读
 *   bun scripts/trace-integrity.ts --strict            # 有违例时 exit 1
 *   bun scripts/trace-integrity.ts --dir <遥测目录> --sessions <会话目录>  # 测试/异机
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sidPaths } from "@sid-code/core/config/paths.ts";

/** 时间窗匹配容差：剖析附 B 用的 ±1s（会话窗口与缺根 trace 首 span 比对） */
const TIME_WINDOW_TOLERANCE_MS = 1_000;
/** 找不到会话 metadata 时，最后 span 距今多久内视为「进行中」 */
const IN_PROGRESS_TAIL_MS = 60_000;

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name?: string;
  kind?: string;
  startTime?: number;
  endTime?: number;
  attributes?: Record<string, unknown>;
}

export interface SessionMeta {
  sessionId: string;
  startMs?: number;
  endMs?: number;
  endSource?: string;
  totalApiCalls?: number;
  /** 是否已收尾：与 trace/builder.ts:1011-1013 同口径，end_time 或 end_source 任一存在 */
  closed: boolean;
}

export interface TraceView {
  traceId: string;
  spans: Span[];
  roots: Span[];
  firstStart: number;
  lastEnd: number;
  /** 关联到的会话；how 标明是精确 id 还是时间窗推断 */
  session?: SessionMeta;
  sessionHow: "conversation_id" | "time_window" | "in_progress" | "none";
}

export interface Violation {
  kind: "zero_root" | "multi_root" | "dangling_parent";
  traceId: string;
  firstStart: number;
  spanCount: number;
  detail: string;
  endSource?: string;
  sessionId?: string;
}

export interface IntegrityReport {
  telemetryDir: string;
  files: string[];
  spanCount: number;
  traceCount: number;
  badLines: number;
  range: { from: number; to: number } | null;
  criterion1: {
    exactlyOneRoot: number;
    zeroRootClosed: number;
    zeroRootInProgress: number;
    multiRoot: number;
  };
  criterion2: {
    /** 全部悬空 parentSpanId（去重） */
    danglingParentIds: number;
    /** 独立违例：有根 trace 里找不到父的 span 数 */
    danglingChildSpans: number;
    /** 独立违例：有根且已收尾、仍有悬空父的 trace 数 */
    traces: number;
    /** 与判据一同源：无根 trace 的悬空父（根丢了，子 span 的父自然找不到），不重复计违例 */
    fromZeroRootTraces: number;
    /** 正常：会话还在跑，父 span 尚未 end 落盘 */
    inProgressExcluded: number;
  };
  violations: Violation[];
  /** 无根且已收尾的 trace，按会话 end_source 归类（剖析附 B 的核心表） */
  noRootEndSources: Record<string, number>;
  /** 根的 name 写法分布：invoke_agent sid-code 与 invoke_agent <模型名> 两种都认 */
  rootNames: Record<string, number>;
  /** kind=invoke_agent 且无父、但 name 不是 invoke_agent 开头的异常写法（应为 0） */
  unnamedRoots: number;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** 根判定：无父 + invoke_agent + 名字是 `invoke_agent` 开头（两种历史写法都覆盖） */
export function isRootSpan(s: Span): boolean {
  return s.kind === "invoke_agent" && !s.parentSpanId && /^invoke_agent(?:\s|$)/.test(s.name ?? "");
}

/** 列出目录下全部轮转轨迹文件，旧的在前（编号越大越旧；traces.jsonl 是当前文件，排最后） */
export function listTraceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const rank = (n: string) =>
    n === "traces.jsonl" ? 0 : Number(n.match(/^traces\.(\d+)\.jsonl$/)?.[1] ?? 0);
  return readdirSync(dir)
    .filter((n) => /^traces(\.\d+)?\.jsonl$/.test(n))
    .sort((a, b) => rank(b) - rank(a))
    .map((n) => join(dir, n));
}

/** 读全部 span；坏行计数而不是静默跳过（半截写入的文件会让判据假绿） */
export function readSpans(files: string[]): { spans: Span[]; badLines: number } {
  const spans: Span[] = [];
  let badLines = 0;
  for (const f of files) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const d = JSON.parse(t) as Span;
        if (d.traceId && d.spanId) spans.push(d);
        else badLines++;
      } catch {
        badLines++;
      }
    }
  }
  return { spans, badLines };
}

/** 读会话 metadata；只认 metadata.json（session.traj 可能很大且这里不需要） */
export function readSessionMetas(dir: string): SessionMeta[] {
  if (!existsSync(dir)) return [];
  const out: SessionMeta[] = [];
  for (const id of readdirSync(dir)) {
    if (id.startsWith(".")) continue;
    const p = join(dir, id, "metadata.json");
    if (!existsSync(p)) continue;
    try {
      const m = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
      const startMs = typeof m.start_time === "string" ? Date.parse(m.start_time) : undefined;
      const endMs = typeof m.end_time === "string" ? Date.parse(m.end_time) : undefined;
      const endSource = typeof m.end_source === "string" ? m.end_source : undefined;
      out.push({
        sessionId: typeof m.session_id === "string" ? m.session_id : id,
        startMs: Number.isFinite(startMs) ? startMs : undefined,
        endMs: Number.isFinite(endMs) ? endMs : undefined,
        endSource,
        totalApiCalls: num(m.total_api_calls),
        closed: endMs !== undefined || endSource !== undefined,
      });
    } catch {
      /* 单个 metadata 坏掉不影响整体：该 trace 落到「会话未知」 */
    }
  }
  return out;
}

/** 会话 id 来自根的 conversation.id（只有根带这个属性） */
function conversationIdOf(root: Span | undefined): string | undefined {
  const v = root?.attributes?.["gen_ai.conversation.id"];
  return typeof v === "string" && v ? v : undefined;
}

/**
 * 为无根 trace 找会话：时间窗包含 trace 首 span，多个命中取窗口中心最近的。
 * 进行中的会话（无 end_time）窗口开区间，也能命中——它们在输出里单独归类。
 */
export function matchSessionByTime(
  trace: TraceView,
  sessions: SessionMeta[],
): SessionMeta | undefined {
  let best: SessionMeta | undefined;
  let bestDist = Infinity;
  for (const s of sessions) {
    if (s.startMs === undefined) continue;
    const end = s.endMs ?? Number.POSITIVE_INFINITY;
    if (trace.firstStart < s.startMs - TIME_WINDOW_TOLERANCE_MS) continue;
    if (trace.firstStart > end + TIME_WINDOW_TOLERANCE_MS) continue;
    const center = s.endMs === undefined ? s.startMs : (s.startMs + s.endMs) / 2;
    const dist = Math.abs(trace.firstStart - center);
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  return best;
}

export interface AnalyzeOptions {
  telemetryDir: string;
  sessionsDir: string;
  /** 只看首 span >= sinceMs 的 trace */
  sinceMs?: number;
  /** 读会话目录（false 时无根 trace 一律「会话未知」） */
  withSessions?: boolean;
  /** 当前时间，测试固定用；默认 Date.now() */
  now?: number;
}

export function analyze(opts: AnalyzeOptions): IntegrityReport {
  const files = listTraceFiles(opts.telemetryDir);
  const { spans, badLines } = readSpans(files);
  const since = opts.sinceMs ?? Number.NEGATIVE_INFINITY;
  const sessions = opts.withSessions === false ? [] : readSessionMetas(opts.sessionsDir);
  const sessionById = new Map(sessions.map((s) => [s.sessionId, s]));

  const byTrace = new Map<string, Span[]>();
  const spanIds = new Set<string>();
  for (const s of spans) {
    spanIds.add(s.spanId);
    const list = byTrace.get(s.traceId);
    if (list) list.push(s);
    else byTrace.set(s.traceId, [s]);
  }

  const report: IntegrityReport = {
    telemetryDir: opts.telemetryDir,
    files,
    spanCount: spans.length,
    traceCount: 0,
    badLines,
    range: null,
    criterion1: { exactlyOneRoot: 0, zeroRootClosed: 0, zeroRootInProgress: 0, multiRoot: 0 },
    criterion2: {
      danglingParentIds: 0,
      danglingChildSpans: 0,
      traces: 0,
      fromZeroRootTraces: 0,
      inProgressExcluded: 0,
    },
    violations: [],
    noRootEndSources: {},
    rootNames: {},
    unnamedRoots: 0,
  };

  const now = opts.now ?? Date.now();
  /** 有根 trace 的悬空父：独立违例（无根 trace 的悬空父归因判据一，不重复报） */
  const danglingRooted = new Map<string, number>();
  const danglingParentIds = new Set<string>();

  for (const [traceId, list] of byTrace) {
    const starts = list.map((s) => num(s.startTime)).filter((v): v is number => v !== undefined);
    const ends = list
      .map((s) => num(s.endTime) ?? num(s.startTime))
      .filter((v): v is number => v !== undefined);
    const firstStart = starts.length ? Math.min(...starts) : 0;
    const lastEnd = ends.length ? Math.max(...ends) : firstStart;
    if (firstStart < since) continue;
    report.traceCount++;
    report.range = report.range
      ? { from: Math.min(report.range.from, firstStart), to: Math.max(report.range.to, lastEnd) }
      : { from: firstStart, to: lastEnd };

    const roots = list.filter(isRootSpan);
    for (const s of list) {
      if (s.kind === "invoke_agent" && !s.parentSpanId && !isRootSpan(s)) report.unnamedRoots++;
    }
    for (const r of roots) {
      const name = r.name ?? "(无名)";
      report.rootNames[name] = (report.rootNames[name] ?? 0) + 1;
    }

    // 会话关联：有根用根上的 conversation.id 精确匹配；无根只能时间窗推断
    const view: TraceView = {
      traceId,
      spans: list,
      roots,
      firstStart,
      lastEnd,
      sessionHow: "none",
    };
    const rootCid = conversationIdOf(roots[0]);
    let meta = rootCid ? sessionById.get(rootCid) : undefined;
    if (meta) view.sessionHow = "conversation_id";
    if (!meta && roots.length === 0) {
      meta = matchSessionByTime(view, sessions);
      if (meta) view.sessionHow = "time_window";
    }
    if (meta) view.session = meta;
    /** 会话是否还在跑：根与父 span 都只在 end() 时入队，跑着的会话必然缺它们 */
    const recentlyActive = now - lastEnd < IN_PROGRESS_TAIL_MS;
    const inProgress = meta ? !meta.closed : recentlyActive;

    // ── 判据 2：悬空父 ──
    let danglingHere = 0;
    for (const s of list) {
      if (!s.parentSpanId) continue;
      if (spanIds.has(s.parentSpanId)) continue;
      danglingParentIds.add(s.parentSpanId);
      danglingHere++;
    }
    if (danglingHere > 0) {
      if (inProgress) {
        // 会话还在跑：父 span（chat / invoke_agent）尚未 end，落盘后自然不悬空
        report.criterion2.inProgressExcluded += danglingHere;
      } else if (roots.length === 0) {
        // 根丢了 → 子 span 的父自然找不到。与判据一同源，不重复计违例。
        report.criterion2.fromZeroRootTraces += danglingHere;
      } else {
        report.criterion2.danglingChildSpans += danglingHere;
        danglingRooted.set(traceId, danglingHere);
      }
    }

    // ── 判据 1：根数 ──
    if (roots.length === 1) {
      report.criterion1.exactlyOneRoot++;
      continue;
    }

    if (roots.length === 0) {
      if (inProgress) {
        report.criterion1.zeroRootInProgress++;
        continue;
      }
      report.criterion1.zeroRootClosed++;
      const endSource = meta?.endSource ?? "unknown";
      report.noRootEndSources[endSource] = (report.noRootEndSources[endSource] ?? 0) + 1;
      report.violations.push({
        kind: "zero_root",
        traceId,
        firstStart,
        spanCount: list.length,
        detail: meta ? "会话已收尾" : "找不到会话",
        endSource,
        sessionId: meta?.sessionId,
      });
      continue;
    }

    report.criterion1.multiRoot++;
    report.violations.push({
      kind: "multi_root",
      traceId,
      firstStart,
      spanCount: list.length,
      detail: `${roots.length} 个根：${roots.map((r) => r.name ?? "(无名)").join(" / ")}`,
    });
  }

  // ── 判据 2 的违例条目（只报有根 trace：无根 trace 已由 zero_root 覆盖） ──
  for (const [traceId, n] of danglingRooted) {
    const list = byTrace.get(traceId)!;
    const starts = list.map((s) => num(s.startTime)).filter((v): v is number => v !== undefined);
    report.violations.push({
      kind: "dangling_parent",
      traceId,
      firstStart: starts.length ? Math.min(...starts) : 0,
      spanCount: list.length,
      detail: `${n} 个 span 的 parentSpanId 在现存轮转文件里找不到`,
    });
  }
  report.criterion2.danglingParentIds = danglingParentIds.size;
  report.criterion2.traces = danglingRooted.size;
  report.violations.sort((a, b) => b.firstStart - a.firstStart);
  return report;
}

// ───────────────────────── 输出 ─────────────────────────

const nf = new Intl.NumberFormat("en-US");

function fmtTime(ms: number | undefined): string {
  if (!ms) return "?";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatReport(r: IntegrityReport, limit = 50): string {
  const out: string[] = [];
  const files = r.files.map((f) => f.split("/").pop()).join(" + ");
  out.push(`trace-integrity · ${fmtTime(Date.now())}`);
  out.push(`数据：${r.telemetryDir}${files ? `（${files}）` : "（无轨迹文件）"}`);
  out.push(
    `span ${nf.format(r.spanCount)} · trace ${nf.format(r.traceCount)} · ` +
      `时间范围 ${r.range ? `${fmtTime(r.range.from)} → ${fmtTime(r.range.to)}` : "—"}` +
      (r.badLines ? ` · 坏行 ${nf.format(r.badLines)}（半截写入？）` : ""),
  );
  out.push("");
  out.push("判据一：每个 trace 恰好一个根");
  out.push(`  ✅ 恰好 1 根            ${nf.format(r.criterion1.exactlyOneRoot)}`);
  out.push(`  ❌ 0 根，会话已收尾       ${nf.format(r.criterion1.zeroRootClosed)}   ← 违例`);
  out.push(
    `  ·  0 根，会话进行中       ${nf.format(r.criterion1.zeroRootInProgress)}` +
      `   （根只在 end() 时入队，不算违例）`,
  );
  out.push(`  ❌ 多根                  ${nf.format(r.criterion1.multiRoot)}   ← 违例`);
  if (r.unnamedRoots)
    out.push(
      `  ⚠️ invoke_agent 无父但名字不是 invoke_agent 开头：${r.unnamedRoots}（判据可能漏根）`,
    );
  out.push("");
  out.push("判据二：没有找不到的父（只在现存轮转文件内查找）");
  out.push(
    r.criterion2.danglingChildSpans === 0
      ? "  ✅ 有根 trace 的悬空父 0"
      : `  ❌ 有根 trace 的悬空父：涉及 ${nf.format(r.criterion2.danglingChildSpans)} 个 span / ` +
          `${nf.format(r.criterion2.traces)} 个 trace（悬空 parentSpanId ${nf.format(r.criterion2.danglingParentIds)} 个）`,
  );
  if (r.criterion2.fromZeroRootTraces > 0) {
    out.push(
      `  ·  无根 trace 的悬空父 ${nf.format(r.criterion2.fromZeroRootTraces)} 个` +
        `（根丢了子 span 的父自然找不到，与判据一同源，不重复计违例）`,
    );
  }
  if (r.criterion2.inProgressExcluded > 0) {
    out.push(
      `  ·  进行中 trace 的悬空父 ${nf.format(r.criterion2.inProgressExcluded)} 个（父 span 尚未 end，正常）`,
    );
  }

  const rootKinds = Object.entries(r.rootNames).sort((a, b) => b[1] - a[1]);
  if (rootKinds.length) {
    out.push("");
    out.push("根名写法（两种历史写法都认）");
    for (const [name, n] of rootKinds) out.push(`  ${name.padEnd(28)} ${nf.format(n)}`);
  }

  const es = Object.entries(r.noRootEndSources).sort((a, b) => b[1] - a[1]);
  if (es.length) {
    out.push("");
    out.push("无根且已收尾的 trace：会话 end_source");
    for (const [k, n] of es) out.push(`  ${k.padEnd(20)} ${nf.format(n)}`);
  }

  if (r.violations.length) {
    out.push("");
    out.push(`违例明细（共 ${r.violations.length} 条，按 trace 起始时间倒序，最多 ${limit} 条）`);
    const label = { zero_root: "无根  ", multi_root: "多根  ", dangling_parent: "悬空父" } as const;
    for (const v of r.violations.slice(0, limit)) {
      const session = v.sessionId ? `  会话=${v.sessionId}` : "";
      const endSource = v.endSource ? `  end_source=${v.endSource}` : "";
      out.push(
        `  [${label[v.kind]}] ${fmtTime(v.firstStart)}  span ${v.spanCount}  trace=${v.traceId.slice(0, 12)}  ${v.detail}${endSource}${session}`,
      );
    }
    if (r.violations.length > limit)
      out.push(`  …还有 ${r.violations.length - limit} 条，用 --limit 调大`);
  }
  return out.join("\n");
}

// ───────────────────────── CLI ─────────────────────────

export interface CliOptions {
  telemetryDir: string;
  sessionsDir: string;
  sinceMs?: number;
  json: boolean;
  strict: boolean;
  limit: number;
  withSessions: boolean;
  help: boolean;
}

/** 未知参数直接报错：静默忽略会让「flag 漏接」以「跑了但结果没变」的形态潜伏 */
export function parseArgs(argv: string[], now = Date.now()): CliOptions {
  const sessionsRoot = join(sidPaths.trajectories(), "sessions");
  const opts: CliOptions = {
    telemetryDir: sidPaths.telemetry(),
    sessionsDir: sessionsRoot,
    json: false,
    strict: false,
    limit: 50,
    withSessions: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 缺少取值`);
      return v;
    };
    switch (a) {
      case "--dir":
        opts.telemetryDir = next();
        break;
      case "--sessions":
        opts.sessionsDir = next();
        break;
      case "--days": {
        const n = Number(next());
        if (!Number.isFinite(n) || n <= 0) throw new Error(`--days 需要正数，收到 ${n}`);
        opts.sinceMs = now - n * 86_400_000;
        break;
      }
      case "--limit": {
        const n = Number(next());
        if (!Number.isInteger(n) || n <= 0) throw new Error(`--limit 需要正整数，收到 ${n}`);
        opts.limit = n;
        break;
      }
      case "--json":
        opts.json = true;
        break;
      case "--strict":
        opts.strict = true;
        break;
      case "--no-sessions":
        opts.withSessions = false;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        throw new Error(
          `未知参数：${a}（支持 --dir / --sessions / --days / --limit / --json / --strict / --no-sessions）`,
        );
    }
  }
  return opts;
}

const USAGE = `用法: bun scripts/trace-integrity.ts [选项]

判据：1) 每个 trace 恰好一个根  2) 没有找不到的父

选项:
  --dir <path>        遥测目录（默认 sidPaths.telemetry()）
  --sessions <path>   会话目录（默认 trajectories/sessions）
  --days <N>          只看最近 N 天开始的 trace
  --limit <N>         违例明细条数上限（默认 50）
  --json              机器可读输出
  --strict            有违例时 exit 1（默认 0，取数工具不阻断）
  --no-sessions       不读会话目录（无根 trace 一律「会话未知」）
  -h, --help          显示本帮助`;

function main(): void {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[trace-integrity] ${(e as Error).message}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const report = analyze({
    telemetryDir: opts.telemetryDir,
    sessionsDir: opts.sessionsDir,
    sinceMs: opts.sinceMs,
    withSessions: opts.withSessions,
  });
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReport(report, opts.limit));
  if (opts.strict && report.violations.length > 0) process.exit(1);
}

if (import.meta.main) main();
