#!/usr/bin/env bun
/**
 * SWE-bench Verified 阶段 A —— 判定与报告（§6.3 第 7 步 + §6 验收标准）
 *
 * 事实源：`接入计划.md` §4.6（判定，不自己判）+ §6（验收标准，不含百分比字段）
 *
 * ## 这个文件的唯一职责：把官方 report 翻译成验收字段，一个数都不自己算
 *
 * §4.6 原话是「丢给 `swebench eval` 读回报告，映射结果类别」。所以这里：
 *   - **不跑测试**、**不判 pass/fail** —— 那是 harness 的事；
 *   - 只做两件事：调 harness、把它的 report.json 映射成 §6 那五个字段。
 *
 * ## ⚠️ 两个必须硬失败的地方（都是「假 0%」的同型陷阱）
 *
 * 1. **report.json 读不回来 → 不许当 0**。被否决的路径 A 的病灶就是 scorer
 *    硬编码 `return Score(value=0)`：那不是「模型没解出来」，是仪器没接上，
 *    但它长得和一个真实的 0 分完全一样。这里对应的形态是
 *    「harness 没跑起来 / report 缺失，却把 solved_count 记 0」。
 * 2. **`ungraded` 单独成类，不折叠**（§4.6）。harness 对没提到的实例记 ungraded，
 *    汇总时若当「未解出」处理，数据错会伪装成能力差 —— 实测手挑 subset 里
 *    有 3 条 id 不存在，那 30% 会静默变成「未解出」。
 *
 * ## 用法
 *
 *   # 判分（会真跑官方 harness，起容器）
 *   bun run evals/external-benchmarks/swe-bench/grade.ts --run-id smoke-1
 *
 *   # 只读回已有 report 并出报告（不重跑）
 *   ... --run-id smoke-1 --report-only
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SWE_DIR = import.meta.dir;
/** §3 数据隔离：报告独立到 `evals/_reports/external/`，**不碰 `evals/_scores/`** */
const REPORT_DIR = join(REPO_ROOT, "evals/_reports/external");
const MODEL_NAME = "sid-code";

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

/** 官方 report.json 里我们会用到的字段（其余忽略）。 */
export interface OfficialReport {
  total_instances?: number;
  submitted_instances?: number;
  completed_instances?: number;
  resolved_instances?: number;
  unresolved_instances?: number;
  empty_patch_instances?: number;
  error_instances?: number;
  resolved_ids?: string[];
  unresolved_ids?: string[];
  error_ids?: string[];
  empty_patch_ids?: string[];
  completed_ids?: string[];
  submitted_ids?: string[];
}

export type GradedOutcome = "solved" | "wrong_patch" | "no_patch" | "grader_error" | "ungraded";

/**
 * §6 的验收字段。**这个 interface 里刻意没有任何百分比字段** ——
 * §6 原话「报告模板不许含百分比字段」，理由在 D2：n=10 时
 * SE=14.5pp、95% CI 半宽 ±28pp，「10 题跑出的 60% 与 70% 在统计上无法区分」。
 *
 * 约束落在类型上而不是落在「大家别算百分比」这句话上：
 * **没有那个字段，就没人能把 10 题的比例画成 release 曲线。**
 */
export interface Acceptance {
  run_id: string;
  prompt_version: string;
  /** 10/10 instance 产出非空 patch ← 二值 */
  link_ok: boolean;
  /** 10/10 拿到 report.json（无 ungraded）← 二值 */
  graded_ok: boolean;
  /** gold patch 自检 ← 二值。null = 本次没跑 gold 自检 */
  gold_ok: boolean | null;
  /** 绝对数，不换算百分比、不进 release 曲线 */
  solved_count: number;
  /** 分母也要写出来，否则「solved_count: 6」读不出是 6/10 还是 6/15 */
  total_count: number;
  /** §4.5 那道硬检查的计数 */
  patch_touches_tests: number;
  /** 六类结果的逐条映射 */
  outcomes: Record<string, GradedOutcome>;
  /** ── 以下四个是 §6.3 要求的诚实字段 ── */
  /** 账没算平的部分。有值就是「这份报告自己知道它不完整」 */
  unaccounted: string | null;
  /** harness 自己的时钟，不是 agent 自报 */
  wall_ms: number;
  /** D4：无中立计价源，固定 null */
  meter: null;
  meter_note: string;
  /** 是否只跑了部分实例 */
  partial: boolean;
}

export const METER_NOTE = "无中立计价源；成本数字为 agent 自报，未交叉校验";

