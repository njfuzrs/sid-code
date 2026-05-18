/**
 * Phase 3 W8: Adapter — claude-code (占位)
 * 后续通过 `claude` CLI 实时跑 task
 */

import type { AgentOutput } from "../outcome-grader.ts";
import type { TrajectoryMetrics } from "../trajectory-grader.ts";

export interface ClaudeCodeConfig {
  cliPath: string; // claude CLI 路径
  model: string;
  timeout: number; // 单 task 超时（秒）
}

/**
 * 调用 claude CLI 跑单条 task（占位实现）
 */
export async function runClaudeCode(
  instruction: string,
  _config: ClaudeCodeConfig,
): Promise<{ output: AgentOutput; metrics: TrajectoryMetrics }> {
  // TODO: Phase 3 后期实现
  // const proc = Bun.spawn(["claude", "--model", config.model, "-p", instruction]);
  console.warn("[claude-code adapter] 占位模式，返回空结果");

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
