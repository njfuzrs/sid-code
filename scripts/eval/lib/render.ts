/**
 * render.ts — DASHBOARD.md 渲染层
 *
 * 输出 GitHub-flavored markdown,含 mermaid xychart-beta 折线图与 emoji 状态映射。
 * VS Code / GitHub Web / Obsidian 均原生渲染 mermaid。
 */

import type { CaseDoc, ProjectSnapshot, WeekScore, RunRecord } from "./yaml-loader";
import { readBaseline } from "./yaml-loader";

const STATUS_ICON = {
  excellent: "✅",
  good: "🟢",
  warn: "🟡",
  poor: "🟠",
  bad: "🔴",
  pending: "–",
  error: "❌",
  timeout: "⏱️",
} as const;

function scoreIcon(score: number | null): string {
  if (score == null) return STATUS_ICON.pending;
  if (score >= 4.5) return STATUS_ICON.excellent;
  if (score >= 3.5) return STATUS_ICON.good;
  if (score >= 2.5) return STATUS_ICON.warn;
  if (score >= 1.5) return STATUS_ICON.poor;
  return STATUS_ICON.bad;
}

function fmt(score: number | null, digits = 1): string {
  if (score == null) return "–";
  return score.toFixed(digits);
}

export function renderDashboard(snapshot: ProjectSnapshot): string {
  const lines: string[] = [];
  lines.push(`# Evals Dashboard — ${snapshot.projectName}`);
  lines.push("");
  lines.push(`> 自动生成,请勿手动编辑。生成时间: \`${new Date().toISOString()}\``);
  lines.push(`> 数据源: \`evals/p*-*/\` + \`evals/_scores/\` + \`evals/_reports/\``);
  lines.push(`> 触发: 手动 \`bun run eval:dashboard\` / git pre-push hook 自动刷新`);
  lines.push("");
  lines.push("---");
  lines.push("");

  lines.push(...renderOverview(snapshot));
  lines.push("");
  lines.push(...renderCaseToolMatrix(snapshot));
  lines.push("");
  lines.push(...renderWeeklyTrends(snapshot));
  lines.push("");
  lines.push(...renderRunHistoryTrends(snapshot));
  lines.push("");
  lines.push(...renderPending(snapshot));
  lines.push("");
  lines.push(...renderAnomalies(snapshot));
  lines.push("");
  lines.push(...renderDataSources(snapshot));
  lines.push("");
  lines.push(...renderJumpLinks(snapshot));
  lines.push("");

  return lines.join("\n");
}

function renderOverview(snap: ProjectSnapshot): string[] {
  const out: string[] = [];
  const total = snap.cases.length;
  const byPriority = new Map<string, number>();
  for (const c of snap.cases) {
    const p = c.priority ?? "?";
    byPriority.set(p, (byPriority.get(p) ?? 0) + 1);
  }
  const holdoutCount = snap.cases.filter((c) => c.holdout).length;

  out.push("## 1. 总览");
  out.push("");
  out.push(`- **case 总数**: ${total} 条`);
  const prioBits: string[] = [];
  for (const p of ["P0", "P1", "P2"]) {
    const n = byPriority.get(p) ?? 0;
    if (n > 0) prioBits.push(`${p}=${n}`);
  }
  if (holdoutCount > 0) prioBits.push(`holdout=${holdoutCount}`);
  out.push(`- **优先级分布**: ${prioBits.join(" / ")}`);

  for (const tool of snap.tools) {
    let tested = 0;
    let pending = 0;
    for (const c of snap.cases) {
      const b = readBaseline(c, tool);
      if (b.status === "tested") tested++;
      else if (b.status === "pending") pending++;
    }
    out.push(`- **${tool}** 评分进度: ${tested}/${total} 已评分 (${pending} pending)`);
  }

  if (snap.allWeeks.length > 0) {
    const latestWeek = snap.allWeeks[snap.allWeeks.length - 1];
    let llmSum = 0;
    let llmCount = 0;
    let anchorSum = 0;
    let anchorCount = 0;
    for (const ws of snap.weeksByCase.values()) {
      const w = ws.find((x) => x.week === latestWeek);
      if (!w) continue;
      if (typeof w.llm === "number") {
        llmSum += w.llm;
        llmCount++;
      }
      if (typeof w.anchor === "number") {
        anchorSum += w.anchor;
        anchorCount++;
      }
    }
    out.push("");
    out.push(`### 最新一周: w${latestWeek}`);
    if (anchorCount > 0) out.push(`- Anchor 均分: **${(anchorSum / anchorCount).toFixed(2)}/5** (${anchorCount} case)`);
    if (llmCount > 0) out.push(`- LLM Judge 均分: **${(llmSum / llmCount).toFixed(2)}/5** (${llmCount} case)`);
  }

  return out;
}

