/**
 * /perf 面板渲染（PR-B）。输入是 core `perf-report.ts` 的报告模型，输出一段可直接塞进
 * CommandOutputDialog（走 `<Ansi>` 解析）或无头 stdout 的文本。
 *
 * 为什么渲染放 cli 不放 core：列宽要用 `string-width`（中文、`—`、`≈` 的真实列宽），
 * 颜色要跟终端能力走 —— 这两样 core 都不该依赖（`bun run lint:boundary`）。
 *
 * 版式规则（方案 4.2）：第一行只放会话身份、第二块直接给结论；数字右对齐；
 * 警示只用黄色且必须能行动；窄终端（<80 列）去掉横条、P99 列和工具「最长」列；
 * 无色模式（无头 / 非 TTY / NO_COLOR）结构不变、不出 ANSI。
 */
import stringWidth from "string-width";
import {
  fmtDuration,
  MIN_P99_SAMPLES,
  MIN_TREND_SAMPLES,
  TREND_NOISE_RATIO,
  TREND_WARN_RATIO,
  VERSION_INCOMPLETE_NOTE_RATIO,
  type Dist,
  type PerfStat,
  type PerfUnit,
  type SessionPerfReport,
  type TrendReport,
  type TrendRow,
  type VersionReport,
} from "@sid-code/core/trace/perf-report.ts";

export interface RenderEnv {
  /** 面板内容区可用列数 */
  width: number;
  color: boolean;
}

/** 窄于它就去掉横条、P99 列、工具「最长」列 */
export const NARROW_WIDTH = 80;

type Tone = "bright" | "dim" | "blue" | "yellow" | "green" | "red";
const SGR: Record<Tone, [string, string]> = {
  bright: ["\x1b[1m", "\x1b[22m"],
  dim: ["\x1b[2m", "\x1b[22m"],
  blue: ["\x1b[34m", "\x1b[39m"],
  yellow: ["\x1b[33m", "\x1b[39m"],
  green: ["\x1b[32m", "\x1b[39m"],
  red: ["\x1b[31m", "\x1b[39m"],
};

export function painter(color: boolean) {
  return (tone: Tone, s: string): string => (color ? `${SGR[tone][0]}${s}${SGR[tone][1]}` : s);
}

/** 显示宽度（去掉 ANSI 后按 string-width 算），不是 `.length` */
export function width(s: string): number {
  return stringWidth(s);
}

export function padEnd(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - width(s)));
}

export function padStart(s: string, w: number): string {
  return " ".repeat(Math.max(0, w - width(s))) + s;
}

/**
 * 简单表格：第一列左对齐，其余列右对齐；列宽取该列最大显示宽度。
 * `tail` 是行尾注释（暗色），不参与对齐。
 */
export function table(
  rows: Array<{ cells: string[]; tail?: string }>,
  indent = "  ",
  gap = 2,
): string[] {
  const cols = Math.max(0, ...rows.map((r) => r.cells.length));
  const widths = Array.from({ length: cols }, (_, i) =>
    Math.max(0, ...rows.map((r) => (r.cells[i] !== undefined ? width(r.cells[i]!) : 0))),
  );
  return rows.map((r) => {
    const body = r.cells
      .map((c, i) => (i === 0 ? padEnd(c, widths[0]!) : padStart(c, widths[i]!)))
      .join(" ".repeat(gap));
    return (indent + body + (r.tail ? "   " + r.tail : "")).trimEnd();
  });
}

