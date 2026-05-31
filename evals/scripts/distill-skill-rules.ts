#!/usr/bin/env bun
/**
 * distill-skill-rules.ts —— B7-6 数据飞轮 v0：Trace2Skill 蒸馏护栏 1
 *
 * 用途（路线 §13.4.4 第 1 条）：
 *   蒸馏 SKILL.md 增量前，强制校验输入 pattern set 中 ≥ 30% 数据来自外部代码库（非 sid-code）。
 *   < 30% 直接 reject，避免"sid-code 只学会修自己的错"的回音室效应。
 *
 * 输入：候选轨迹清单（task_id list 或 case yaml path list）
 * 输出：① 每条 task 的 source-repo 分类 ② 通过/拒绝判定 ③ 报告写盘
 *
 * 推断 source repo 规则（按优先级）：
 *   1. task.yaml `instruction.working_directory` 非空 →
 *      - 含 "sid-code" → repo=sid-code
 *      - 否则 → repo=external
 *   2. instruction.text 含路径模式：
 *      - "/Users/.../sid-code" / "src/agent/" + "src/debug/" 等仅 sid-code 才有的子系统名 → sid-code
 *      - "/project/" / "/Users/.../prd/" / "github.com/<不是 sid-code>" → external
 *      - 含 "sid-code" 字面量 → sid-code
 *   3. 无法判定 → repo=unknown（不计入分母）
 *
 * 通过条件（路线 §13.4.4 强制）：
 *   external_count / (external_count + sid_code_count) >= 0.30
 *   （unknown 不计入，避免被刷分母）
 *
 * 用法：
 *   # 校验当前 evals/real-tasks/ 30 条精挑是否符合 ≥ 30% 外部
 *   bun run evals/scripts/distill-skill-rules.ts --source-mode real-tasks
 *
 *   # 校验任意 task_id 列表
 *   bun run evals/scripts/distill-skill-rules.ts --source-mode task-list \
 *     --tasks T0016,T0226,T0049,T0107
 *
 *   # JSON 输出（CI 集成用）
 *   bun run evals/scripts/distill-skill-rules.ts --source-mode real-tasks --json
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const TRAJ_ROOT = "/Users/dev/Code/person/trajectory-platform/bench";
const REAL_TASKS_ROOT = join(REPO_ROOT, "evals/real-tasks");
const REPORT_DIR = join(REPO_ROOT, "_reports");

const THRESHOLD = 0.30;

export type RepoSource = "sid-code" | "external" | "unknown";

export interface RepoClassification {
  taskId: string;
  source: RepoSource;
  evidence: string;
}

/**
 * 推断单个 task.yaml 的 source repo。
 *
 * 这个函数的 5 条规则按下方顺序匹配，第一个命中即返回——顺序很重要：
 *   - 先看 working_directory（最权威，但常为空）
 *   - 再看 instruction.text 中的绝对路径线索（含项目根目录）
 *   - 再看子系统名混合（src/agent/ + src/debug/ 同时出现 = sid-code 特征）
 *   - 再看字面 sid-code 关键词
 *   - 最后 unknown，留给报告里"待补充元数据"的部分
 */
