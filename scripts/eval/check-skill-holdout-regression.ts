#!/usr/bin/env bun
/**
 * check-skill-holdout-regression.ts —— B7-7 Trace2Skill 蒸馏护栏 2
 *
 * 触发：pre-commit / pre-merge hook 检测到 staged 文件含 SKILL.md（路径形如 src/skill/builtin/<name>/SKILL.md
 *      或 .sid-code/skills/**\/SKILL.md），即调用本扫描器。
 *
 * 行为：
 *   1. 扫 evals/holdout/**\/*.yaml，统计 grader_type=execution_test 的 case 数（holdout_exec_count）
 *   2. holdout_exec_count == 0 →
 *      - 输出 INFO（不阻塞）："holdout 暂无 execution case，护栏 2 skip；待 B7-5 永封 200 条 + 标 grader_type=execution_test 后自动激活"
 *      - 退出码 0
 *   3. holdout_exec_count > 0 →
 *      - 输出"应跑 N 条 holdout execution 回归"提示
 *      - **不真跑**（真跑要 LLM API token）；提示用户用 `bun run eval:run --cases <holdout-execution-case-glob> --provider sid-code`
 *      - 退出码 0（CI 信号靠后续真跑判定）
 *      - **铁律**：当 hook 在真 CI 中应能切换为"自动跑 + 阻塞合入"模式（CI=true 环境变量），但本 task 只落骨架
 *
 * 用法：
 *   bun run scripts/eval/check-skill-holdout-regression.ts [SKILL.md 文件列表]
 *
 *   当无参数时扫所有 staged SKILL.md。
 *
 * §13.4.4 v1.3 蒸馏护栏 3 条：
 *   ① ≥ 30% 数据来自外部代码库（B7-6 distill-skill-rules.ts）
 *   ② 蒸馏后过 holdout 200 条 execution 回归（**本 task**）
 *   ③ 季度跑外部 paired comparison（B7-8）
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import * as yamlLib from "yaml";

const SID_CODE_ROOT = resolve(import.meta.dir, "..", "..");
const HOLDOUT_DIR = join(SID_CODE_ROOT, "evals", "holdout");

interface HoldoutSurvey {
  total_cases: number;
  execution_cases: number;
  rubric_cases: number;
  other_cases: number;
  execution_case_paths: string[];
}

function walkYaml(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkYaml(p, out);
    } else if (st.isFile() && /\.ya?ml$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

export function surveyHoldout(holdoutDir: string = HOLDOUT_DIR): HoldoutSurvey {
  const survey: HoldoutSurvey = {
    total_cases: 0,
    execution_cases: 0,
    rubric_cases: 0,
    other_cases: 0,
    execution_case_paths: [],
  };

  const files = walkYaml(holdoutDir);
  for (const f of files) {
    let parsed: unknown;
    try {
      parsed = yamlLib.parse(readFileSync(f, "utf-8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.id !== "string") continue;

    survey.total_cases += 1;
    const gt = typeof obj.grader_type === "string" ? obj.grader_type : "rubric_5d"; // CaseYaml fallback
    if (gt === "execution_test") {
      survey.execution_cases += 1;
      survey.execution_case_paths.push(f);
    } else if (gt === "rubric_5d") {
      survey.rubric_cases += 1;
    } else {
      survey.other_cases += 1;
    }
  }

  return survey;
}

function isSkillMd(path: string): boolean {
  // src/skill/builtin/<name>/SKILL.md  或  .sid-code/skills/**/SKILL.md  或 .md 在 builtin 下
  const norm = path.replace(/\\/g, "/");
  return /\/SKILL\.md$/.test(norm) || /\/skills\/.+\.md$/.test(norm);
}

function main(argv: string[]): number {
  const args = argv.slice(2);

  // 解析 staged SKILL.md 列表
  let stagedSkills: string[];
  if (args.length > 0) {
    stagedSkills = args.filter(isSkillMd);
  } else {
    // 无参数 → pre-commit 之外的手动调用，扫所有 builtin SKILL.md
    stagedSkills = walkYaml(join(SID_CODE_ROOT, "src", "skill", "builtin"))
      .filter((p) => p.endsWith("/SKILL.md") || p.endsWith("\\SKILL.md"));
  }

  if (stagedSkills.length === 0) {
    console.log("[skill-holdout-guardrail] no SKILL.md changes detected, skip");
    return 0;
  }

  console.log(`[skill-holdout-guardrail] staged SKILL.md: ${stagedSkills.length} 个`);
  for (const s of stagedSkills) {
    console.log(`  - ${s.replace(SID_CODE_ROOT + "/", "")}`);
  }

  const survey = surveyHoldout();
  console.log("");
  console.log(`[skill-holdout-guardrail] holdout 状态：`);
  console.log(`  total_cases       = ${survey.total_cases}`);
  console.log(`  execution_cases   = ${survey.execution_cases}`);
  console.log(`  rubric_cases      = ${survey.rubric_cases}`);
  console.log(`  other_cases       = ${survey.other_cases}`);

  if (survey.execution_cases === 0) {
    console.log("");
    console.log("[skill-holdout-guardrail] ⚠️  护栏 2（§13.4.4 v1.3）— holdout 暂无 execution case，skip");
    console.log("    ↑ 待 B7-5「永封 200 条 holdout + 标 grader_type=execution_test」后自动激活");
    console.log("    ↑ 当前 hook 不阻塞 SKILL.md commit，但**该护栏未生效**，蒸馏改动需人工把关");
    return 0;
  }

  console.log("");
  console.log(`[skill-holdout-guardrail] ✅ holdout 有 ${survey.execution_cases} 条 execution case，应跑回归：`);
  console.log("");
  console.log(`    bun run eval:run --cases "evals/holdout/**/*.yaml" --provider sid-code`);
  console.log("");
  console.log("    跑完检查 _runs/sid_code_*.jsonl 中本次 run_id 的所有 execution_test case mandatoryPass");
  console.log("    — 任一 false 即视为护栏 2 reject，不应合入 SKILL.md 改动");
  console.log("");
  console.log("    （CI=true 环境下未来会改为自动跑 + 失败阻塞合入）");

  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv));
}

export { main, walkYaml, isSkillMd };
