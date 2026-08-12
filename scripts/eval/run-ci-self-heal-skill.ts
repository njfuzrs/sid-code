#!/usr/bin/env bun
/**
 * eval:ci-self-heal-skill — 跑 ci-self-heal Skill capability eval（S5-T10 Step 2 EDD）
 *
 * RFC-002 §5 / SKILL.md / 三轴螺旋 Step 2 EDD 落地（仿 run-code-review-skill.ts 形态）.
 *
 * 用法：
 *   bun run scripts/eval/run-ci-self-heal-skill.ts                       # 静态契约校验（不调 LLM）
 *   bun run scripts/eval/run-ci-self-heal-skill.ts --case case_csh_001
 *   bun run scripts/eval/run-ci-self-heal-skill.ts --execute --skill     # 真调 LLM + 注入 Skill prompt（after-baseline）
 *   bun run scripts/eval/run-ci-self-heal-skill.ts --execute             # 真调 LLM + 不注入 Skill（before-baseline）
 *   bun run scripts/eval/run-ci-self-heal-skill.ts --execute --skill --samples 3 --sync
 *
 * 默认 mode（不传 --execute）：静态契约校验.
 *
 * 落盘：
 *   evals/raw-outputs/skill-ci-self-heal-<ts>.jsonl
 *   evals/_reports/skill-ci-self-heal-<ts>.json
 */