// eslint-disable-next-line no-control-regex
const SGR_RE = /\x1b\[[0-9;]*m/y;

/**
 * 超宽行按显示宽度折行，续行缩进 6 格。面板按行交给 `<Ansi>` 解析，颜色不跨行，
 * 所以折断处要把当前生效的 SGR 在续行开头重放一次、在断行末尾复位。
 * 不做「按词断」：中文没有空格，按列硬断是唯一一致的规则。
 */
export function wrapLines(lines: string[], maxWidth: number, contIndent = 6): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (width(line) <= maxWidth) {
      out.push(line);
      continue;
    }
    let cur = "";
    let curW = 0;
    let active: string[] = [];
    const flush = () => {
      out.push(cur + (active.length ? "\x1b[0m" : ""));
      cur = " ".repeat(contIndent) + active.join("");
      curW = contIndent;
    };
    let i = 0;
    while (i < line.length) {
      SGR_RE.lastIndex = i;
      const m = SGR_RE.exec(line);
      if (m) {
        cur += m[0];
        // 22/39/0 是复位码：清掉已记录的开启码；其余记为生效
        if (/\x1b\[(0|22|39)m/.test(m[0])) active = [];
        else active.push(m[0]);
        i += m[0].length;
        continue;
      }
      const ch = String.fromCodePoint(line.codePointAt(i)!);
      const w = width(ch);
      if (curW + w > maxWidth && curW > contIndent) flush();
      cur += ch;
      curW += w;
      i += ch.length;
    }
    if (cur.trim()) out.push(cur);
  }
  return out;
}

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/** 八分之一格横条：4% 和 0% 要画得不一样（整格 `█░` 分不开） */
export function bar(ratio: number, cells: number): string {
  const total = Math.max(0, Math.min(1, ratio)) * cells * 8;
  let eighths = Math.round(total);
  if (eighths === 0 && ratio > 0) eighths = 1;
  return "█".repeat(Math.floor(eighths / 8)) + EIGHTHS[eighths % 8];
}

/** 一个延迟分布的 P50/P95/P99 三格。n<5 由调用方改成列样本 */
export function distCells(d: Dist, narrow: boolean): string[] {
  const p99 = d.n >= MIN_P99_SAMPLES ? fmtDuration(d.p99) : "—";
  const cells = [fmtDuration(d.p50), fmtDuration(d.p95)];
  if (!narrow) cells.push(p99);
  return cells;
}

const PRIMARY_LABEL = { ttfb: "等首字节", gen: "模型生成", tool: "工具", other: "其他" } as const;

function hhmmss(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return undefined;
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((x) => String(x).padStart(2, "0"))
    .join(":");
}

const fmtInt = (n: number) => n.toLocaleString("en-US");