function renderCaseToolMatrix(snap: ProjectSnapshot): string[] {
  const out: string[] = [];
  out.push("## 2. Case × Tool 矩阵");
  out.push("");
  out.push(`图例: ✅ ≥4.5 / 🟢 3.5-4.4 / 🟡 2.5-3.4 / 🟠 1.5-2.4 / 🔴 <1.5 / – pending / ❌ error / ⏱️ timeout`);
  out.push("");

  const latestWeek = snap.allWeeks.length > 0 ? snap.allWeeks[snap.allWeeks.length - 1] : null;
  const headerCols = ["case_id", "pri", "category"];
  for (const t of snap.tools) headerCols.push(t);
  if (latestWeek != null) headerCols.push(`w${latestWeek}.anchor`, `w${latestWeek}.llm`);

  out.push(`| ${headerCols.join(" | ")} |`);
  out.push(`| ${headerCols.map(() => "---").join(" | ")} |`);

  for (const c of snap.cases) {
    const cells: string[] = [];
    cells.push(c.id + (c.holdout ? " 🔒" : ""));
    cells.push(c.priority ?? "?");
    cells.push((c.category ?? "?").slice(0, 18));
    for (const tool of snap.tools) {
      const b = readBaseline(c, tool);
      if (b.status === "error") cells.push(STATUS_ICON.error);
      else if (b.status === "timeout") cells.push(STATUS_ICON.timeout);
      else if (b.score == null) cells.push(STATUS_ICON.pending);
      else cells.push(`${b.score} ${scoreIcon(b.score)}`);
    }
    if (latestWeek != null) {
      const ws = snap.weeksByCase.get(c.id) ?? [];
      const w = ws.find((x) => x.week === latestWeek);
      if (w) {
        cells.push(w.anchor != null ? `${fmt(w.anchor)} ${scoreIcon(w.anchor)}` : "–");
        cells.push(w.llm != null ? `${fmt(w.llm)} ${scoreIcon(w.llm)}` : "–");
      } else {
        cells.push("–", "–");
      }
    }
    out.push(`| ${cells.join(" | ")} |`);
  }

  return out;
}

function renderWeeklyTrends(snap: ProjectSnapshot): string[] {
  const out: string[] = [];
  out.push("## 3. 单 case 跨周趋势");
  out.push("");
  if (snap.allWeeks.length === 0) {
    out.push("> 当前项目无 `_scores/wNN/` 时序数据,跳过。");
    out.push("> ");
    out.push("> 提示: code-graph 项目把每周分数外部化到 `evals/_scores/wNN/case_NNN.yaml` 实现时序追踪,");
    out.push("> 推荐 sid-code 也引入这一模式(详见 plan Step 3 长期归一化)。");
    return out;
  }

  out.push(`覆盖周次: w${snap.allWeeks[0]} ~ w${snap.allWeeks[snap.allWeeks.length - 1]} (共 ${snap.allWeeks.length} 周)`);
  out.push("");
  out.push("### 3.1 综合趋势(全 case 均分)");
  out.push("");
  out.push(renderAggregateTrendChart(snap));
  out.push("");

  out.push("### 3.2 单 case 折线(仅展示有 ≥3 周数据的 case)");
  out.push("");
  let rendered = 0;
  for (const c of snap.cases) {
    const ws = snap.weeksByCase.get(c.id) ?? [];
    const validWeeks = ws.filter((w) => w.anchor != null || w.llm != null);
    if (validWeeks.length < 3) continue;
    out.push(`<details><summary><code>${c.id}</code> · ${c.priority ?? "?"} · ${c.category ?? "?"} · ${validWeeks.length} 周</summary>`);
    out.push("");
    out.push(renderCaseTrendChart(c, ws, snap.allWeeks));
    out.push("");
    out.push("</details>");
    out.push("");
    rendered++;
  }
  if (rendered === 0) {
    out.push("> 无 case 满足 ≥3 周数据条件,跳过单 case 折线。");
  }

  return out;
}

