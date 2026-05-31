#!/usr/bin/env bun
/**
 * select-real-tasks-30.ts —— B6-2 / B6-3 批量精挑器
 *
 * 输入：trajectory-platform/bench/{splits,tasks}
 * 输出：evals/real-tasks/<category>/real_<task_id>.yaml × 30 条
 *
 * 规则（路线 §9.4 + §9.5 + §9.1）：
 *   - 强制配比：easy 5 / medium 15 / hard 10（不达标直接 abort）
 *   - 候选池：smoke + regression + capability（holdout split 是 sid 维度，跳过）
 *   - 强黑名单：B6-4 audit unsafe_for_holdout 列表（含 api_key 等）一律剔除
 *   - 弱黑名单（needs_sanitization）：保留入选但打 warning，让人工 review 时优先清理
 *   - 难度内排序：steps_primary 升序优先（小步数样本更易作 must_modify_files_in 反推）
 *   - 同 task_id 去重（split 间存在重叠）
 *   - 调用 importer：每选中一条 → bun evals/scripts/import-trajectory-platform.ts
 *
 * 用法：
 *   bun run scripts/eval/select-real-tasks-30.ts --dry-run     # 只打印选中清单
 *   bun run scripts/eval/select-real-tasks-30.ts                # 真跑 importer
 *   bun run scripts/eval/select-real-tasks-30.ts --force        # 覆盖已存在的 case
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const TRAJ_ROOT = "/Users/dev/Code/person/trajectory-platform/bench";
const TARGET_DIR = "evals/real-tasks";
const REPORT_DIR = "_reports";
const QUOTA = { easy: 5, medium: 15, hard: 10 } as const;

// B6-4 audit 强黑名单（_reports/bench-secrets-audit.md §2）
const BLACKLIST_UNSAFE = new Set<string>(["T0658"]);

// B6-4 audit 弱黑名单（§3，需脱敏；保留入选但打 warning）
const SOFT_WARN = new Set<string>([
  "T0150", "T0249", "T0517",
  "T0171", "T0193", "T0236", "T0289", "T0291", "T0316",
  "T0458", "T0459", "T0473", "T0553", "T0686", "T0776",
]);

interface Candidate {
  taskId: string;
  split: string;
  difficulty: "easy" | "medium" | "hard";
  estimatedTurns: number;
  primarySteps: number;
  tags: string[];
  hasMustModify: boolean;
  category: string;
}

const SPLITS = ["smoke", "regression", "capability"] as const;

function readSplit(name: string): string[] {
  return readFileSync(join(TRAJ_ROOT, "splits", `${name}.txt`), "utf-8")
    .split("\n").map((s) => s.trim()).filter(Boolean);
}

function loadCandidate(taskId: string, split: string): Candidate | null {
  const p = join(TRAJ_ROOT, "tasks", taskId, "task.yaml");
  if (!existsSync(p)) return null;
  let y: any;
  try {
    y = parseYaml(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
  const diff = (y?.difficulty ?? "").toLowerCase();
  if (diff !== "easy" && diff !== "medium" && diff !== "hard") return null;

  const sids: any[] = y?.source?.trajectory_sids ?? [];
  const primary = sids.find((s) => s?.role === "primary") ?? sids[0];
  const primarySteps = primary?.steps ?? 0;
  const tags: string[] = Array.isArray(y?.tags) ? y.tags : [];
  const hasMustModify = Array.isArray(y?.expected?.must_modify_files_in)
    && y.expected.must_modify_files_in.length > 0;

  return {
    taskId,
    split,
    difficulty: diff as Candidate["difficulty"],
    estimatedTurns: y?.estimated_turns ?? 0,
    primarySteps,
    tags,
    hasMustModify,
    category: pickCategory(tags, hasMustModify),
  };
}

/**
 * 从 tags + 规则推 category（落到 evals/real-tasks/<category>/）
 * 优先级：bugfix > test > config > refactor > performance > api > auth > ui > cli > docs > misc
 * 这些都是已知存在的 tag；选 1 个最具体的。
 */
function pickCategory(tags: string[], hasMustModify: boolean): string {
  const order = ["bugfix", "test", "config", "refactor", "performance", "api", "auth", "ui", "cli", "docs"];
  for (const t of order) if (tags.includes(t)) return t;
  return hasMustModify ? "task" : "misc";
}

function gatherAll(): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const split of SPLITS) {
    for (const id of readSplit(split)) {
      if (seen.has(id)) continue;
      if (BLACKLIST_UNSAFE.has(id)) continue;
      const c = loadCandidate(id, split);
      if (!c) continue;
      seen.add(id);
      out.push(c);
    }
  }
  return out;
}