export function classifyTaskSourceRepo(taskYaml: any): RepoClassification {
  const taskId = String(taskYaml?.task_id ?? taskYaml?.id ?? "unknown");
  const wd = String(taskYaml?.instruction?.working_directory ?? "").trim();
  const text = String(taskYaml?.instruction?.text ?? "");
  const lower = text.toLowerCase();

  // 规则 1：working_directory 非空
  if (wd) {
    if (/sid-code/i.test(wd)) {
      return { taskId, source: "sid-code", evidence: `working_directory contains 'sid-code': ${wd.slice(0, 80)}` };
    }
    return { taskId, source: "external", evidence: `working_directory points elsewhere: ${wd.slice(0, 80)}` };
  }

  // 规则 2：text 中绝对路径线索
  const sidCodePathRe = /\/Users\/[^\s'"`]+\/sid-code|sid-code\/(src|evals|scripts|docs|tests)\//i;
  if (sidCodePathRe.test(text)) {
    return { taskId, source: "sid-code", evidence: `text references sid-code repo path` };
  }

  // 外部项目路径
  const externalPathRe = /\/project\/|\/Users\/[^\s'"`]+\/(prd|docs-research|claude-trace|trajectory-platform|Code\/[A-Za-z]+)\b|github\.com\/(?!.*sid-code)/i;
  if (externalPathRe.test(text)) {
    return { taskId, source: "external", evidence: `text references external project path` };
  }

  // 规则 3：sid-code 子系统名混合（src/agent/ + src/debug/ 这种组合是强特征）
  const sidSubsystems = ["src/agent/", "src/debug/", "src/trace/", "src/telemetry/", "src/skill/", "src/permission/", "src/ui/app", "src/entrypoints/"];
  const hits = sidSubsystems.filter((s) => lower.includes(s)).length;
  if (hits >= 2) {
    return { taskId, source: "sid-code", evidence: `text mentions ${hits} sid-code-specific subsystems` };
  }

  // 规则 4：字面 sid-code 关键词
  if (/\bsid-code\b/.test(text)) {
    return { taskId, source: "sid-code", evidence: `text mentions 'sid-code' literally` };
  }

  // 规则 5：unknown
  return { taskId, source: "unknown", evidence: "no repo signal in working_directory or instruction.text" };
}

export interface DistillCheckResult {
  passed: boolean;
  total: number;
  sidCount: number;
  externalCount: number;
  unknownCount: number;
  externalRatio: number; // external / (sid + external)，unknown 不算分母
  threshold: number;
  classifications: RepoClassification[];
  rejectReasons?: string[];
}

export function checkExternalRatio(items: RepoClassification[], threshold = THRESHOLD): DistillCheckResult {
  const sidCount = items.filter((c) => c.source === "sid-code").length;
  const externalCount = items.filter((c) => c.source === "external").length;
  const unknownCount = items.filter((c) => c.source === "unknown").length;
  const denominator = sidCount + externalCount;
  const externalRatio = denominator === 0 ? 0 : externalCount / denominator;
  const passed = externalRatio >= threshold && denominator > 0;
  const rejectReasons: string[] = [];
  if (!passed) {
    if (denominator === 0) rejectReasons.push("有效 task 数（sid+external）= 0，无法计算比例");
    else if (externalRatio < threshold) rejectReasons.push(`external_ratio=${(externalRatio * 100).toFixed(1)}% < threshold=${(threshold * 100).toFixed(0)}%`);
  }
  return {
    passed,
    total: items.length,
    sidCount,
    externalCount,
    unknownCount,
    externalRatio,
    threshold,
    classifications: items,
    rejectReasons,
  };
}

function loadTrajectoryTask(taskId: string): any | null {
  const p = join(TRAJ_ROOT, "tasks", taskId, "task.yaml");
  if (!existsSync(p)) return null;
  try {
    return parseYaml(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function loadRealTaskCases(): RepoClassification[] {
  if (!existsSync(REAL_TASKS_ROOT)) return [];
  const out: RepoClassification[] = [];
  for (const cat of readdirSync(REAL_TASKS_ROOT)) {
    const catDir = join(REAL_TASKS_ROOT, cat);
    if (cat === "scripts") continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(catDir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.startsWith("real_") || !f.endsWith(".yaml")) continue;
      const m = f.match(/^real_(T\d+)\.yaml$/);
      if (!m) continue;
      const taskId = m[1];
      const upstream = loadTrajectoryTask(taskId);
      if (!upstream) {
        out.push({ taskId, source: "unknown", evidence: `trajectory-platform task.yaml 缺失` });
        continue;
      }
      out.push(classifyTaskSourceRepo({ ...upstream, task_id: taskId }));
    }
  }
  return out.sort((a, b) => a.taskId.localeCompare(b.taskId));
}

function loadTaskList(taskIds: string[]): RepoClassification[] {
  return taskIds
    .map((tid) => {
      const y = loadTrajectoryTask(tid);
      if (!y) return { taskId: tid, source: "unknown" as const, evidence: `task.yaml 缺失` };
      return classifyTaskSourceRepo({ ...y, task_id: tid });
    })
    .sort((a, b) => a.taskId.localeCompare(b.taskId));
}

interface CliArgs {
  sourceMode: "real-tasks" | "task-list";
  taskIds: string[];
  json: boolean;
  threshold: number;
  reportPath: string | null;
}

function parseCli(argv: string[]): CliArgs {
  const out: CliArgs = {
    sourceMode: "real-tasks",
    taskIds: [],
    json: false,
    threshold: THRESHOLD,
    reportPath: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--source-mode":
        out.sourceMode = (argv[++i] as CliArgs["sourceMode"]) ?? "real-tasks";
        break;
      case "--tasks":
        out.taskIds = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--json":
        out.json = true;
        break;
      case "--threshold":
        out.threshold = parseFloat(argv[++i] ?? "0.30");
        break;
      case "--report":
        out.reportPath = argv[++i] ?? null;
        break;
    }
  }
  return out;
}

function renderMd(r: DistillCheckResult, mode: string): string {
  const lines: string[] = [];
  lines.push(`# B7-6 Trace2Skill 蒸馏护栏 1：≥30% 外部代码库校验报告`);
  lines.push(``);
  lines.push(`> 生成时间：${new Date().toISOString()}`);
  lines.push(`> 工具：evals/scripts/distill-skill-rules.ts`);
  lines.push(`> 规格：路线 §13.4.4 护栏 1（蒸馏数据来源 ≥ 30% 来自外部代码库）`);
  lines.push(`> 模式：${mode}`);
  lines.push(``);
  lines.push(`## 1. 判定结果`);
  lines.push(``);
  lines.push(`- 状态：${r.passed ? "✅ PASS（蒸馏可继续）" : "❌ REJECT（蒸馏作废）"}`);
  lines.push(`- external_ratio：**${(r.externalRatio * 100).toFixed(1)}%**（阈值 ${(r.threshold * 100).toFixed(0)}%）`);
  lines.push(`- 计入分母：${r.sidCount + r.externalCount}（sid-code + external，unknown 不计入）`);
  lines.push(`- 总条数：${r.total}（含 ${r.unknownCount} 条 unknown）`);
  if (!r.passed && r.rejectReasons) {
    lines.push(``);
    lines.push(`### 拒绝理由`);
    for (const reason of r.rejectReasons) lines.push(`- ${reason}`);
  }
  lines.push(``);
  lines.push(`## 2. 分布`);
  lines.push(``);
  lines.push(`| 来源 | 数量 | 占比 |`);
  lines.push(`| --- | ---: | ---: |`);
  const tot = Math.max(1, r.total);
  lines.push(`| external | ${r.externalCount} | ${((r.externalCount / tot) * 100).toFixed(1)}% |`);
  lines.push(`| sid-code | ${r.sidCount} | ${((r.sidCount / tot) * 100).toFixed(1)}% |`);
  lines.push(`| unknown | ${r.unknownCount} | ${((r.unknownCount / tot) * 100).toFixed(1)}% |`);
  lines.push(``);
  lines.push(`## 3. 逐条分类`);
  lines.push(``);
  lines.push(`| task_id | source | evidence |`);
  lines.push(`| --- | --- | --- |`);
  for (const c of r.classifications) {
    const icon = c.source === "external" ? "🟢" : c.source === "sid-code" ? "🟡" : "⚪";
    const ev = c.evidence.replace(/\|/g, "\\|").slice(0, 90);
    lines.push(`| ${c.taskId} | ${icon} ${c.source} | ${ev} |`);
  }
  lines.push(``);
  lines.push(`## 4. 后续动作（路线 §13.4.4）`);
  if (r.passed) {
    lines.push(`- ✅ 护栏 1 通过 → 蒸馏阶段可继续；下一步过 **护栏 2**（B7-7：holdout 200 条 execution 回归）`);
    lines.push(`- 季度复检 **护栏 3**（B7-8：GitHub Top 100 paired comparison）失败模式占比`);
  } else {
    lines.push(`- ❌ 护栏 1 拒绝 → 蒸馏作废；增加来自非 sid-code 仓库的轨迹（建议主动跑 claude-trace 在 React/Django/FastAPI/Next.js 等开源 repo 上采集 ≥ 100 条）`);
    lines.push(`- 当前 unknown 占 ${r.unknownCount} 条 → 完善 task.yaml 的 working_directory 字段，避免被规则误归类`);
  }
  return lines.join("\n");
}

async function main() {
  const args = parseCli(process.argv.slice(2));

  let items: RepoClassification[];
  let modeLabel: string;
  if (args.sourceMode === "task-list") {
    if (args.taskIds.length === 0) {
      console.error("[distill-skill-rules] --source-mode task-list 需要 --tasks T0001,T0002,...");
      process.exit(2);
    }
    items = loadTaskList(args.taskIds);
    modeLabel = `task-list (${args.taskIds.length} 条)`;
  } else {
    items = loadRealTaskCases();
    modeLabel = `real-tasks (${items.length} 条)`;
  }

  const result = checkExternalRatio(items, args.threshold);

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2));
    process.stdout.write("\n");
  } else {
    console.log(`[B7-6 护栏 1] ${modeLabel}`);
    console.log(`  external=${result.externalCount} sid-code=${result.sidCount} unknown=${result.unknownCount}`);
    console.log(`  external_ratio=${(result.externalRatio * 100).toFixed(1)}% （阈值 ${(args.threshold * 100).toFixed(0)}%）`);
    console.log(`  状态：${result.passed ? "✅ PASS" : "❌ REJECT"}`);
    if (!result.passed) {
      for (const r of result.rejectReasons ?? []) console.log(`  - ${r}`);
    }
  }

  // 报告落盘（默认 _reports/distill-guardrail-1-<mode>.md）
  const reportPath = args.reportPath ?? join(REPORT_DIR, `distill-guardrail-1-${args.sourceMode}.md`);
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(reportPath, renderMd(result, modeLabel), "utf-8");
  if (!args.json) console.log(`  报告：${reportPath}`);

  process.exit(result.passed ? 0 : 1);
}

if (import.meta.main) main();