function renderAggregateTrendChart(snap: ProjectSnapshot): string {
  const weeks = snap.allWeeks;
  const anchorAvgs: Array<number | null> = [];
  const llmAvgs: Array<number | null> = [];
  for (const w of weeks) {
    let aSum = 0;
    let aCount = 0;
    let lSum = 0;
    let lCount = 0;
    for (const ws of snap.weeksByCase.values()) {
      const found = ws.find((x) => x.week === w);
      if (!found) continue;
      if (typeof found.anchor === "number") {
        aSum += found.anchor;
        aCount++;
      }
      if (typeof found.llm === "number") {
        lSum += found.llm;
        lCount++;
      }
    }
    anchorAvgs.push(aCount > 0 ? aSum / aCount : null);
    llmAvgs.push(lCount > 0 ? lSum / lCount : null);
  }

  return mermaidLineChart({
    title: "综合趋势 (anchor + llm)",
    xLabels: weeks.map((w) => `w${w}`),
    series: [
      { name: "anchor", values: anchorAvgs },
      { name: "llm", values: llmAvgs },
    ],
  });
}

function renderCaseTrendChart(c: CaseDoc, ws: WeekScore[], allWeeks: number[]): string {
  const xLabels = allWeeks.map((w) => `w${w}`);
  const anchorVals = allWeeks.map((w) => ws.find((x) => x.week === w)?.anchor ?? null);
  const llmVals = allWeeks.map((w) => ws.find((x) => x.week === w)?.llm ?? null);
  return mermaidLineChart({
    title: `${c.id} 跨周分数`,
    xLabels,
    series: [
      { name: "anchor", values: anchorVals },
      { name: "llm", values: llmVals },
    ],
  });
}

interface LineChartSpec {
  title: string;
  xLabels: string[];
  series: Array<{ name: string; values: Array<number | null> }>;
}

function mermaidLineChart(spec: LineChartSpec): string {
  // mermaid xychart-beta 不支持 null,把 null 替换为 0(visual)同时附 ASCII 表格做 fallback。
  const allHaveData = spec.series.some((s) => s.values.some((v) => typeof v === "number"));
  if (!allHaveData) return "> (无有效分数,跳过图表)";

  const lines: string[] = [];
  lines.push("```mermaid");
  lines.push("xychart-beta");
  lines.push(`    title "${spec.title}"`);
  lines.push(`    x-axis [${spec.xLabels.join(", ")}]`);
  lines.push(`    y-axis "Score" 0 --> 5`);
  for (const s of spec.series) {
    const vals = s.values.map((v) => (typeof v === "number" ? v.toFixed(2) : "0"));
    lines.push(`    line [${vals.join(", ")}]`);
  }
  lines.push("```");

  // ASCII fallback 表格
  lines.push("");
  lines.push(`<sub>fallback 表格 — ${spec.title}</sub>`);
  lines.push("");
  lines.push(`| 系列 | ${spec.xLabels.join(" | ")} |`);
  lines.push(`| --- | ${spec.xLabels.map(() => "---").join(" | ")} |`);
  for (const s of spec.series) {
    const cells = s.values.map((v) => (typeof v === "number" ? v.toFixed(2) : "–"));
    lines.push(`| ${s.name} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

function renderPending(snap: ProjectSnapshot): string[] {
  const out: string[] = [];
  out.push("## 5. 评分进度 / Pending 列表");
  out.push("");

  const pendingByTool = new Map<string, CaseDoc[]>();
  for (const tool of snap.tools) {
    const list: CaseDoc[] = [];
    for (const c of snap.cases) {
      const b = readBaseline(c, tool);
      if (b.status === "pending") list.push(c);
    }
    pendingByTool.set(tool, list);
  }

  for (const [tool, list] of pendingByTool) {
    if (list.length === 0) {
      out.push(`### ${tool}: ✅ 全部已评分`);
      out.push("");
      continue;
    }
    out.push(`### ${tool}: ${list.length} 条 pending`);
    out.push("");
    const byPrio = new Map<string, CaseDoc[]>();
    for (const c of list) {
      const p = c.priority ?? "?";
      if (!byPrio.has(p)) byPrio.set(p, []);
      byPrio.get(p)!.push(c);
    }
    for (const p of ["P0", "P1", "P2"]) {
      const arr = byPrio.get(p);
      if (!arr || arr.length === 0) continue;
      out.push(`- **${p}** (${arr.length}): ${arr.map((c) => `\`${c.id}\``).join(", ")}`);
    }
    out.push("");
  }

  return out;
}

function renderAnomalies(snap: ProjectSnapshot): string[] {
  const out: string[] = [];
  out.push("## 6. 异常 / 高方差 case");
  out.push("");
  const concerns: string[] = [];

  for (const c of snap.cases) {
    const ws = snap.weeksByCase.get(c.id) ?? [];
    const latest = ws[ws.length - 1];
    if (latest && latest.anchor != null && latest.llm != null) {
      const delta = Math.abs(latest.anchor - latest.llm);
      if (delta >= 1.0) {
        concerns.push(`- **|Δ| ≥ 1.0**: \`${c.id}\` (${c.category ?? "?"}) w${latest.week} anchor=${fmt(latest.anchor)} vs llm=${fmt(latest.llm)} (Δ=${delta.toFixed(2)})`);
      }
    }
    if (ws.length >= 3) {
      const recent = ws.slice(-3);
      const llms = recent.map((w) => w.llm).filter((x): x is number => typeof x === "number");
      if (llms.length === 3 && llms[0] > llms[1] && llms[1] > llms[2]) {
        concerns.push(`- **连续 3 周下降**: \`${c.id}\` w${recent[0].week}→w${recent[2].week} llm ${fmt(llms[0])}→${fmt(llms[2])}`);
      }
    }
  }

  for (const tool of snap.tools) {
    const lows: CaseDoc[] = [];
    for (const c of snap.cases) {
      const b = readBaseline(c, tool);
      if (b.score != null && b.score < 2) lows.push(c);
    }
    if (lows.length > 0) {
      concerns.push(`- **${tool} <2 分**: ${lows.map((c) => `\`${c.id}\``).join(", ")}`);
    }
  }

  if (concerns.length === 0) {
    out.push("> 无异常 case 🎉");
  } else {
    out.push(...concerns);
  }
  return out;
}

function renderDataSources(snap: ProjectSnapshot): string[] {
  const out: string[] = [];
  out.push("## 7. 数据源");
  out.push("");
  const byBucket = new Map<string, number>();
  for (const c of snap.cases) byBucket.set(c.bucket, (byBucket.get(c.bucket) ?? 0) + 1);
  for (const [b, n] of byBucket) {
    out.push(`- \`evals/${b}/\`: ${n} 条 case`);
  }
  if (snap.allWeeks.length > 0) {
    out.push(`- \`evals/_scores/\`: ${snap.allWeeks.length} 个周次目录 (w${snap.allWeeks[0]} ~ w${snap.allWeeks[snap.allWeeks.length - 1]})`);
  } else {
    out.push(`- \`evals/_scores/\`: (无)`);
  }
  return out;
}

