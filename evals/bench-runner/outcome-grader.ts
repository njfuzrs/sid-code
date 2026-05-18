/**
 * Phase 3 W7: 三层 Grader — Layer 1 Outcome Grader
 * 基于 task.yaml 的 expected 断言做确定性评分
 */

export interface GradeResult {
  score: number; // 0-5
  layer: string;
  details: Record<string, boolean | number>;
  reasoning: string;
}

export interface TaskExpected {
  outcome?: string;
  must_call_tools?: string[];
  must_not_call_tools?: string[];
  max_steps?: number;
  must_modify_files_in?: string[];
  must_create_files?: string[];
  must_not_modify_files?: string[];
  must_include_keywords?: string[];
}

export interface AgentOutput {
  tools_called: string[];
  files_modified: string[];
  files_created: string[];
  steps: number;
  final_response: string;
  exit_status: string;
}

/**
 * Layer 1: Outcome Grader — 确定性断言评分
 * 不调 LLM，纯规则匹配，毫秒级
 */
export function gradeOutcome(expected: TaskExpected, output: AgentOutput): GradeResult {
  const checks: Record<string, boolean> = {};
  let passed = 0;
  let total = 0;

  // 1. must_call_tools
  if (expected.must_call_tools && expected.must_call_tools.length > 0) {
    const called = new Set(output.tools_called.map((t) => t.toLowerCase()));
    for (const tool of expected.must_call_tools) {
      const key = `must_call:${tool}`;
      const ok = called.has(tool.toLowerCase());
      checks[key] = ok;
      total++;
      if (ok) passed++;
    }
  }

  // 2. must_not_call_tools
  if (expected.must_not_call_tools && expected.must_not_call_tools.length > 0) {
    const called = new Set(output.tools_called.map((t) => t.toLowerCase()));
    for (const tool of expected.must_not_call_tools) {
      const key = `must_not_call:${tool}`;
      const ok = !called.has(tool.toLowerCase());
      checks[key] = ok;
      total++;
      if (ok) passed++;
    }
  }

  // 3. max_steps
  if (expected.max_steps && expected.max_steps > 0) {
    const ok = output.steps <= expected.max_steps;
    checks["within_max_steps"] = ok;
    total++;
    if (ok) passed++;
  }

  // 4. must_modify_files_in
  if (expected.must_modify_files_in && expected.must_modify_files_in.length > 0) {
    const modified = new Set(output.files_modified.map((f) => f.toLowerCase()));
    for (const file of expected.must_modify_files_in) {
      const key = `must_modify:${file}`;
      const ok = modified.has(file.toLowerCase());
      checks[key] = ok;
      total++;
      if (ok) passed++;
    }
  }

  // 5. must_not_modify_files
  if (expected.must_not_modify_files && expected.must_not_modify_files.length > 0) {
    const modified = new Set(output.files_modified.map((f) => f.toLowerCase()));
    for (const file of expected.must_not_modify_files) {
      const key = `must_not_modify:${file}`;
      const ok = !modified.has(file.toLowerCase());
      checks[key] = ok;
      total++;
      if (ok) passed++;
    }
  }

  // 6. must_include_keywords
  if (expected.must_include_keywords && expected.must_include_keywords.length > 0) {
    const response = output.final_response.toLowerCase();
    let keywordHits = 0;
    for (const kw of expected.must_include_keywords) {
      const key = `must_include:${kw}`;
      const ok = response.includes(kw.toLowerCase());
      checks[key] = ok;
      total++;
      if (ok) {
        passed++;
        keywordHits++;
      }
    }
  }

  // 7. exit_status check
  if (output.exit_status === "end_turn" || output.exit_status === "tool_use") {
    checks["normal_exit"] = true;
    total++;
    passed++;
  } else if (output.exit_status) {
    checks["normal_exit"] = false;
    total++;
  }

  // 计算分数: 0-5 线性映射
  const ratio = total > 0 ? passed / total : 0;
  const score = Math.round(ratio * 5 * 10) / 10; // 保留 1 位小数

  return {
    score,
    layer: "outcome",
    details: checks,
    reasoning: `${passed}/${total} assertions passed (${(ratio * 100).toFixed(0)}%)`,
  };
}