import { mkdirSync, readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";

const ROOT = process.cwd();
const SKILL_ROOT = join(ROOT, "packages/core/src/skill/builtin/ci-self-heal");
const CASES_DIR = join(SKILL_ROOT, "evals");
const SKILL_FILE = join(SKILL_ROOT, "SKILL.md");
const RAW_DIR = join(ROOT, "evals/raw-outputs");
const REPORT_DIR = join(ROOT, "evals/_reports");

const { values } = parseArgs({
  options: {
    case: { type: "string" },
    execute: { type: "boolean", default: false },
    skill: { type: "boolean", default: false },
    samples: { type: "string", default: "1" },
    sync: { type: "boolean", default: false },
    timeout: { type: "string", default: "120000" },
    model: { type: "string" },
    "out-suffix": { type: "string" },
  },
  allowPositionals: false,
});

mkdirSync(RAW_DIR, { recursive: true });
mkdirSync(REPORT_DIR, { recursive: true });

interface CshCase {
  id: string;
  category: string;
  priority: string;
  target_score: number;
  skill?: string;
  input: { user_query: string };
  expected: {
    outcome: string;
    must_include_any_of?: string[];
    must_not_include?: string[];
    must_call_tools?: string[];
    must_not_call_tools?: string[];
    must_modify_files_in?: string[];
    must_not_modify_files?: string[];
    max_steps?: number;
  };
  baseline_scores?: Record<string, unknown>;
  source?: string;
  notes?: string;
}

function loadCases(): CshCase[] {
  if (!existsSync(CASES_DIR)) return [];
  const all: CshCase[] = [];
  for (const f of readdirSync(CASES_DIR)) {
    if (!f.startsWith("case_csh_") || !f.endsWith(".yaml")) continue;
    const c = parseYaml(readFileSync(join(CASES_DIR, f), "utf-8")) as CshCase;
    if (values.case && c.id !== values.case) continue;
    all.push(c);
  }
  all.sort((a, b) => a.id.localeCompare(b.id));
  return all;
}

interface SkillPrompt {
  system: string;
  withSkill: boolean;
}

function loadSkillPrompt(): string {
  if (!existsSync(SKILL_FILE)) return "";
  const md = readFileSync(SKILL_FILE, "utf-8");
  const match = md.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return match ? match[1] : md;
}

function buildSystemPrompt(opts: { withSkill: boolean }): SkillPrompt {
  const baseSystem = `你是 ci-self-heal 助手。基于用户提供的 CI 失败日志输出结构化诊断与修复建议。\n输出必须：(1) 引用具体 file:line 或 log line; (2) 给出 Failure Class / Confidence / Verdict / Root Cause Hypotheses; (3) 不调用 edit / write 工具修改文件; (4) 中文输入用中文输出; (5) 不编造没在 log 出现的问题(RL-007).`;
  if (!opts.withSkill) {
    return { system: baseSystem, withSkill: false };
  }
  const skillBody = loadSkillPrompt();
  return {
    system: `${baseSystem}\n\n以下是激活的 ci-self-heal Skill 提示（请严格按其约束执行）：\n\n${skillBody}`,
    withSkill: true,
  };
}

// ============================================================
// 静态契约校验（不调 LLM）
// ============================================================

function staticContractCheck(
  cases: CshCase[],
  skillPrompt: SkillPrompt,
): {
  results: Array<{
    id: string;
    contractIssues: string[];
    contractScore: number;
    estimatedExecScore: number;
    estimatedNotes: string[];
  }>;
  overall: { avgContract: number; avgEstimatedExec: number; passN: number };
} {
  const skillBody = loadSkillPrompt().toLowerCase();

  const results = cases.map((c) => {
    const issues: string[] = [];
    let contractScore = 5;
    const estimatedNotes: string[] = [];
    let estimatedExecScore = 3.0;

    // 1. case yaml 结构校验
    if (!c.expected.must_include_any_of || c.expected.must_include_any_of.length === 0) {
      issues.push("must_include_any_of 缺失或为空");
      contractScore -= 1;
    }
    if (!c.expected.must_not_include || c.expected.must_not_include.length === 0) {
      issues.push("must_not_include 缺失或为空");
      contractScore -= 1;
    }
    if (!c.expected.must_not_call_tools || !c.expected.must_not_call_tools.includes("edit")) {
      issues.push("must_not_call_tools 应含 edit（RL-001 守护）");
      contractScore -= 0.5;
    }
    if (!c.expected.must_not_call_tools || !c.expected.must_not_call_tools.includes("write")) {
      issues.push("must_not_call_tools 应含 write（RL-001 守护）");
      contractScore -= 0.5;
    }
    if (!c.expected.max_steps || c.expected.max_steps > 15) {
      issues.push("max_steps 应 ≤ 15（max-turns 守护）");
      contractScore -= 0.5;
    }

    // 2. SKILL.md 契约一致性（注入时检查）
    if (skillPrompt.withSkill) {
      if (!skillBody.includes("rl-001") && !skillBody.includes("不删")) {
        issues.push("SKILL.md 缺 RL-001 不删用户代码守护段");
        contractScore -= 0.5;
      }
      if (!skillBody.includes("rl-007") && !skillBody.includes("file:line")) {
        issues.push("SKILL.md 缺 RL-007 不编造问题守护段");
        contractScore -= 0.5;
      }
      if (!skillBody.includes("failure class") && !skillBody.includes("failure_class")) {
        issues.push("SKILL.md 缺输出契约 Failure Class 段");
        contractScore -= 0.5;
      }

      // 估算 Skill 注入后的预期 exec 分数（启发式）
      const category = c.category.toLowerCase();
      if (category.includes("trigger negative") || category.includes("false_positive")) {
        estimatedExecScore += 0.6;
        estimatedNotes.push("Skill §1 触发不命中场景 / RL-007 防编造守护，false_positive 控制");
      } else if (category.includes("failure_classification")) {
        estimatedExecScore += 0.7;
        estimatedNotes.push(
          "Skill §3.2 9 类启发式分类 + classify-failure.ts pipeline 加强分类准确性",
        );
      } else if (category.includes("fix_suggestion")) {
        estimatedExecScore += 0.5;
        estimatedNotes.push("Skill §3.4 hypothesis + Suggested Fix 模板加强建议可执行性");
      } else if (category.includes("context_awareness")) {
        estimatedExecScore += 0.6;
        estimatedNotes.push("Skill §2 输出契约要求 file:line 引用，参考 §3.1 parse-ci-log.ts 抽取");
      } else if (category.includes("trigger")) {
        estimatedExecScore += 0.4;
        estimatedNotes.push("Skill §1 触发条件描述清晰，trigger 准确");
      } else {
        estimatedExecScore += 0.3;
      }

      if (skillBody.includes("rl-007") || skillBody.includes("file:line")) {
        estimatedExecScore += 0.2;
      }
    } else {
      estimatedNotes.push("无 Skill，LLM 仅按用户 query 直接诊断，预期分类 / 引用准确率显著较低");
    }

    if (issues.length > 0) {
      estimatedExecScore -= issues.length * 0.3;
      estimatedNotes.push(`契约 ${issues.length} 处不一致，扣 ${issues.length * 0.3} 分`);
    }
    estimatedExecScore = Math.max(0, Math.min(5, estimatedExecScore));

    return {
      id: c.id,
      contractIssues: issues,
      contractScore: Math.max(0, contractScore),
      estimatedExecScore: Math.round(estimatedExecScore * 100) / 100,
      estimatedNotes,
    };
  });

  const passN = results.filter((r) => r.contractIssues.length === 0).length;
  const avgContract =
    results.length > 0 ? results.reduce((s, r) => s + r.contractScore, 0) / results.length : 0;
  const avgEstimatedExec =
    results.length > 0 ? results.reduce((s, r) => s + r.estimatedExecScore, 0) / results.length : 0;

  return { results, overall: { avgContract, avgEstimatedExec, passN } };
}

// ============================================================
// 真 baseline 跑（execute 模式）
// ============================================================

interface ExecuteResult {
  caseId: string;
  finalResponse: string;
  toolsCalled: string[];
  steps: number;
  exitStatus: string;
  timedOut: boolean;
  elapsedSec: number;
  error: boolean;
}

async function executeCase(c: CshCase, skillPrompt: SkillPrompt): Promise<ExecuteResult> {
  const { runSidCodeLive } = await import("../../evals/bench-runner/adapters/sid-code-live.ts");
  const startedAt = Date.now();

  const queryWithSystem = `${skillPrompt.system}\n\n---\n\n用户输入：\n${c.input.user_query}`;

  try {
    const live = await runSidCodeLive(queryWithSystem.trim(), {
      cwd: ROOT,
      model: values.model || process.env.SID_CODE_MODEL || "deepseek-v4-pro",
      timeoutMs: parseInt(values.timeout || "120000", 10),
    });
    return {
      caseId: c.id,
      finalResponse: live.output.final_response,
      toolsCalled: live.output.tools_called,
      steps: live.output.steps,
      exitStatus: live.output.exit_status,
      timedOut: live.timedOut,
      elapsedSec: (Date.now() - startedAt) / 1000,
      error: false,
    };
  } catch (err) {
    return {
      caseId: c.id,
      finalResponse: "",
      toolsCalled: [],
      steps: 0,
      exitStatus: "adapter_error",
      timedOut: false,
      elapsedSec: (Date.now() - startedAt) / 1000,
      error: true,
    };
  }
}

function gradeExecuteResult(
  c: CshCase,
  r: ExecuteResult,
): {
  score: number;
  details: Record<string, string | number | boolean>;
} {
  const issues: string[] = [];
  const details: Record<string, string | number | boolean> = {};
  let dimScore = 5;

  if (r.error || r.timedOut) {
    return {
      score: 0,
      details: { error: r.error, timedOut: r.timedOut, exitStatus: r.exitStatus },
    };
  }

  // 1. must_include_any_of
  const includeList = c.expected.must_include_any_of ?? [];
  if (includeList.length > 0) {
    const lower = r.finalResponse.toLowerCase();
    const hits = includeList.filter((kw) => lower.includes(kw.toLowerCase()));
    if (hits.length === 0) {
      issues.push(`must_include 0 命中（need ≥ 1，title: ${c.expected.outcome}）`);
      dimScore -= 2;
    }
    details.must_include_hits = hits.length;
  }

  // 2. must_not_include
  const blockList = c.expected.must_not_include ?? [];
  if (blockList.length > 0) {
    const lower = r.finalResponse.toLowerCase();
    const violations = blockList.filter((kw) => lower.includes(kw.toLowerCase()));
    if (violations.length > 0) {
      issues.push(`must_not_include 命中: [${violations.join(",")}]`);
      dimScore -= 2;
    }
    details.must_not_include_violations = violations.length;
  }

  // 3. must_not_call_tools（RL-001 守护）
  const blockTools = c.expected.must_not_call_tools ?? [];
  const toolViolations = blockTools.filter((t) => r.toolsCalled.includes(t));
  if (toolViolations.length > 0) {
    issues.push(`调用了禁用工具: [${toolViolations.join(",")}]`);
    dimScore -= 3;
  }
  details.tool_violations = toolViolations.length;

  // 4. max_steps
  if (c.expected.max_steps && r.steps > c.expected.max_steps) {
    issues.push(`steps=${r.steps} 超过 max_steps=${c.expected.max_steps}`);
    dimScore -= 1;
  }
  details.steps = r.steps;

  details.issues = issues.join(" | ");
  return { score: Math.max(0, Math.min(5, dimScore)), details };
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  const cases = loadCases();
  if (cases.length === 0) {
    console.error("✗ 未找到 ci-self-heal case");
    process.exit(1);
  }

  const skillPrompt = buildSystemPrompt({ withSkill: values.skill });

  console.log(`Cases       : ${cases.length} (${cases.map((c) => c.id).join(", ")})`);
  console.log(
    `Mode        : ${values.execute ? "execute (真调 LLM)" : "static-contract (不调 LLM)"}`,
  );
  console.log(
    `Skill prompt: ${skillPrompt.withSkill ? "INJECTED (after-baseline)" : "NOT injected (before-baseline)"}`,
  );
  console.log("");

  const ts = Date.now();
  const suffix = values["out-suffix"] || (skillPrompt.withSkill ? "after" : "before");
  const rawPath = join(RAW_DIR, `skill-ci-self-heal-${suffix}-${ts}.jsonl`);
  const reportPath = join(REPORT_DIR, `skill-ci-self-heal-${suffix}-${ts}.json`);

  if (!values.execute) {
    const { results, overall } = staticContractCheck(cases, skillPrompt);

    for (const r of results) {
      const status = r.contractIssues.length === 0 ? "✓" : "✗";
      console.log(
        `  ${status} ${r.id} — contract=${r.contractScore.toFixed(1)}/5 estimated_exec=${r.estimatedExecScore.toFixed(2)}/5 ${r.contractIssues.length > 0 ? `| issues: ${r.contractIssues.join("; ")}` : ""}`,
      );
    }

    console.log("");
    console.log(
      `合约一致性: ${overall.passN}/${cases.length} pass (avg contract=${overall.avgContract.toFixed(2)}/5) | estimated_exec_avg=${overall.avgEstimatedExec.toFixed(2)}/5`,
    );

    writeFileSync(rawPath, results.map((r) => JSON.stringify(r)).join("\n"));
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          ts,
          mode: "static-contract",
          skillInjected: skillPrompt.withSkill,
          overall,
          cases: results,
        },
        null,
        2,
      ),
    );

    console.log(`\nRaw    → ${rawPath}`);
    console.log(`Report → ${reportPath}`);
    return;
  }

  // 真 execute 模式
  const samplesN = Math.max(1, parseInt(values.samples || "1", 10));
  const allResults: Array<{
    caseId: string;
    samples: Array<{
      score: number;
      details: Record<string, string | number | boolean>;
      raw: ExecuteResult;
    }>;
  }> = [];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    console.log(
      `[${i + 1}/${cases.length}] ${c.id} ...${samplesN > 1 ? ` (samples=${samplesN})` : ""}`,
    );

    const samples: Array<{
      score: number;
      details: Record<string, string | number | boolean>;
      raw: ExecuteResult;
    }> = [];
    for (let s = 0; s < samplesN; s++) {
      const r = await executeCase(c, skillPrompt);
      const grade = gradeExecuteResult(c, r);
      samples.push({ score: grade.score, details: grade.details, raw: r });
      console.log(
        `  [sample ${s + 1}/${samplesN}] score=${grade.score}/5 | ${r.elapsedSec.toFixed(1)}s | ${r.exitStatus}${r.timedOut ? " ⚠️ timeout" : ""}`,
      );
    }
    allResults.push({ caseId: c.id, samples });
  }

  // 中位数分
  const summary = allResults.map((res) => {
    const scores = res.samples.map((s) => s.score).sort((a, b) => a - b);
    const median = scores[Math.floor((scores.length - 1) / 2)];
    return { caseId: res.caseId, median, samples: res.samples };
  });

  const overall = {
    n: cases.length,
    avgScore: summary.reduce((s, r) => s + r.median, 0) / summary.length,
    passRate: summary.filter((r) => r.median >= 3.5).length / summary.length,
  };

  console.log("");
  console.log("=".repeat(60));
  console.log(`${skillPrompt.withSkill ? "AFTER" : "BEFORE"}-baseline 跑完`);
  console.log("=".repeat(60));
  console.log(
    `  N=${overall.n} | avg=${overall.avgScore.toFixed(2)}/5 | pass=${(overall.passRate * 100).toFixed(0)}%`,
  );

  writeFileSync(rawPath, allResults.map((r) => JSON.stringify(r)).join("\n"));
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        ts,
        mode: "execute",
        skillInjected: skillPrompt.withSkill,
        samplesN,
        overall,
        cases: summary,
      },
      null,
      2,
    ),
  );

  console.log(`  Raw    → ${rawPath}`);
  console.log(`  Report → ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