/**
 * 在指定 difficulty 内按"step 升序 + smoke split 优先"选 N 条。
 * smoke split 是 trajectory-platform 自己挑的"质量最稳"小样本，优先级最高；
 * 其次 regression（已经过去重）；最后 capability（全 hard，对 hard 配额必要）。
 */
function pickN(pool: Candidate[], diff: Candidate["difficulty"], n: number): Candidate[] {
  const splitRank: Record<string, number> = { smoke: 0, regression: 1, capability: 2 };
  return pool
    .filter((c) => c.difficulty === diff)
    .sort((a, b) => {
      const sr = splitRank[a.split] - splitRank[b.split];
      if (sr !== 0) return sr;
      // 同 split：偏好 estimatedTurns 小（更易完整跑通），再 primarySteps 小
      if (a.estimatedTurns !== b.estimatedTurns) return a.estimatedTurns - b.estimatedTurns;
      return a.primarySteps - b.primarySteps;
    })
    .slice(0, n);
}

interface ImportOutcome {
  taskId: string;
  status: "ok" | "rejected" | "skipped";
  written?: string;
  setup?: string;
  warnings: string[];
  rejectReasons?: string[];
  category: string;
  difficulty: string;
  split: string;
}

function runImporter(c: Candidate, opts: { dryRun: boolean; force: boolean }): ImportOutcome {
  const sourcePath = join(TRAJ_ROOT, "tasks", c.taskId);
  const targetDir = join(TARGET_DIR, c.category);
  const args = [
    "run", "evals/scripts/import-trajectory-platform.ts",
    "--source", sourcePath,
    "--target", targetDir,
    "--category", c.category,
  ];
  if (opts.dryRun) args.push("--dry-run");
  if (opts.force) args.push("--force");

  const res = spawnSync("bun", args, { cwd: REPO_ROOT, encoding: "utf-8" });
  const tail = (res.stdout ?? "").split("\n").filter((l) => l.trim().startsWith("{") || l.trim().startsWith("\"")).join("\n");
  let parsed: any = null;
  // importer 输出最后一段 JSON.stringify
  const jsonStart = (res.stdout ?? "").lastIndexOf("{\n");
  if (jsonStart >= 0) {
    try {
      parsed = JSON.parse((res.stdout ?? "").slice(jsonStart));
    } catch {
      // 兜底：留下 stdout 整体
    }
  }
  if (res.status !== 0 && parsed?.status !== "ok") {
    return {
      taskId: c.taskId,
      status: parsed?.status === "ok" ? "ok" : "rejected",
      warnings: [...(parsed?.warnings ?? []), `[importer-exit=${res.status}] ${(res.stderr ?? "").slice(0, 400)}`],
      rejectReasons: parsed?.reject_reasons ?? [`importer exited with ${res.status}`, tail.slice(0, 400)],
      category: c.category, difficulty: c.difficulty, split: c.split,
    };
  }
  return {
    taskId: c.taskId,
    status: parsed?.status ?? "rejected",
    written: parsed?.written_path,
    setup: parsed?.setup_script_path,
    warnings: parsed?.warnings ?? [],
    rejectReasons: parsed?.reject_reasons,
    category: c.category, difficulty: c.difficulty, split: c.split,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const force = argv.includes("--force");

  const pool = gatherAll();
  console.log(`[B6-2/3] 候选池：${pool.length} 条（去重 + 已排除 unsafe_for_holdout）`);

  const easy = pickN(pool, "easy", QUOTA.easy);
  const medium = pickN(pool, "medium", QUOTA.medium);
  const hard = pickN(pool, "hard", QUOTA.hard);

  if (easy.length < QUOTA.easy || medium.length < QUOTA.medium || hard.length < QUOTA.hard) {
    console.error(`[B6-3 abort] 难度配比不足：easy=${easy.length}/${QUOTA.easy} medium=${medium.length}/${QUOTA.medium} hard=${hard.length}/${QUOTA.hard}`);
    process.exit(1);
  }

  const selected = [...easy, ...medium, ...hard];
  console.log(`[B6-3 配比] easy ${easy.length} / medium ${medium.length} / hard ${hard.length} = ${selected.length}`);
  for (const c of selected) {
    const tag = SOFT_WARN.has(c.taskId) ? " ⚠ needs_sanitization" : "";
    console.log(`  [${c.difficulty.padEnd(6)}] ${c.taskId} (${c.split}, turns=${c.estimatedTurns}, primary=${c.primarySteps}, cat=${c.category})${tag}`);
  }

  if (dryRun) {
    console.log(`\n[dry-run] importer 未调用。再传 --force 实际写入。`);
    return;
  }

  console.log(`\n[B6-2] 调用 importer 批量落盘 → ${TARGET_DIR}/...`);
  const outcomes: ImportOutcome[] = [];
  for (const c of selected) {
    const r = runImporter(c, { dryRun: false, force });
    outcomes.push(r);
    const flag = r.status === "ok" ? "✅" : "❌";
    console.log(`  ${flag} ${c.taskId} → ${r.written ?? r.rejectReasons?.[0] ?? "?"}`);
  }

  const okCount = outcomes.filter((o) => o.status === "ok").length;
  const rejected = outcomes.filter((o) => o.status !== "ok");
  console.log(`\n[B6-3 落盘汇总] ok=${okCount}/${selected.length} rejected=${rejected.length}`);

  // 报告落 _reports/real-tasks-selection-30.md
  const md = renderReport(outcomes, { easy: easy.length, medium: medium.length, hard: hard.length });
  mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = join(REPORT_DIR, "real-tasks-selection-30.md");
  writeFileSync(reportPath, md, "utf-8");
  console.log(`[B6-3 报告] ${reportPath}`);

  if (okCount < selected.length) {
    console.error(`[B6-3 warning] ${selected.length - okCount} 条 importer reject —— 见报告 §rejected。要求 §9.4 配比的 30 条最终落盘数低于目标，需补抽。`);
    process.exit(2);
  }
}

function renderReport(outcomes: ImportOutcome[], counts: { easy: number; medium: number; hard: number }): string {
  const ok = outcomes.filter((o) => o.status === "ok");
  const rj = outcomes.filter((o) => o.status !== "ok");
  const byCat = new Map<string, number>();
  for (const o of ok) byCat.set(o.category, (byCat.get(o.category) ?? 0) + 1);
  const lines: string[] = [];
  lines.push(`# B6-2 / B6-3 真实 task 30 条精挑落盘报告`);
  lines.push(``);
  lines.push(`> 生成时间：${new Date().toISOString()}`);
  lines.push(`> 工具：scripts/eval/select-real-tasks-30.ts`);
  lines.push(`> 规格：路线文档 §9.4（难度配比）+ §9.5（脱敏二审黑名单）+ §9.1（白名单字段）`);
  lines.push(``);
  lines.push(`## 1. 配比（§9.4 强约束）`);
  lines.push(``);
  lines.push(`| 难度 | 目标 | 实际选中 | importer ok |`);
  lines.push(`| --- | ---: | ---: | ---: |`);
  lines.push(`| easy | ${QUOTA.easy} | ${counts.easy} | ${ok.filter((o) => o.difficulty === "easy").length} |`);
  lines.push(`| medium | ${QUOTA.medium} | ${counts.medium} | ${ok.filter((o) => o.difficulty === "medium").length} |`);
  lines.push(`| hard | ${QUOTA.hard} | ${counts.hard} | ${ok.filter((o) => o.difficulty === "hard").length} |`);
  lines.push(`| **合计** | **30** | **${outcomes.length}** | **${ok.length}** |`);
  lines.push(``);
  lines.push(`## 2. category 分布`);
  lines.push(``);
  lines.push(`| category | 条数 |`);
  lines.push(`| --- | ---: |`);
  for (const [k, v] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) lines.push(`| ${k} | ${v} |`);
  lines.push(``);
  lines.push(`## 3. 落盘清单（ok）`);
  lines.push(``);
  lines.push(`| task_id | difficulty | category | split | warnings |`);
  lines.push(`| --- | --- | --- | --- | --- |`);
  for (const o of ok) {
    const warn = o.warnings.length > 0 ? `${o.warnings.length} 条` : "—";
    const sanFlag = SOFT_WARN.has(o.taskId) ? " 🟡需脱敏" : "";
    lines.push(`| ${o.taskId} | ${o.difficulty} | ${o.category} | ${o.split} | ${warn}${sanFlag} |`);
  }
  lines.push(``);
  if (rj.length > 0) {
    lines.push(`## 4. importer rejected`);
    lines.push(``);
    lines.push(`| task_id | difficulty | reasons |`);
    lines.push(`| --- | --- | --- |`);
    for (const o of rj) lines.push(`| ${o.taskId} | ${o.difficulty} | ${(o.rejectReasons ?? []).slice(0, 3).join("<br>")} |`);
    lines.push(``);
  }
  lines.push(`## 5. 后续动作（§9.5 + B6-3）`);
  lines.push(``);
  lines.push(`- 🟡 标记的 task_id 已被 importer secret_warn 提示——人工 review 时优先脱敏 IP / email`);
  lines.push(`- 路线 §6.2.3：execution 类 case（grader_type=execution_test）需要补 fixture / verify_commands —— importer 当前只落 grader_type 占位`);
  lines.push(`- 配比再校验：跑 \`bun run scripts/eval/select-real-tasks-30.ts --dry-run\` 复现选中清单`);
  return lines.join("\n");
}

if (import.meta.main) main();
