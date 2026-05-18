/**
 * Phase 3 W8: Adapter — codex (占位)
 * 后续通过 OpenAI Codex CLI 实时跑 task
 */

import type { AgentOutput } from "../outcome-grader.ts";
import type { TrajectoryMetrics } from "../trajectory-grader.ts";

export interface CodexConfig {
  cliPath: string;
  model: string;
  timeout: number;
}

/**
 * 调用 codex CLI 跑单条 task（占位实现）
 */
export async function runCodex(
  instruction: string,
  _config: CodexConfig,
): Promise<{ output: AgentOutput; metrics: TrajectoryMetrics }> {
  console.warn("[codex adapter] 占位模式，返回空结果");

  return {
    output: {
      tools_called: [],
      files_modified: [],
      files_created: [],
      steps: 0,
      final_response: "",
      exit_status: "not_implemented",
    },
    metrics: {
      steps: 0,
      tool_calls: 0,
      unique_tools: [],
      error_count: 0,
      retry_count: 0,
      backtrack_count: 0,
    },
  };
}
