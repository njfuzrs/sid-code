/**
 * StructuredArchGrader — 架构 case 结构化断言评分器（T-10 引入）
 *
 * 用例：架构 holdout case 验证仓库结构、文件存在性、模块边界等"静态可观测"约束。
 *
 * case yaml 形态：
 *   grader_type: structured_arch
 *   arch_assertions:
 *     - { type: file_must_exist, path: "src/skill/code-review/SKILL.md" }
 *     - { type: file_lines_lt, path: "src/cli.ts", max_lines: 500 }
 *     - { type: dir_must_contain_files, dir: "src/skill/", min_count: 5 }
 *
 * 评分语义：
 *   - 全部断言 pass → score=1.0, mandatoryPass=true
 *   - 任一断言 fail → score = passCount/total（部分得分供诊断）, mandatoryPass=false
 *
 * 与 binary_redline 区别：
 *   - binary_redline 评 agent 输出 + 工具调用；structured_arch 评仓库静态状态
 *   - structured_arch 不调 LLM judge；纯文件系统检查（execution grading 风格）
 *   - score 不是 binary 而是 fraction，便于看哪些项过/没过
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { STRUCTURED_ARCH_VERSION } from "../eval-judge";
import type { Grader, GraderContext, GraderResult } from "./types";
import type { DimScore } from "../eval-judge";
import type { ArchAssertion } from "../_types";

interface AssertionResult {
  assertion: ArchAssertion;
  pass: boolean;
  reason: string;
}

export class StructuredArchGrader implements Grader {
  readonly type = "structured_arch";
  readonly description = "架构断言：file_must_exist / file_lines_lt 等纯文件系统检查，无 LLM judge";
  readonly requiresAgentOutput = false;

  /**
   * 仓库根目录（用于解析 arch_assertions 中的相对路径）。
   * 默认为 process.cwd()——eval-runner 跑评测时是 sid-code 项目根。
   */
  private repoRoot: string;

  constructor(repoRoot: string = process.cwd()) {
    this.repoRoot = repoRoot;
  }

  async grade(ctx: GraderContext): Promise<GraderResult> {
    const { caseYaml } = ctx;
    const assertions: ArchAssertion[] = caseYaml.arch_assertions || [];

    if (assertions.length === 0) {
      return {
        score: null,
        namedScores: { arch_check: null },
        dims: {
          arch_check: {
            pass: true,
            score: null,
            reason: "case 未配置 arch_assertions（grader_type=structured_arch 但无断言）",
          },
        },
        mandatoryPass: true,
        graderType: this.type,
        graderVersion: STRUCTURED_ARCH_VERSION,
      };
    }

    const results: AssertionResult[] = assertions.map((a) => this.evalAssertion(a));
    const passCount = results.filter((r) => r.pass).length;
    const score = passCount / results.length;
    const allPass = passCount === results.length;

    const summary = results
      .map(
        (r, i) =>
          `[${i + 1}/${results.length}] ${r.pass ? "✅" : "❌"} ${describeAssertion(r.assertion)}: ${r.reason}`,
      )
      .join("\n");

    const dim: DimScore = {
      pass: allPass,
      score,
      reason: summary,
    };

    return {
      score,
      namedScores: { arch_check: score },
      dims: { arch_check: dim },
      mandatoryPass: allPass,
      graderType: this.type,
      graderVersion: STRUCTURED_ARCH_VERSION,
    };
  }

  private evalAssertion(assertion: ArchAssertion): AssertionResult {
    switch (assertion.type) {
      case "file_must_exist": {
        const abs = resolve(this.repoRoot, assertion.path);
        const ok = existsSync(abs) && statSync(abs).isFile();
        return { assertion, pass: ok, reason: ok ? `存在` : `不存在: ${assertion.path}` };
      }
      case "file_must_not_exist": {
        const abs = resolve(this.repoRoot, assertion.path);
        const exists = existsSync(abs);
        return {
          assertion,
          pass: !exists,
          reason: exists ? `仍存在（应已删除）: ${assertion.path}` : `不存在 ✓`,
        };
      }
      case "file_lines_lt": {
        const abs = resolve(this.repoRoot, assertion.path);
        if (!existsSync(abs)) {
          return { assertion, pass: false, reason: `文件不存在: ${assertion.path}` };
        }
        const lines = readFileSync(abs, "utf-8").split("\n").length;
        return {
          assertion,
          pass: lines < assertion.max_lines,
          reason: `${lines} 行（上限 ${assertion.max_lines}）`,
        };
      }
      case "file_must_contain": {
        const abs = resolve(this.repoRoot, assertion.path);
        if (!existsSync(abs)) {
          return { assertion, pass: false, reason: `文件不存在: ${assertion.path}` };
        }
        const content = readFileSync(abs, "utf-8");
        const ok = content.includes(assertion.pattern);
        return {
          assertion,
          pass: ok,
          reason: ok ? `包含 pattern` : `不含 pattern: "${assertion.pattern.slice(0, 60)}"`,
        };
      }
      case "dir_must_contain_files": {
        const abs = resolve(this.repoRoot, assertion.dir);
        if (!existsSync(abs) || !statSync(abs).isDirectory()) {
          return { assertion, pass: false, reason: `目录不存在: ${assertion.dir}` };
        }
        const count = countFilesRecursive(abs);
        return {
          assertion,
          pass: count >= assertion.min_count,
          reason: `${count} 文件（下限 ${assertion.min_count}）`,
        };
      }
      default: {
        const exhaustive: never = assertion;
        return { assertion: exhaustive, pass: false, reason: "未知 arch assertion 类型" };
      }
    }
  }
}

function countFilesRecursive(dir: string): number {
  let count = 0;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isFile()) count++;
    else if (st.isDirectory()) count += countFilesRecursive(p);
  }
  return count;
}

function describeAssertion(a: ArchAssertion): string {
  switch (a.type) {
    case "file_must_exist":
      return `file_must_exist(${a.path})`;
    case "file_must_not_exist":
      return `file_must_not_exist(${a.path})`;
    case "file_lines_lt":
      return `file_lines_lt(${a.path}, <${a.max_lines})`;
    case "file_must_contain":
      return `file_must_contain(${a.path})`;
    case "dir_must_contain_files":
      return `dir_must_contain_files(${a.dir}, ≥${a.min_count})`;
    default:
      return "unknown";
  }
}
