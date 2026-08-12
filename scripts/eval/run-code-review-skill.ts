#!/usr/bin/env bun
/**
 * eval:code-review-skill — 跑 code-review Skill capability eval（S3-T11 Step 5 EDD）
 *
 * RFC-001 §5 / SKILL.md / 三轴螺旋 Step 5 落地。
 *
 * 用法：
 *   bun run scripts/eval/run-code-review-skill.ts                     # 静态分析（不调 LLM）
 *   bun run scripts/eval/run-code-review-skill.ts --case case_cr_001
 *   bun run scripts/eval/run-code-review-skill.ts --execute --skill   # 真调 LLM + 注入 Skill prompt（after-baseline）
 *   bun run scripts/eval/run-code-review-skill.ts --execute           # 真调 LLM + 不注入 Skill（before-baseline）
 *   bun run scripts/eval/run-code-review-skill.ts --execute --samples 3 --sync
 *
 * 默认 mode（不传 --execute）：
 *   走静态契约校验 — 把 case yaml 的 expected.must_not_call_tools 作为 hard floor，
 *   不真调 LLM。用于 S3 内快速验证 case yaml + Skill 设计契约的协同性。
 *   真 baseline 跑分需要 --execute，本地 ANTHROPIC_API_KEY / DEEPSEEK_API_KEY 配置就绪后跑。
 *
 * 落盘：
 *   evals/raw-outputs/skill-code-review-<ts>.jsonl
 *   evals/_reports/skill-code-review-<ts>.json
 */

import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";

const ROOT = process.cwd();
const SKILL_ROOT = join(ROOT, "packages/core/src/skill/builtin/code-review");
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
    timeout: { type: "string", default: "180000" },
    model: { type: "string" },
    "out-suffix": { type: "string" },
  },
  allowPositionals: false,
});

mkdirSync(RAW_DIR, { recursive: true });
mkdirSync(REPORT_DIR, { recursive: true });

