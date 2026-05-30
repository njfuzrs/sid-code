/**
 * render.ts — DASHBOARD.md 渲染层
 *
 * 输出 GitHub-flavored markdown,含 mermaid xychart-beta 折线图与 emoji 状态映射。
 * VS Code / GitHub Web / Obsidian 均原生渲染 mermaid。
 *
 * Grader 版本过滤（2026-05-26 起）：
 *   默认按 LATEST_GRADER_VERSION 过滤 baseline 显示——跨 grader 版本（如 5d-v1 → 5d-v2，
 *   efficiency 权重 0.3 → 0）的总分不可直接比较。Legacy 数据（无版本号或非 LATEST 版本）
 *   走 includeLegacy=true 开关展示，并在脚注列出被过滤的条目数。
 */

import type { CaseDoc, ProjectSnapshot, WeekScore, RunRecord, BaselineSnapshot } from "./yaml-loader";
import { readBaseline, LATEST_GRADER_VERSION, isBehaviorBucket, isArchitectureBucket, isExecutionBucket, CAPABILITY_GRADER_PREFIX } from "./yaml-loader";

export interface DashboardOptions {
  /** true = 一并展示旧 grader 版本 baseline；默认 false（仅展示 LATEST_GRADER_VERSION 数据） */
  includeLegacy?: boolean;
}

/**
 * 判断 baseline 是否属于"当前 grader 版本"。
 *
 * 规则：
 *   - graderVersion === LATEST_GRADER_VERSION → 当前版本（保留）
 *   - graderVersion 以 capability- 前缀打头 → capability runner 自家版本，保留（不与 5d-v* 跨版本比，
 *     但属于真版本数据，不是 legacy；A3-3 修正前会被一并 hide 导致 capability dashboard 空表）
 *   - graderVersion === undefined → legacy 数据（promptfoo 时代或 5d-v1 之前），按 includeLegacy 过滤
 *   - graderVersion 为其它值（如 5d-v3 / 5d-v2 / 5d-v1）→ 历史版本 legacy，按 includeLegacy 过滤
 *   - status === "pending"（无 baseline 数据）→ 始终保留（用于显示"待评测"状态）
 */
function isLatestGrader(b: BaselineSnapshot): boolean {
  if (b.status === "pending") return true;
  if (b.graderVersion === LATEST_GRADER_VERSION) return true;
  if (b.graderVersion && b.graderVersion.startsWith(CAPABILITY_GRADER_PREFIX)) return true;
  return false;
}

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

export function renderDashboard(snapshot: ProjectSnapshot, options: DashboardOptions = {}): string {
  const includeLegacy = options.includeLegacy ?? false;
  const lines: string[] = [];
  lines.push(`# Evals Dashboard — ${snapshot.projectName}`);
  lines.push("");
  lines.push(`> 自动生成,请勿手动编辑。生成时间: \`${new Date().toISOString()}\``);
  lines.push(`> 数据源: \`evals/p*-*/\` + \`evals/_scores/\` + \`evals/_reports/\``);
  lines.push(`> 触发: 手动 \`bun run eval:dashboard\` / git pre-push hook 自动刷新`);
  lines.push(
    `> Grader 过滤: ${includeLegacy ? "**包含 legacy 数据**" : `**仅 \`${LATEST_GRADER_VERSION}\`**`}（跨 grader 版本总分不可直接比较；切换：\`--include-legacy\`）`,
  );
  lines.push("");
  lines.push("---");
  lines.push("");

  lines.push(...renderOverview(snapshot, includeLegacy));
  lines.push("");
  lines.push(...renderBehaviorVsArchitecture(snapshot, includeLegacy));
  lines.push("");
  lines.push(...renderExecutionAxis(snapshot));
  lines.push("");
  lines.push(...renderCaseToolMatrix(snapshot, includeLegacy));
  lines.push("");
  lines.push(...renderWeeklyTrends(snapshot));
  lines.push("");
  lines.push(...renderRunHistoryTrends(snapshot));
  lines.push("");
  lines.push(...renderPending(snapshot, includeLegacy));
  lines.push("");
  lines.push(...renderAnomalies(snapshot, includeLegacy));
  lines.push("");
  lines.push(...renderDataSources(snapshot));
  lines.push("");
  lines.push(...renderJumpLinks(snapshot));
  lines.push("");

  return lines.join("\n");
}