function renderJumpLinks(snap: ProjectSnapshot): string[] {
  const out: string[] = [];
  out.push("## 8. 跳转入口");
  out.push("");
  out.push(`- [完整周报目录](_reports/) — 含 baseline / regression / horizontal-comparison`);
  out.push(`- [所有 case yaml](p0-core/) · [P1](p1-common/) · [P2](p2-edge/) · [holdout](holdout/)`);
  if (snap.allWeeks.length > 0) {
    const latest = snap.allWeeks[snap.allWeeks.length - 1];
    out.push(`- [最新一周分数 w${latest}](_scores/w${latest}/)`);
  }
  if (snap.runHistory.size > 0) {
    out.push(`- [运行历史 jsonl](_runs/) — 每次跑分追加，可用于绘制曲线`);
  }
  return out;
}

/**
 * 渲染"运行历史趋势"章节 —— 读 _runs/{provider}.jsonl，按 run 时间轴画分数变化。
 *
 * 每次跑 eval-runner 都会追加一行，因此曲线粒度比 _scores/wNN/ 更细（精确到每次 run）。
 */
function renderRunHistoryTrends(snap: ProjectSnapshot): string[] {
  const out: string[] = [];
  out.push("## 4. 运行历史趋势 (per-run)");
  out.push("");
  if (snap.runHistory.size === 0) {
    out.push("> 当前 `evals/_runs/` 无追加历史。第一次跑 `bun run evals/eval-runner.ts ...` 后会自动创建。");
    return out;
  }

  out.push("数据源: `evals/_runs/{provider}.jsonl`（每次 eval-runner 完成自动追加）");
  out.push("");

  for (const [provider, records] of snap.runHistory) {
    const runIds = uniqueSorted(records.map((r) => r.runId));
    out.push(`### 4.${[...snap.runHistory.keys()].indexOf(provider) + 1} ${provider}`);
    out.push("");
    out.push(`总计: ${runIds.length} 次 run × ${new Set(records.map((r) => r.caseId)).size} 个 case = ${records.length} 条记录`);
    out.push("");

    // 4.x.1 每次 run 的均分曲线
    const summaries = runIds.map((rid) => summarizeRun(records, rid));
    out.push("**4.x.1 每次 run 的均分趋势**");
    out.push("");
    out.push(renderRunSummaryTable(summaries));
    out.push("");
    out.push(renderRunMeanChart(provider, summaries));
    out.push("");

    // 4.x.2 单 case 的多次 run 折线（仅展示有 ≥2 次 run 的 case）
    const byCase = new Map<string, RunRecord[]>();
    for (const r of records) {
      if (!byCase.has(r.caseId)) byCase.set(r.caseId, []);
      byCase.get(r.caseId)!.push(r);
    }
    const eligibleCases = [...byCase.entries()].filter(([, rs]) => rs.length >= 2);
    if (eligibleCases.length === 0) {
      out.push("**4.x.2 单 case 多次 run 折线**: 暂无 case 有 ≥2 次 run，跳过");
      out.push("");
      out.push("> 持续跑分后此图会自动出现。");
      out.push("");
      continue;
    }
    out.push("**4.x.2 单 case 多次 run 折线** (仅展示 ≥2 次 run 的 case)");
    out.push("");
    for (const [caseId, runs] of eligibleCases.sort()) {
      const sorted = runs.sort((a, b) => a.testedAt.localeCompare(b.testedAt));
      const trend = sorted.map((r) => r.score.toFixed(2)).join(" → ");
      const delta = sorted[sorted.length - 1].score - sorted[0].score;
      const deltaStr = delta > 0 ? `+${delta.toFixed(2)}` : delta.toFixed(2);
      out.push(`<details><summary><code>${caseId}</code> · ${sorted.length} 次 · ${trend} (Δ ${deltaStr})</summary>`);
      out.push("");
      out.push(renderCaseRunChart(caseId, sorted));
      out.push("");
      out.push("</details>");
      out.push("");
    }
  }

  return out;
}