export function renderSessionPerf(r: SessionPerfReport, env: RenderEnv): string {
  const c = painter(env.color);
  const narrow = env.width < NARROW_WIDTH;
  const L: string[] = [];
  const h = r.header;

  // ── 身份行 ──
  const meta = [r.model.split("/").pop() || r.model];
  if (h.wallMs !== undefined) meta.push(fmtDuration(h.wallMs));
  if (h.activeMs !== undefined) meta.push(`活跃 ${fmtDuration(h.activeMs)}`);
  meta.push(`主循环 ${h.mainCalls} 次调用`);
  const at = hhmmss(h.snapshotAt);
  meta.push(h.live ? `进行中${at ? ` · 截至 ${at}` : ""}` : "已结束");
  L.push(`${c("bright", h.shortId)}  ${c("dim", meta.join(" · "))}`, "");

  // ── 结论 ──
  const v = r.verdict;
  const head =
    v.primary === "insufficient"
      ? `主循环调用不足 5 次，样本不足，不下结论`
      : `慢在${c("bright", `${PRIMARY_LABEL[v.primary]}（${Math.round((v.share ?? 0) * 100)}%）`)}` +
        (v.reasons[0] ? `：${v.reasons[0]}` : "");
  L.push(`${c("blue", "结论")}  ${head}`);
  for (const reason of v.reasons.slice(v.primary === "insufficient" ? 0 : 1))
    L.push(`      ${c("dim", reason)}`);
  for (const w of v.warnings) L.push(`      ${c("yellow", w)}`);
  L.push("");

  // ── 时间去哪了 ──
  const t = r.timeSplit;
  if (t) {
    const title = c("blue", "时间去哪了");
    const note = c("dim", `合计 = 活跃时间 ${fmtDuration(t.activeMs)}`);
    L.push(
      narrow ? title : padEnd(title, Math.max(width(title) + 2, env.width - width(note))) + note,
    );
    const barCells = Math.max(10, Math.min(30, env.width - 50));
    const parts: Array<[string, number, string?]> = [
      ["等首字节", t.ttfbMs],
      ["生成", t.genMs],
      ["工具", t.toolMs],
      ["其他", t.otherMs, "轮间开销、权限确认"],
    ];
    L.push(
      ...table(
        parts.map(([label, ms, tail]) => {
          const ratio = t.activeMs > 0 ? ms / t.activeMs : 0;
          const cells = [label];
          if (!narrow) cells.push(padEnd(bar(ratio, barCells), barCells));
          cells.push(`${Math.round(ratio * 100)}%`, fmtDuration(ms));
          return { cells, tail: tail ? c("dim", tail) : undefined };
        }),
      ),
      "",
    );
  }

  // ── 延迟 ──
  const lat = r.latency;
  const head2 = ["", "P50", "P95"];
  if (!narrow) head2.push("P99");
  head2.push("n");
  type Row = { cells: string[]; tail?: string };
  const rows: Row[] = [];
  const distRow = (label: string, d: Dist, tail?: string): Row => {
    if (d.n === 0) return { cells: [label, "无样本"], tail };
    if (d.samples) {
      // n<5：不渲染分位数，直接列样本（D5）。样本串放行尾，不进 P50 列（否则把整列撑宽）
      return {
        cells: [label],
        tail: [
          `${d.samples.map(fmtDuration).join("、")}  ${c("dim", `n=${d.n}，样本 <5 直接列出`)}`,
          tail,
        ]
          .filter(Boolean)
          .join(c("dim", " · ")),
      };
    }
    return { cells: [label, ...distCells(d, narrow), String(d.n)], tail };
  };
  rows.push(distRow("首字 TTFT", lat.ttft));
  if (lat.ttftByCache) {
    const { hit, miss } = lat.ttftByCache;
    const slow = hit.p50 && miss.p50 ? `（慢 ${(miss.p50 / hit.p50).toFixed(1)}×）` : "";
    rows.push(
      distRow(
        "  缓存命中",
        hit,
        c("dim", `未命中 ${miss.n} 次，P50 ${fmtDuration(miss.p50)}${slow}`),
      ),
    );
  }
  if (lat.headers) rows.push(distRow("首字节 TTFB", lat.headers));
  rows.push(distRow("单次生成", lat.gen));
  rows.push({
    cells: ["生成速度", lat.tps !== undefined ? `${Math.round(lat.tps)} tok/s` : "无样本"],
    tail:
      lat.reasoningShare !== undefined
        ? c("dim", `thinking 占输出 ${Math.round(lat.reasoningShare * 100)}%`)
        : undefined,
  });
  const intr = lat.e2eInterrupted
    ? c(
        "dim",
        `另有 ${lat.e2eInterrupted.n} 轮中断${lat.e2eInterrupted.maxMs ? `（最长 ${fmtDuration(lat.e2eInterrupted.maxMs)}）` : ""}`,
      )
    : undefined;
  rows.push(distRow("端到端（回车→答复）", lat.e2e, intr));
  // 表头与数据一起参与列宽计算；段标题占首列位置，列名暗色
  const [hdr, ...body] = table([{ cells: head2 }, ...rows.map((x) => ({ cells: x.cells }))]);
  const colHead2 = hdr!.trimStart();
  L.push(padEnd(c("blue", "延迟"), width(hdr!) - width(colHead2)) + c("dim", colHead2));
  body.forEach((line, i) => L.push(rows[i]!.tail ? `${line}   ${rows[i]!.tail}` : line));
  L.push("");

  // ── 按模型（只在 >1 个模型时）：跨 model 的 TTFT 汇总只作参考，TTFB 只能在同 model 内看 ──
  if (r.byModel.length > 1) {
    const mh = ["", "TTFT P50", "TTFT P95", "TTFB P50", "n"];
    const ml = table([
      { cells: mh },
      ...r.byModel.map(({ model, stats }) => ({
        cells: [
          model.split("/").pop() || model,
          fmtDuration(stats.ttft_p50),
          fmtDuration(stats.ttft_p95),
          fmtDuration(stats.ttfb_p50),
          String(stats.n),
        ],
      })),
    ]);
    const mHead = ml[0]!.trimStart();
    L.push(
      padEnd(c("blue", "按模型"), width(ml[0]!) - width(mHead)) + c("dim", mHead),
      ...ml.slice(1),
      "",
    );
  }

  // ── 最慢的调用 ──
  if (r.slowest.length > 0) {
    L.push(c("blue", "最慢的调用"));
    L.push(
      ...table(
        r.slowest.map((s) => ({
          cells: [
            `#${s.index}`,
            fmtDuration(s.elapsedMs),
            // 标签与数字分两格：数字列右对齐，标签不跟着缩进
            "输出",
            s.outputTokens !== undefined ? `${fmtInt(s.outputTokens)} tok` : "—",
            "首字",
            s.ttftMs !== undefined ? fmtDuration(s.ttftMs) : "—",
          ],
        })),
      ).map((line, i) => {
        const s = r.slowest[i]!;
        if (!s.unpaired) return line;
        const when = s.unpairedAtMs !== undefined ? `${fmtDuration(s.unpairedAtMs)} 时` : "";
        const prog = s.stillProgressing ? "，流一直在推进" : "";
        return `${line}   ${c("dim", `${when}触发「慢响应」提示${prog}`)}`;
      }),
    );
    const e = r.events;
    const evBits: string[] = [];
    if (e.stalls) evBits.push(`停滞提升 ${e.stalls} 次`);
    if (e.timeouts) evBits.push(`超时 ${e.timeouts} 次`);
    if (e.retries) evBits.push(`重试 ${e.retries} 次`);
    if (e.unpaired && !r.slowest.some((s) => s.unpaired))
      evBits.push(`慢响应提示 ${e.unpaired} 次`);
    if (evBits.length > 0) L.push(`  ${c("dim", evBits.join(" · "))}`);
    L.push("");
  }

  // ── 工具 ──
  if (r.tools.length > 0) {
    const TOP = 5;
    const top = r.tools.slice(0, TOP);
    const rest = r.tools.slice(TOP);
    const hdr = ["", "次数", "合计"];
    if (!narrow) hdr.push("最长");
    hdr.push("失败");
    const lines = table([
      { cells: hdr },
      ...top.map((t) => {
        const cells = [t.name, String(t.n), fmtDuration(t.totalMs)];
        if (!narrow) cells.push(fmtDuration(t.maxMs));
        cells.push(String(t.failed));
        return { cells };
      }),
    ]);
    // 段标题与列名放同一行：标题占掉首列的位置（缩进 2 格之外），列名暗色
    const colHead = lines[0]!.trimStart();
    const lead = width(lines[0]!) - width(colHead);
    L.push(padEnd(c("blue", "工具"), lead) + c("dim", colHead));
    lines.slice(1).forEach((line, i) => {
      const t = top[i]!;
      // 高失败率的那一格染黄：失败数在行尾，替换最后一个数字
      const bad = t.n >= 3 && t.failed / t.n >= 0.5;
      L.push(bad ? line.replace(/(\d+)$/, (m) => c("yellow", m)) : line);
    });
    if (rest.length > 0) {
      const n = rest.reduce((a, t) => a + t.n, 0);
      const ms = rest.reduce((a, t) => a + t.totalMs, 0);
      L.push(`  ${c("dim", `其余 ${rest.length} 种 ${n} 次，合计 ${fmtDuration(ms)}`)}`);
    }
    L.push("");
  }

  // ── 后台辅助（不计入上面的数字）──
  const side = r.side;
  if (side.groups.length > 0 || side.subagent) {
    L.push(`${c("blue", "后台辅助")}  ${c("dim", "不计入上面的数字")}`);
    const rows3 = side.groups.map((g) => ({
      cells: [
        g.label,
        `${g.n} 次`,
        g.ttftP50 !== undefined ? `首字 P50 ${fmtDuration(g.ttftP50)}` : "",
      ],
      tail:
        g.aborted > 0
          ? c(
              "yellow",
              `${g.aborted} 次未完成就被中止${g.abortedMaxMs !== undefined ? `（最长 ${fmtDuration(g.abortedMaxMs)}）` : ""}`,
            )
          : undefined,
    }));
    if (side.subagent) {
      const sa = side.subagent;
      rows3.push({
        cells: [
          "子代理",
          `${sa.fetches} 次`,
          sa.ttftP50 !== undefined ? `首字 P50 ${fmtDuration(sa.ttftP50)}` : "",
        ],
        tail: sa.genMs > 0 ? c("dim", `生成合计 ${fmtDuration(sa.genMs)}`) : undefined,
      });
    }
    const lines = table(rows3.map((x) => ({ cells: x.cells })));
    lines.forEach((line, i) => L.push(rows3[i]!.tail ? `${line}   ${rows3[i]!.tail}` : line));
    L.push("");
  }

  // ── 上下文 ──
  if (r.contextPeak) {
    const cp = r.contextPeak;
    const detail =
      cp.tokens !== undefined && cp.window
        ? `（${fmtInt(cp.tokens)} / ${fmtInt(cp.window)}）`
        : cp.tokens !== undefined
          ? `（${fmtInt(cp.tokens)} tokens）`
          : "";
    L.push(`${c("blue", "上下文")}  峰值 ${Math.round(cp.ratio * 100)}%${detail}`, "");
  }

  L.push(c("dim", "/perf --days 7 看趋势 · /perf --by-version 按版本 · /trace 看单次请求详情"));
  return wrapLines(L, env.width).join("\n");
}