// ─────────────────────────────────────────────────────────────────────────────
// 映射：官方 report → 六类结果
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把官方 report 的各个 id 列表映射成逐实例结论。
 *
 * ⚠️ **`ungraded` 是兜底，且必须存在**：一个我们提交了、但 report 的
 * 任何一个列表里都没出现的实例，它的真实状态是**未知**，不是「未解出」。
 * 把它折叠进 unresolved 就是「数据错伪装成能力差」。
 *
 * ⚠️ 顺序有讲究：error 与 empty_patch 要在 unresolved 之前判 ——
 * 官方 report 里一个实例**可以同时**出现在 unresolved_ids 和 error_ids
 * （§4.6「`0 failed` 与 `Instances with errors: 1` 可同时成立，不矛盾」）。
 * 先判 unresolved 会把一次 grader 崩溃记成「模型改错了」。
 */
export function mapOutcomes(
  report: OfficialReport,
  submitted: string[],
): Record<string, GradedOutcome> {
  const set = (xs?: string[]) => new Set(xs ?? []);
  const resolved = set(report.resolved_ids);
  const errored = set(report.error_ids);
  const empty = set(report.empty_patch_ids);
  const unresolved = set(report.unresolved_ids);

  const out: Record<string, GradedOutcome> = {};
  for (const id of submitted) {
    if (resolved.has(id)) out[id] = "solved";
    else if (errored.has(id)) out[id] = "grader_error";
    else if (empty.has(id)) out[id] = "no_patch";
    else if (unresolved.has(id)) out[id] = "wrong_patch";
    else out[id] = "ungraded";
  }
  return out;
}

/**
 * 组装验收字段。
 *
 * `graded_ok` 的判据是**没有任何 ungraded**，而不是「report 里 total 对得上」——
 * total 对得上但某条落在所有列表之外时，那条的状态仍然是未知的。
 */