interface CrCase {
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

function loadCases(): CrCase[] {
  if (!existsSync(CASES_DIR)) return [];
  const all: CrCase[] = [];
  for (const f of require("node:fs").readdirSync(CASES_DIR)) {
    if (!f.startsWith("case_cr_") || !f.endsWith(".yaml")) continue;
    const c = parseYaml(readFileSync(join(CASES_DIR, f), "utf-8")) as CrCase;
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
  const baseSystem = `你是 code-review 助手。基于用户提供的 PR diff 给出结构化 review。\n输出必须：(1) 引用具体 file:line；(2) 不调用 edit / write 工具修改文件；(3) 中文 PR 用中文 review。`;
  if (!opts.withSkill) {
    return { system: baseSystem, withSkill: false };
  }
  const skillBody = loadSkillPrompt();
  return {
    system: `${baseSystem}\n\n以下是激活的 code-review Skill 提示（请严格按其约束执行）：\n\n${skillBody}`,
    withSkill: true,
  };
}

// ============================================================
// 静态契约校验（不调 LLM）
// ============================================================

/**
 * 静态模式：不真跑 agent，而是：
 *   1. 校验 case yaml 结构完整性（must_include_any_of / must_not_include / 五维度覆盖）
 *   2. 校验 SKILL.md 的契约符合 case 期望（如 must_not_call_tools 含 edit / write，SKILL.md 也禁用 edit / write）
 *   3. 输出 dry-run 报告 — 表明 case + Skill 设计契约一致
 *
 * 这不是真 baseline，但可以快速发现 case / Skill 设计错位。
 * 真 baseline 需要 --execute 模式。
 */
function staticContractCheck(
  cases: CrCase[],
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
  const skillBody = skillPrompt.withSkill ? loadSkillPrompt().toLowerCase() : "";

  const results = cases.map((c) => {
    const issues: string[] = [];
    if (!c.expected) issues.push("缺 expected 段");
    if (!Array.isArray(c.expected?.must_not_include) || c.expected.must_not_include.length === 0) {
      issues.push("缺 must_not_include 反例字段（_template.yaml 强制）");
    }
    const blocked = c.expected?.must_not_call_tools ?? [];
    if (!blocked.includes("edit") || !blocked.includes("write")) {
      issues.push("must_not_call_tools 应含 edit / write（review 类 Skill 不修改文件）");
    }
    if (!c.input?.user_query || c.input.user_query.length < 20) {
      issues.push("user_query 过短（< 20 字符）");
    }
    if (!c.skill || c.skill !== "code-review") {
      issues.push("缺 skill: code-review 字段");
    }

    if (skillPrompt.withSkill) {
      if (
        skillPrompt.system.includes("不删除用户代码") ||
        skillPrompt.system.includes("不修改文件")
      ) {
        // ok
      } else {
        issues.push("SKILL.md 未明确禁止修改文件 — 与 case 期望失配");
      }
    }

    const contractScore = issues.length === 0 ? 5 : Math.max(0, 5 - issues.length);

    // 模拟评分：估算 raw LLM (without Skill) vs LLM + Skill prompt 的预期表现。
    // 不调真 LLM，但基于以下假设给出"信号锚点估算"：
    //   1. raw LLM 没有 Skill 的具体指引，应能识别常见 bug（issue_detection），
    //      但对 AI 反模式 / severity 分级 / false_positive 控制能力较弱。
    //   2. LLM + Skill prompt 注入了 SKILL.md 的 AI 反模式清单 / severity guide / 输出模板，
    //      应能在 issue_detection / suggestion / context_awareness 维度提分。
    const estimatedNotes: string[] = [];
    let estimatedExecScore = 3.5; // 基础分（LLM 一般能给出泛泛 review）

    const category = c.category || "";

    if (skillPrompt.withSkill) {
      // Skill 提供具体指引，估算 +/- 各维度
      if (category.includes("trigger")) {
        estimatedExecScore += 0.5;
        estimatedNotes.push("Skill 含 'when-to-use' 触发指引，提高 trigger 维度命中率");
      }
      if (category.includes("issue_detection")) {
        estimatedExecScore += 0.8;
        estimatedNotes.push("Skill 含 AI 反模式清单 / 7 维度检查清单，提高 issue 检出");
      }
      if (category.includes("false_positive")) {
        estimatedExecScore += 0.6;
        estimatedNotes.push("Skill §4.2 false_positive 控制 + severity guide，降低误报");
      }
      if (category.includes("suggestion_quality")) {
        estimatedExecScore += 0.5;
        estimatedNotes.push("Skill 要求 Suggestion 可执行 + 含具体代码，提高 suggestion 质量");
      }
      if (category.includes("context_awareness")) {
        estimatedExecScore += 0.6;
        estimatedNotes.push("Skill §4.1 RL-007 + must read 工具用法，强化 file:line 引用");
      }
      // 边界 case（S4-T01 加入）：长 PR / 空 PR / 二进制 / 仅文档 / 跨语言混合
      // SKILL.md §1 触发不命中场景 + §2.1 长 PR 警告 + §2.4 多维度检查清单提供具体指引
      if (category.includes("boundary")) {
        if (category.includes("long_pr")) {
          estimatedExecScore += 0.5;
          estimatedNotes.push(
            "Skill §2.1 长 PR 警告（> 50 文件 / > 1000 行），提供拆分 + 局部 review 指引",
          );
        } else if (category.includes("empty_pr")) {
          estimatedExecScore += 0.6;
          estimatedNotes.push(
            "Skill §1 触发不命中场景含 whitespace-only 跳过指引，false_positive 控制",
          );
        } else if (category.includes("binary")) {
          estimatedExecScore += 0.7;
          estimatedNotes.push(
            "Skill §1 触发不命中含二进制文件 (.png/.pdf/.lock) 跳过指引，false_positive 控制",
          );
        } else if (category.includes("docs_only")) {
          estimatedExecScore += 0.6;
          estimatedNotes.push("Skill §1 触发不命中含 docs/ 跳过指引，false_positive 控制");
        } else if (category.includes("mixed_languages")) {
          estimatedExecScore += 0.7;
          estimatedNotes.push(
            "Skill §2.4 7 维度检查清单 + AI 反模式清单跨语言适用，加强多语言 issue 检出",
          );
        } else {
          estimatedExecScore += 0.4;
          estimatedNotes.push("Skill 边界场景指引（通用）");
        }
      }
      // 跨维度的红线守护
      if (skillBody.includes("rl-007") || skillBody.includes("file:line")) {
        estimatedExecScore += 0.2;
      }
    } else {
      estimatedNotes.push("无 Skill，LLM 仅按用户 query 直接 review，预期泛泛");
    }

    if (issues.length > 0) {
      estimatedExecScore -= issues.length * 0.3;
      estimatedNotes.push(`契约 ${issues.length} 处不一致，扣 ${issues.length * 0.3} 分`);
    }
    estimatedExecScore = Math.max(0, Math.min(5, estimatedExecScore));

    return {
      id: c.id,
      contractIssues: issues,
      contractScore,
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
// 真 baseline 跑（execute 模式）—— 调 LLM 通过 sid-code-live wrapper
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

async function executeCase(c: CrCase, skillPrompt: SkillPrompt): Promise<ExecuteResult> {
  const { runSidCodeLive } = await import("../../evals/bench-runner/adapters/sid-code-live.ts");
  const startedAt = Date.now();

  // 注入 system 提示作为 query 前置（sid-code-live wrapper 不直接接受 system 参数 — 这是个简化）
  const queryWithSystem = skillPrompt.withSkill
    ? `${skillPrompt.system}\n\n---\n\n用户输入：\n${c.input.user_query}`
    : `${skillPrompt.system}\n\n---\n\n用户输入：\n${c.input.user_query}`;

  try {
    const live = await runSidCodeLive(queryWithSystem.trim(), {
      cwd: ROOT,
      model: values.model || process.env.SID_CODE_MODEL || "deepseek-v4-pro",
      timeoutMs: parseInt(values.timeout || "180000", 10),
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
  c: CrCase,
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

  // 3. must_not_call_tools
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
    console.error("✗ 未找到 code-review case");
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
  const rawPath = join(RAW_DIR, `skill-code-review-${suffix}-${ts}.jsonl`);
  const reportPath = join(REPORT_DIR, `skill-code-review-${suffix}-${ts}.json`);

  if (!values.execute) {
    // 静态契约校验模式
    const { results, overall } = staticContractCheck(cases, skillPrompt);

    for (const r of results) {
      const status = r.contractIssues.length === 0 ? "✓" : "✗";
      console.log(
        `  ${status} ${r.id} — contract=${r.contractScore}/5 estimated_exec=${r.estimatedExecScore}/5 ${r.contractIssues.length > 0 ? `| issues: ${r.contractIssues.join("; ")}` : ""}`,
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