// ───────────────────────────── 跨会话视图 ─────────────────────────────

/** 跨会话数值格式。时长复用会话视图的 fmtDuration，单位一致 */
export function fmtValue(v: number | undefined, unit: PerfUnit): string {
  if (v === undefined) return "—";
  switch (unit) {
    case "ms":
      return fmtDuration(v);
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

function fmtChange(row: TrendRow, c: ReturnType<typeof painter>): string {
  if (row.verdict === "insufficient") return c("dim", "样本不足");
  if (row.verdict === "same") return c("dim", "≈");
  const sign = row.change! > 0 ? "▲" : "▼";
  const text = `${sign} ${Math.abs(row.change! * 100).toFixed(0)}% ${row.verdict === "worse" ? "变差" : "改善"}${row.warn ? " ⚠" : ""}`;
  return c(row.verdict === "worse" ? "red" : "green", text);
}

const shortModel = (m: string) => m.split("/").pop() || m;

export function renderTrend(t: TrendReport, env: RenderEnv): string {
  const c = painter(env.color);
  const L: string[] = [
    c("bright", `性能趋势 · 近 ${t.days} 天 vs 前 ${t.days} 天`),
    `  会话数：本期 ${t.current.sessions} / 上期 ${t.previous.sessions}${c("dim", "（不含还在跑或崩溃未收尾的会话；中断、报错收尾的仍计入）")}`,
  ];
  // PR-A（A8）：新老口径混合窗口。不换算（老行无从重算），只把混了多少摆出来。
  const legacyNotes: string[] = [];
  if (t.current.legacyScopeSessions > 0)
    legacyNotes.push(`本期含 ${t.current.legacyScopeSessions} 个`);
  if (t.previous.legacyScopeSessions > 0)
    legacyNotes.push(`上期含 ${t.previous.legacyScopeSessions} 个`);
  if (legacyNotes.length > 0) {
    L.push(
      `  ${c("dim", `口径：${legacyNotes.join("、")}旧口径会话（TTFT / 生成耗时含后台调用，偏慢），新旧对比会显得变快。`)}`,
    );
  }
  if (t.current.sessions === 0) {
    L.push("", "  本期没有已收尾的会话。");
    return L.join("\n");
  }
  L.push("");
  const rows = t.rows.map((row) => ({
    cells: [row.label, fmtStat(row.current, row.unit), fmtStat(row.previous, row.unit)],
    tail: fmtChange(row, c),
  }));
  const lines = table([
    { cells: ["指标", "本期", "上期"] },
    ...rows.map((r) => ({ cells: r.cells })),
  ]);
  L.push(c("dim", `${lines[0]}   变化`));
  lines.slice(1).forEach((line, i) => L.push(`${line}   ${rows[i]!.tail}`));
  if (t.ttftByModel.length > 0) {
    L.push("", `  ${c("blue", "TTFT 按模型")}  ${c("dim", "本期，每会话 P50 的中位数")}`);
    L.push(
      ...table(
        t.ttftByModel.slice(0, 6).map((m) => ({
          cells: [shortModel(m.model), m.p50 !== undefined ? fmtValue(m.p50, "ms") : "无样本"],
          tail: c("dim", `${m.n}/${m.sessions} 会话有样本`),
        })),
        "    ",
      ),
    );
  }
  L.push(
    "",
    c(
      "dim",
      `  判读：两侧都 ≥${MIN_TREND_SAMPLES} 个样本才下结论；变化 <${TREND_NOISE_RATIO * 100}% 记 ≈；退步 ≥${TREND_WARN_RATIO * 100}% 标 ⚠。`,
    ),
    c(
      "dim",
      "  P95 = 每会话 P95 的 P95，分位数不做平均。模型混用时 TTFT 总数只作参考，以按模型那几行为准。",
    ),
  );
  return wrapLines(L, env.width).join("\n");
}

export function renderByVersion(v: VersionReport, env: RenderEnv): string {
  const c = painter(env.color);
  const narrow = env.width < NARROW_WIDTH;
  const L: string[] = [c("bright", "性能 · 按版本")];
  if (v.versions.length === 0) {
    L.push("  没有带版本号的已收尾会话。");
  } else {
    // D14：补「生成 P95」「工具/会话 P50」两列；窄终端省略
    const hdr = ["版本", "会话", "TTFT P50", "TTFT P95", "tok/s P50", "端到端 P95"];
    if (!narrow) hdr.push("生成 P95", "工具/会话 P50");
    const val = (s: PerfStat, unit: PerfUnit) =>
      s.value === undefined ? "—" : fmtValue(s.value, unit);
    const rows = v.versions.map((ver) => {
      const m = ver.metrics;
      const cells = [
        ver.version,
        String(ver.sessions),
        val(m.ttft_p50, "ms"),
        val(m.ttft_p95, "ms"),
        val(m.tps_p50, "tps"),
        val(m.e2e_p95, "ms"),
      ];
      if (!narrow) cells.push(val(m.gen_p95, "ms"), val(m.tool_p50, "ms"));
      return { cells };
    });
    const lines = table([{ cells: hdr }, ...rows]);
    L.push("", c("dim", lines[0]!), ...lines.slice(1));
    // 整列无样本的版本：说明是当时还没有该字段，不是 0
    const noTps = v.versions
      .filter((ver) => ver.metrics.tps_p50.value === undefined)
      .map((x) => x.version);
    const notes: string[] = [];
    if (noTps.length > 0)
      notes.push(
        `「—」= 该版本的会话没有这项数据（早期版本没写进索引），不是 0。tok/s 缺：${noTps.join("、")}`,
      );
    // D12：incomplete 行占比高的版本，样本偏少
    for (const ver of v.versions) {
      const total = ver.sessions + ver.incompleteSessions;
      if (total > 0 && ver.incompleteSessions / total > VERSION_INCOMPLETE_NOTE_RATIO) {
        notes.push(
          `${ver.version} 有 ${ver.incompleteSessions}/${total} 行未收尾（可能是当时的写入缺陷），未计入，样本偏少`,
        );
      }
    }
    if (notes.length > 0) L.push("", ...notes.map((n) => `  ${c("dim", n)}`));
  }
  if (v.rowsWithoutVersion > 0) {
    L.push("", `  另有 ${v.rowsWithoutVersion} 个会话缺版本号（早期版本写的行），未计入上表。`);
  }
  // PR-A（A8）：哪些版本行是旧口径。按行判（perf_scope），不按版本号硬编码切换点 ——
  // dev 构建与正式版共用版本号，按号切会把同一版本的新老行判错。
  const legacy = v.versions.filter((ver) => ver.legacyScopeSessions > 0);
  if (legacy.length > 0) {
    const names = legacy.map((ver) => ver.version).join("、");
    L.push("", `  ${names} 含旧口径会话：TTFT / 生成耗时含后台调用，与之后的版本不可直接比。`);
  }
  return wrapLines(L, env.width).join("\n");
}
