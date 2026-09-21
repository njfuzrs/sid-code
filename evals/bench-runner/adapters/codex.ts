/**
 * Phase 3 W8: Adapter — codex（预留对照位）
 *
 * ⚠️ 当前无调用方（import 方 = 0）。这是「对照 agent 可插拔」的唯一实证，
 * ⛔ 不许因零引用删它 —— 零引用 ≠ 零价值（与 inspect/ 同一条判据）。
 * 后续若接 OpenAI Codex CLI 实时跑 task，从这里接，不要另起一个同名入口。
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
