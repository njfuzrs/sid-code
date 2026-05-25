/**
 * ExecutionTestGrader — SWE-bench 风格 execution-based binary grader（T-19 §6.5）
 *
 * 设计依据：docs/eval/investigations/eval-rubric-industry-survey.md §6.5 T-19
 * 业界对齐：
 *   - SWE-bench Verified（500 case 全 docker，0 LLM judge）
 *   - SWE Atlas mandatory rubric（execution-based）
 *   - Inspect AI sandbox scorer（check_file_exists / bash 退出码）
 *
 * 流程：
 *   1. 在 sandbox 写 fixtures
 *   2. （可选）跑 pre_apply_must_fail 验证 fixture 确实是"坏的"
 *   3. 应用 agent patch（apply_mode）
 *   4. 跑 verify_commands；全部 0 退出 → mandatoryPass=true, score=1.0
 *
 * Skill case 实例：
 *   - code-review：fixture broken code → agent patch → bun test 必须由 fail 转 pass
 *   - ci-self-heal：fixture type error → agent fix → tsc --noEmit 必须 0 退出
 *   - security-audit：fixture SQL injection → agent fix → 模拟攻击命令应被拦截
 */

import { GRADER_VERSION } from "../eval-judge";
import { isCompleteFailure } from "../eval-runner";
import { runSandbox } from "../_sandbox";
import type { Grader, GraderContext, GraderResult } from "./types";
import type { DimScore } from "../eval-judge";
import type { ExecutionTestSpec } from "../_types";

export class ExecutionTestGrader implements Grader {
  readonly type = "execution_test";
  readonly description = "SWE-bench 风格 execution grading：sandbox 跑测试命令决定 binary pass/fail";

  async grade(ctx: GraderContext): Promise<GraderResult> {
    const { caseYaml, providerResult } = ctx;

    const failure = isCompleteFailure(providerResult);
    if (failure.failed) {
      return errResult(this.type, `wrapper 失败：${failure.reason}`);
    }

    const spec = caseYaml.execution_test;
    if (!spec) {
      return errResult(this.type, "case 未配置 execution_test（grader_type=execution_test 但无规则）");
    }

    // Step 1: 准备 fixture
    const files = [...spec.fixtures];

    // Step 2:（可选）pre-apply 验证：fixture 确实是"坏的"
    if (spec.pre_apply_must_fail && spec.pre_apply_must_fail.length > 0) {
      const preCheck = await runSandbox({
        files,
        commands: spec.pre_apply_must_fail.map((c) => ({ cmd: c.cmd, args: c.args })),
        sandbox: { timeoutMs: 30_000 },
      });
      const allFailed = preCheck.exec.every((e) => e.exitCode !== 0);
      if (!allFailed) {
        return errResult(
          this.type,
          `pre_apply_must_fail 检查不通过：fixture 在未应用 patch 时本应全部 fail，但实测 ${preCheck.exec.filter((e) => e.exitCode === 0).length} 条 0 退出。说明 fixture 不是真"坏"的，case 设计错误。`,
        );
      }
    }

    // Step 3: 应用 agent patch
    const finalFiles = await this.applyPatch(files, providerResult.output, spec);
    if ("error" in finalFiles) {
      return errResult(this.type, finalFiles.error);
    }

    // Step 4: 跑 verify commands
    const result = await runSandbox({
      files: finalFiles.files,
      commands: spec.verify_commands.map((c) => ({ cmd: c.cmd, args: c.args })),
      sandbox: { timeoutMs: spec.total_timeout_ms ?? 120_000 },
    });

    const allOk = result.allOk;
    const score = allOk ? 1.0 : 0.0;
    const summary = result.exec
      .map(
        (e, i) =>
          `[${i + 1}/${result.exec.length}] ${e.exitCode === 0 ? "✅" : "❌"} ${e.cmd} (exit=${e.exitCode}${e.timedOut ? ", TIMEOUT" : ""}, ${e.durationMs}ms)`,
      )
      .join("\n");

    const dim: DimScore = {
      pass: allOk,
      score,
      reason: summary,
    };

    return {
      score,
      namedScores: { execution_check: score },
      dims: { execution_check: dim },
      mandatoryPass: allOk,
      graderType: this.type,
      graderVersion: GRADER_VERSION,
    };
  }

  private async applyPatch(
    files: ExecutionTestSpec["fixtures"],
    agentOutput: string,
    spec: ExecutionTestSpec,
  ): Promise<{ files: ExecutionTestSpec["fixtures"] } | { error: string }> {
    if (spec.apply_mode === "skip") {
      return { files };
    }

    if (spec.apply_mode === "extract_diff") {
      // 从 agent 输出末尾提取 ```diff 或 ```patch 块
      const m = agentOutput.match(/```(?:diff|patch)\n([\s\S]*?)\n```/);
      if (!m) {
        return { error: "agent 输出不含 ```diff/```patch 代码块（execution_test 期望 unified diff）" };
      }
      // 把 patch 写入 sandbox 一同放 files；verify_commands 第一条应是 git apply
      // —— 但更鲁棒的做法是直接预处理：在 fixtures 前加 patch 文件 + git apply 命令
      // 当前最小实现：把 patch 作为额外文件写入，留给 verify_commands 决定如何应用
      return {
        files: [
          ...files,
          { path: "_agent.patch", content: m[1] },
        ],
      };
    }

    if (spec.apply_mode === "extract_files") {
      // 从 agent 输出提取 "=== FILE: path ===" 段
      const fileBlocks = parseFileBlocks(agentOutput);
      if (fileBlocks.length === 0) {
        return { error: "agent 输出不含 '=== FILE: path ===' 文件段（apply_mode=extract_files）" };
      }
      // 用 agent 输出的内容覆盖 fixture（同 path），不冲突的 fixture 保留
      const byPath = new Map<string, string>();
      for (const f of files) byPath.set(f.path, f.content);
      for (const b of fileBlocks) byPath.set(b.path, b.content);
      return {
        files: Array.from(byPath.entries()).map(([path, content]) => ({ path, content })),
      };
    }

    return { error: `未知 apply_mode: ${(spec as { apply_mode: string }).apply_mode}` };
  }
}

function errResult(type: string, reason: string): GraderResult {
  return {
    score: null,
    namedScores: { execution_check: null },
    dims: { execution_check: { pass: false, score: null, reason } },
    mandatoryPass: false,
    graderType: type,
    graderVersion: GRADER_VERSION,
  };
}

function parseFileBlocks(output: string): Array<{ path: string; content: string }> {
  const blocks: Array<{ path: string; content: string }> = [];
  // 按行扫描，遇到 === FILE: ... === 开新 block，遇到下一个 marker 或 EOF 结束
  const lines = output.split("\n");
  let current: { path: string; lines: string[] } | null = null;
  for (const line of lines) {
    const m = line.match(/^===\s*FILE:\s*(.+?)\s*===\s*$/);
    if (m) {
      if (current) blocks.push({ path: current.path, content: current.lines.join("\n").trim() });
      current = { path: m[1].trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) blocks.push({ path: current.path, content: current.lines.join("\n").trim() });
  return blocks;
}