interface RunSummary {
  runId: string;
  count: number;
  avgScore: number;
  passCount: number;
  failCount: number;
  errorCount: number;
}

function summarizeRun(records: RunRecord[], runId: string): RunSummary {
  const subset = records.filter((r) => r.runId === runId);
  const avg = subset.reduce((s, r) => s + r.score, 0) / Math.max(1, subset.length);
  const pass = subset.filter((r) => r.score >= 3.0).length;
  const fail = subset.filter((r) => r.score < 3.0 && r.runStatus === "success").length;
  const err = subset.filter((r) => r.runStatus !== "success").length;
  return { runId, count: subset.length, avgScore: avg, passCount: pass, failCount: fail, errorCount: err };
}

function renderRunSummaryTable(summaries: RunSummary[]): string {
  const lines: string[] = [];
  lines.push(`| run_id (UTC) | cases | avg | pass≥3 | fail<3 | error/timeout |`);
  lines.push(`| --- | --- | --- | --- | --- | --- |`);
  for (const s of summaries) {
    const shortId = s.runId.replace(/\.\d+Z$/, "Z").replace("T", " ").slice(0, 19);
    lines.push(`| \`${shortId}\` | ${s.count} | **${s.avgScore.toFixed(2)}** | ${s.passCount} | ${s.failCount} | ${s.errorCount} |`);
  }
  return lines.join("\n");
}

function renderRunMeanChart(provider: string, summaries: RunSummary[]): string {
  if (summaries.length === 0) return "> (无 run 数据)";
  const xLabels = summaries.map((_, i) => `r${i + 1}`);
  const avgs = summaries.map((s) => s.avgScore);
  return mermaidLineChart({
    title: `${provider} 历次 run 均分`,
    xLabels,
    series: [{ name: "avg", values: avgs }],
  });
}

function renderCaseRunChart(caseId: string, runs: RunRecord[]): string {
  const xLabels = runs.map((_, i) => `r${i + 1}`);
  const scores = runs.map((r) => r.score);
  return mermaidLineChart({
    title: `${caseId} 历次 run 分数`,
    xLabels,
    series: [{ name: "score", values: scores }],
  });
}

function uniqueSorted(arr: string[]): string[] {
  return [...new Set(arr)].sort();
}