function renderOverview(snap: ProjectSnapshot, includeLegacy: boolean): string[] {
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

  let legacyFiltered = 0;
  for (const tool of snap.tools) {
    let tested = 0;
    let pending = 0;
    let legacy = 0;
    for (const c of snap.cases) {
      const b = readBaseline(c, tool);
      const isLatest = isLatestGrader(b);
      if (!isLatest && !includeLegacy) {
        legacy++;
        continue;
      }
      if (b.status === "tested") tested++;
      else if (b.status === "pending") pending++;
    }
    legacyFiltered += legacy;
    const legacyHint = legacy > 0 && !includeLegacy ? `, ${legacy} legacy 隐藏` : "";
    out.push(`- **${tool}** 评分进度: ${tested}/${total} 已评分 (${pending} pending${legacyHint})`);
  }
  if (legacyFiltered > 0 && !includeLegacy) {
    out.push(
      `- ⚠️ 共隐藏 **${legacyFiltered}** 条 legacy baseline（非 \`${LATEST_GRADER_VERSION}\`）；查看用 \`--include-legacy\``,
    );
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

/**
 * 行为分（general）vs 架构分（architecture）双指标面板。
 *
 * 设计依据：08 §13.3 双指标 + S2-T27 要求 DASHBOARD 加"行为分 vs 架构分"双 panel。
 *
 * 数据源：snap.cases 按 bucket 分组——bucket 以 "general/" 开头或在 LEGACY_GENERAL_BUCKETS
 *        内的归"行为"，以 "architecture/" 或 "holdout/architecture/" 开头的归"架构"。
 *        每条 case 取 baseline.score（按 LATEST_GRADER_VERSION 过滤）平均。
 */
function renderBehaviorVsArchitecture(
  snap: ProjectSnapshot,
  includeLegacy: boolean,
): string[] {
  const out: string[] = [];
  out.push("## 1.1 行为分 vs 架构分 双指标");
  out.push("");
  out.push("> 行为分 = `evals/general/` 下 5 维 grader 跑出的均分（动态行为评测）");
  out.push("> 架构分 = `evals/architecture/` 下 binary_redline / structured_arch 跑出的均分（静态结构评测 + 红线 binary）");
  out.push("> 两者对应 08 §13.3 双指标：行为分反映 agent 跑事件能力，架构分反映底座完整性");
  out.push("");

  type Bucket = { tool: string; behaviorSum: number; behaviorN: number; archSum: number; archN: number };
  const stats = new Map<string, Bucket>();

  for (const tool of snap.tools) {
    stats.set(tool, { tool, behaviorSum: 0, behaviorN: 0, archSum: 0, archN: 0 });
  }

  for (const c of snap.cases) {
    const isBehavior = isBehaviorBucket(c.bucket);
    const isArch = isArchitectureBucket(c.bucket);
    if (!isBehavior && !isArch) continue;
    for (const tool of snap.tools) {
      const b = readBaseline(c, tool);
      if (b.status !== "tested") continue;
      // A3-3：grader 过滤——当前版本 + capability-* 都算真版本数据；legacy 走 includeLegacy 开关
      if (!includeLegacy && !isLatestGrader(b)) continue;
      if (typeof b.score !== "number") continue;
      const s = stats.get(tool)!;
      if (isBehavior) {
        s.behaviorSum += b.score;
        s.behaviorN += 1;
      } else {
        s.archSum += b.score;
        s.archN += 1;
      }
    }
  }

  out.push("| Tool | 行为分（n） | 架构分（n） | Δ |");
  out.push("| --- | --- | --- | --- |");
  for (const tool of snap.tools) {
    const s = stats.get(tool)!;
    const behAvg = s.behaviorN > 0 ? s.behaviorSum / s.behaviorN : null;
    const archAvg = s.archN > 0 ? s.archSum / s.archN : null;
    const beh = behAvg !== null ? `${behAvg.toFixed(2)} (n=${s.behaviorN})` : "–";
    const arch = archAvg !== null ? `${archAvg.toFixed(2)} (n=${s.archN})` : "–";
    const delta = behAvg !== null && archAvg !== null ? (archAvg - behAvg).toFixed(2) : "–";
    out.push(`| ${tool} | ${beh} | ${arch} | ${delta} |`);
  }

  return out;
}

/**
 * Execution 轴独立 section（B5-6 / 2026-05-30 / ADR-032）。
 *
 * 设计依据：agent-eval-真化路线-v1.md §6.4 与 §8.1 — execution case 走 grader_type=execution_test，
 * binary 0/1 输出，**不与 5d-v3 加权混算**，必须独立成栏在 DASHBOARD 展示。
 *
 * 数据源：snap.cases 中 bucket = "general/execution" 的所有 case。
 *   - 每条 case 取 baseline_scores.<tool>.score（0 或 1）平均 → pass_rate
 *   - 不走 isLatestGrader 过滤（execution-test-v1 是独立 grader 版本号，与 5d-v* 跨版本）
 *
 * M5 Gate 准入 quota（§4.2 双轨）：修改型 Skill execution case ≥ 60% — 本 section 给出真实进度。
 */
function renderExecutionAxis(snap: ProjectSnapshot): string[] {
  const out: string[] = [];
  out.push("## 1.2 Execution 轴（binary 0/1，不与 5d-v3 混算）");
  out.push("");
  const execCases = snap.cases.filter((c) => isExecutionBucket(c.bucket));
  if (execCases.length === 0) {
    out.push("> ⏳ 暂无 execution case（B5-2 起 evals/general/execution/ 下首条 case `bug_001` 之后会出现）");
    return out;
  }
  out.push("> 数据源 = `evals/general/execution/`，grader=`execution-test-v1`，sandbox 跑 verify_commands 决定 0/1");
  out.push("> 与 5d-v3 主表分轨：M5 前不混算总分；execution case 通过率独立看（§6.4）");
  out.push("");
  out.push(`- **execution case 总数**: ${execCases.length} 条`);
  out.push("");
  out.push("| Tool | pass_rate (n) | 已 pass | 已 fail | pending |");
  out.push("| --- | --- | --- | --- | --- |");
  for (const tool of snap.tools) {
    let pass = 0;
    let fail = 0;
    let pending = 0;
    for (const c of execCases) {
      const b = readBaseline(c, tool);
      if (b.status !== "tested") {
        pending++;
        continue;
      }
      if (typeof b.score === "number" && b.score >= 1) pass++;
      else fail++;
    }
    const total = pass + fail;
    const rate = total > 0 ? `${((pass / total) * 100).toFixed(0)}% (n=${total})` : "–";
    out.push(`| ${tool} | ${rate} | ${pass} | ${fail} | ${pending} |`);
  }
  out.push("");
  out.push("> 进度提示：sandbox 接进 eval-runner 主流程已就位（B5-1，commit a524bfb）；");
  out.push("> 第一条 case `bug_001` 已落 evals/general/execution/，端到端 baseline 跑通后本表自动填充。");
  return out;
}

function renderCaseToolMatrix(snap: ProjectSnapshot, includeLegacy: boolean): string[] {
  const out: string[] = [];
  out.push("## 2. Case × Tool 矩阵");
  out.push("");
  out.push(`图例: ✅ ≥4.5 / 🟢 3.5-4.4 / 🟡 2.5-3.4 / 🟠 1.5-2.4 / 🔴 <1.5 / – pending / ❌ error / ⏱️ timeout / 🕰️ legacy(已过滤)`);
  out.push("");

  const latestWeek = snap.allWeeks.length > 0 ? snap.allWeeks[snap.allWeeks.length - 1] : null;
  const headerCols = ["case_id", "pri", "category"];
  for (const t of snap.tools) headerCols.push(t);
  if (latestWeek != null) headerCols.push(`w${latestWeek}.anchor`, `w${latestWeek}.llm`);

  out.push(`| ${headerCols.join(" | ")} |`);
  out.push(`| ${headerCols.map(() => "---").join(" | ")} |`);

  let legacyHidden = 0;
  for (const c of snap.cases) {
    const cells: string[] = [];
    cells.push(c.id + (c.holdout ? " 🔒" : ""));
    cells.push(c.priority ?? "?");
    cells.push((c.category ?? "?").slice(0, 18));
    for (const tool of snap.tools) {
      const b = readBaseline(c, tool);
      const isLatest = isLatestGrader(b);
      if (!isLatest && !includeLegacy) {
        legacyHidden++;
        cells.push("🕰️");
        continue;
      }
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

  if (legacyHidden > 0) {
    out.push("");
    out.push(
      `> 🕰️ 共 **${legacyHidden}** 格 legacy baseline 被隐藏（grader 版本 ≠ \`${LATEST_GRADER_VERSION}\`，跨版本总分不可直接比较）。查看用 \`--include-legacy\`。`,
    );
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

  // T-16: 趋势告警——下降 > 0.3 的 case 自动 flag
  const regressions = detectRegressions(snap, 0.3);
  if (regressions.length > 0) {
    out.push("### ⚠️ 趋势告警（连续 / 显著下降）");
    out.push("");
    out.push("| case | 趋势 | Δ（最新-前次） | 类型 |");
    out.push("|---|---|---|---|");
    for (const r of regressions) {
      out.push(`| \`${r.caseId}\` | ${r.trend} | ${r.delta.toFixed(2)} | ${r.type} |`);
    }
    out.push("");
    out.push(`> 阈值：单周下降 > 0.3 或连续 3 周下降。详见 docs/eval/investigations/eval-rubric-industry-survey.md §6.4 T-16`);
    out.push("");
  }

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

/**
 * T-16 趋势告警检测：
 *   - "single_drop"：最新一周比前一周下降 > threshold
 *   - "sustained_drop"：连续 3 周分数严格递减
 */
interface RegressionInfo {
  caseId: string;
  trend: string;
  delta: number;
  type: "single_drop" | "sustained_drop";
}

function detectRegressions(snap: ProjectSnapshot, threshold: number): RegressionInfo[] {
  const out: RegressionInfo[] = [];
  for (const c of snap.cases) {
    const ws = snap.weeksByCase.get(c.id) ?? [];
    const valid = ws.filter((w) => typeof w.llm === "number") as Array<{ week: number; llm: number }>;
    if (valid.length < 2) continue;
    const sorted = [...valid].sort((a, b) => a.week - b.week);

    // single_drop
    const last = sorted[sorted.length - 1];
    const prev = sorted[sorted.length - 2];
    if (prev.llm - last.llm > threshold) {
      out.push({
        caseId: c.id,
        trend: `w${prev.week}=${prev.llm.toFixed(2)} → w${last.week}=${last.llm.toFixed(2)}`,
        delta: last.llm - prev.llm,
        type: "single_drop",
      });
      continue;
    }

    // sustained_drop（连续 3 周严格下降）
    if (sorted.length >= 3) {
      const [a, b, c2] = sorted.slice(-3);
      if (a.llm > b.llm && b.llm > c2.llm) {
        out.push({
          caseId: c.id,
          trend: `w${a.week}=${a.llm.toFixed(2)} → w${b.week}=${b.llm.toFixed(2)} → w${c2.week}=${c2.llm.toFixed(2)}`,
          delta: c2.llm - a.llm,
          type: "sustained_drop",
        });
      }
    }
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

function renderPending(snap: ProjectSnapshot, includeLegacy: boolean): string[] {
  const out: string[] = [];
  out.push("## 5. 评分进度 / Pending 列表");
  out.push("");

  const pendingByTool = new Map<string, CaseDoc[]>();
  const legacyByTool = new Map<string, CaseDoc[]>();
  for (const tool of snap.tools) {
    const list: CaseDoc[] = [];
    const legacyList: CaseDoc[] = [];
    for (const c of snap.cases) {
      const b = readBaseline(c, tool);
      const isLatest = isLatestGrader(b);
      if (b.status === "pending") {
        list.push(c);
      } else if (!isLatest && !includeLegacy) {
        // legacy baseline 视作"待用当前 grader 重跑"——不进 pending 但单独列出
        legacyList.push(c);
      }
    }
    pendingByTool.set(tool, list);
    legacyByTool.set(tool, legacyList);
  }

  for (const [tool, list] of pendingByTool) {
    const legacyList = legacyByTool.get(tool) ?? [];
    if (list.length === 0 && legacyList.length === 0) {
      out.push(`### ${tool}: ✅ 全部已评分（grader=\`${LATEST_GRADER_VERSION}\`）`);
      out.push("");
      continue;
    }
    out.push(`### ${tool}: ${list.length} 条 pending${legacyList.length > 0 ? ` + ${legacyList.length} 条 legacy 待重跑` : ""}`);
    out.push("");
    if (list.length > 0) {
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
    }
    if (legacyList.length > 0) {
      out.push(
        `- 🕰️ **legacy** (${legacyList.length}, 非 \`${LATEST_GRADER_VERSION}\`): ${legacyList
          .slice(0, 8)
          .map((c) => `\`${c.id}\``)
          .join(", ")}${legacyList.length > 8 ? " …" : ""}`,
      );
    }
    out.push("");
  }

  return out;
}

function renderAnomalies(snap: ProjectSnapshot, includeLegacy: boolean): string[] {
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
      // 默认只在当前 grader 数据里找异常；legacy 数据另外报告
      if (!isLatestGrader(b) && !includeLegacy) continue;
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
      // null score（error/timeout）显示为 "–"，不混入 trend 字符串里的数字
      const trend = sorted.map((r) => (r.score === null ? "–" : r.score.toFixed(2))).join(" → ");
      // delta 仅基于"首末两次有效 run"，避免拿 null - number 算 NaN
      const validSorted = sorted.filter((r) => r.score !== null);
      const deltaStr = validSorted.length >= 2
        ? (() => {
            const d = (validSorted[validSorted.length - 1].score as number) - (validSorted[0].score as number);
            return d > 0 ? `+${d.toFixed(2)}` : d.toFixed(2);
          })()
        : "–";
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
  // 均值与 pass/fail 仅统计 score !== null 且 runStatus === "success" 的 case；
  // error/timeout/abnormal 不计入均值（旧实现 Number(null)=0 会拉低均值 -0.1~-0.2）。
  const valid = subset.filter((r) => r.runStatus === "success" && r.score !== null);
  const avg = valid.length > 0 ? valid.reduce((s, r) => s + (r.score as number), 0) / valid.length : 0;
  const pass = valid.filter((r) => (r.score as number) >= 3.0).length;
  const fail = valid.filter((r) => (r.score as number) < 3.0).length;
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