export function buildAcceptance(input: {
  runId: string;
  promptVersion: string;
  report: OfficialReport | null;
  submitted: string[];
  patchBytesById: Record<string, number>;
  touchesTestsIds: string[];
  goldOk: boolean | null;
  wallMs: number;
  expectedTotal: number;
}): Acceptance {
  const notes: string[] = [];

  // report 读不回来 → 全部 ungraded，且 unaccounted 必须写明。
  // **绝不返回 solved_count: 0 然后装作跑完了。**
  if (!input.report) {
    notes.push(
      "官方 report.json 未读回 —— 所有实例记 ungraded。" +
        "⚠️ 这不是「0 条解出」，是判分没发生；把它当 0 就是被否决的路径 A 那个假 0%。",
    );
  }

  const outcomes = input.report
    ? mapOutcomes(input.report, input.submitted)
    : Object.fromEntries(input.submitted.map((id) => [id, "ungraded" as GradedOutcome]));

  const ungradedIds = Object.entries(outcomes)
    .filter(([, v]) => v === "ungraded")
    .map(([k]) => k);
  if (ungradedIds.length && input.report) {
    notes.push(`${ungradedIds.length} 条 ungraded（不计入未解出）：${ungradedIds.join(", ")}`);
  }

  const nonEmpty = input.submitted.filter((id) => (input.patchBytesById[id] ?? 0) > 0);
  const partial = input.submitted.length < input.expectedTotal;
  if (partial) {
    notes.push(
      `只跑了 ${input.submitted.length}/${input.expectedTotal} 条 —— ` +
        `solved_count 的分母是前者，不要与全量口径混用`,
    );
  }

  return {
    run_id: input.runId,
    prompt_version: input.promptVersion,
    link_ok: nonEmpty.length === input.submitted.length && input.submitted.length > 0,
    graded_ok: !!input.report && ungradedIds.length === 0,
    gold_ok: input.goldOk,
    solved_count: Object.values(outcomes).filter((v) => v === "solved").length,
    total_count: input.submitted.length,
    patch_touches_tests: input.touchesTestsIds.length,
    outcomes,
    unaccounted: notes.length ? notes.join(" | ") : null,
    wall_ms: input.wallMs,
    meter: null,
    meter_note: METER_NOTE,
    partial,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 报告渲染
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 渲染 markdown 报告。
 *
 * ⚠️ 渲染层同样不许出现百分比 —— 光在 interface 里去掉字段不够，
 * 「在报告里现算一个 6/10 = 60%」是同一件事的另一种写法。
 */
export function renderReport(a: Acceptance): string {
  const b = (v: boolean | null) => (v === null ? "未跑" : v ? "PASS" : "FAIL");
  const counts = Object.values(a.outcomes).reduce<Record<string, number>>((acc, v) => {
    acc[v] = (acc[v] ?? 0) + 1;
    return acc;
  }, {});
  return [
    `# SWE-bench Verified 二值 smoke —— ${a.run_id}`,
    "",
    "> 数据隔离：本报告独立于 sid-code 自家评测（不写 baseline_scores、不进 grader registry）。",
    "> **不含百分比字段**：n=10 时 SE=14.5pp、0.95 置信区间半宽 ±28pp，",
    "> 六成与七成统计上无法区分，所以这里只报绝对数，且**不进 release 曲线**。",
    "> （连这段说明里也不出现百分号：门禁是机械的 —— 报告里出现 `数字+%` 即判违规。",
    "> 门禁做得这么钝是**故意的**，「在正文里现算一个 6/10 得六成」和加一个",
    "> percent 字段是同一件事，而只拦字段名拦不住前者。)",
    "",
    `- prompt 版本：\`${a.prompt_version}\``,
    `- link_ok（产出非空 patch）：**${b(a.link_ok)}**`,
    `- graded_ok（拿到 report 且无 ungraded）：**${b(a.graded_ok)}**`,
    `- gold_ok（环境自检）：**${b(a.gold_ok)}**`,
    `- solved_count：**${a.solved_count} / ${a.total_count}**（绝对数）`,
    `- patch_touches_tests：**${a.patch_touches_tests}**`,
    `- wall_ms（harness 时钟，非 agent 自报）：${a.wall_ms}`,
    `- meter：\`null\` —— ${a.meter_note}`,
    `- partial：${a.partial}`,
    `- unaccounted：${a.unaccounted ?? "无"}`,
    "",
    "## 六类结果分布",
    "",
    ...Object.entries(counts).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## 逐条",
    "",
    "| instance_id | outcome |",
    "| --- | --- |",
    ...Object.entries(a.outcomes).map(([k, v]) => `| ${k} | ${v} |`),
    "",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 官方 report 定位
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 找官方 report.json。
 *
 * 官方把摘要写成 `<model>.<run_id>.json` 放在 `--report-dir`（默认 cwd）。
 * ⚠️ **找不到就返回 null，绝不返回一个空对象** —— 空对象会让下游
 * 把「没判分」算成「全 0」，那正是本文件头两条要防的东西。
 */
export function findReport(dir: string, runId: string): OfficialReport | null {
  const exact = join(dir, `${MODEL_NAME}.${runId}.json`);
  if (existsSync(exact)) {
    try {
      return JSON.parse(readFileSync(exact, "utf8")) as OfficialReport;
    } catch {
      return null;
    }
  }
  if (!existsSync(dir)) return null;
  const cand = readdirSync(dir).find((f) => f.endsWith(`.${runId}.json`));
  if (!cand) return null;
  try {
    return JSON.parse(readFileSync(join(dir, cand), "utf8")) as OfficialReport;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  let runId = "";
  let reportOnly = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--run-id") runId = argv[++i] ?? "";
    else if (argv[i] === "--report-only") reportOnly = true;
  }
  if (!runId) {
    console.error("必须给 --run-id。⚠️ 同一 run_id 重跑会复用 harness 缓存（§4.6）");
    process.exit(2);
  }

  const runDir = join(SWE_DIR, "runs", runId);
  const predPath = join(runDir, "predictions.jsonl");
  if (!existsSync(predPath)) {
    console.error(`❌ 找不到 ${predPath.replace(REPO_ROOT + "/", "")} —— 先跑 runner.ts`);
    process.exit(2);
  }

  const preds = readFileSync(predPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { instance_id: string; model_patch: string });
  const submitted = preds.map((p) => p.instance_id);
  const patchBytesById = Object.fromEntries(
    preds.map((p) => [p.instance_id, (p.model_patch ?? "").length]),
  );

  const recPath = join(runDir, "records.jsonl");
  const touchesTestsIds: string[] = existsSync(recPath)
    ? readFileSync(recPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((r) => r.patch_touches_tests)
        .map((r) => r.instance_id)
    : [];

  const t0 = performance.now();
  if (!reportOnly) {
    console.error("⚠️ 判分需要官方 harness（起容器）。用 exec-swebench.sh grade 走那一步，");
    console.error("本文件的 --report-only 负责把已产出的 report.json 映射成验收字段。");
    process.exit(3);
  }

  const report = findReport(runDir, runId) ?? findReport(process.cwd(), runId);
  const acceptance = buildAcceptance({
    runId,
    promptVersion: "prompt-v1",
    report,
    submitted,
    patchBytesById,
    touchesTestsIds,
    goldOk: null,
    wallMs: Math.round(performance.now() - t0),
    expectedTotal: 10,
  });

  mkdirSync(REPORT_DIR, { recursive: true });
  const jsonOut = join(REPORT_DIR, `swe-bench-verified.${runId}.json`);
  const mdOut = join(REPORT_DIR, `swe-bench-verified.${runId}.md`);
  writeFileSync(jsonOut, JSON.stringify(acceptance, null, 2) + "\n");
  writeFileSync(mdOut, renderReport(acceptance));
  console.log(renderReport(acceptance));
  console.log(`\n已写入：\n  ${jsonOut.replace(REPO_ROOT + "/", "")}`);
  console.log(`  ${mdOut.replace(REPO_ROOT + "/", "")}`);
  // report 缺失是**硬失败**，不能 exit 0 —— 那会让 CI/人误读成「判分完成」
  process.exit(report ? 0 : 3);
}

if (import.meta.main) await main();
