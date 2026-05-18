/**
 * Phase 3 W8 / W10 增强: Adapter — sid-code
 * 从已有 trajectory 提取 agent output（离线模式）
 * W10.D3a: 解析 trajectory.json 步骤数组提 error/retry/backtrack 信号
 * 后续可扩展为实时调用 sid-code CLI
 */

import type { AgentOutput } from "../outcome-grader.ts";
import type { TrajectoryMetrics } from "../trajectory-grader.ts";
import { join } from "node:path";

export interface AdapterConfig {
  trajectoryDir: string; // data/bench-staging/desensitized/
  metaFile: string; // data/bench-staging/meta/all-sessions.jsonl
}

interface SessionMeta {
  sid: string;
  model: string;
  exit_status: string;
  steps: number;
  tools_used: string[];
  files_edited: string[];
  total_steps: number;
}

interface TrajectoryStep {
  message_type?: string;
  role?: string;
  content?: unknown;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  is_error?: boolean;
  tool_use_id?: string;
}

let metaIndex: Map<string, SessionMeta> | null = null;

async function loadMetaIndex(metaFile: string): Promise<Map<string, SessionMeta>> {
  if (metaIndex) return metaIndex;
  const content = await Bun.file(metaFile).text();
  const map = new Map<string, SessionMeta>();
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    map.set(rec.sid, rec);
  }
  metaIndex = map;
  return map;
}

/**
 * 解析 trajectory steps 提 L2 信号
 * - error_count: observation 步骤里 is_error == true 的数量
 * - retry_count: 同 tool_name + 相似 tool_input（input JSON 串前 100 字符匹配）的连续 action 次数
 * - backtrack_count: tool_name in {Write, Edit} 且同一 file_path 出现 ≥ 2 次（回溯重写）
 */
function analyzeTrajectorySignals(steps: TrajectoryStep[]): {
  error_count: number;
  retry_count: number;
  backtrack_count: number;
} {
  let errorCount = 0;
  let retryCount = 0;

  // 提 action 步骤序列做 retry 分析
  type ActionFp = { tool: string; fp: string };
  const actions: ActionFp[] = [];
  // file_path 写入次数（Write/Edit 类工具）
  const writeFiles = new Map<string, number>();

  for (const step of steps) {
    // 1. error_count
    if (step.is_error === true) {
      errorCount++;
    }

    // 2. action 步骤参与 retry 与 backtrack
    if (step.message_type === "action" && step.tool_name) {
      const tool = step.tool_name;
      const inputStr = step.tool_input ? JSON.stringify(step.tool_input).slice(0, 100) : "";
      actions.push({ tool, fp: `${tool}|${inputStr}` });

      const writeTools = new Set(["Write", "Edit", "NotebookEdit"]);
      if (writeTools.has(tool) && step.tool_input) {
        const input = step.tool_input as Record<string, unknown>;
        const fp = (input.file_path || input.path || input.filePath) as string | undefined;
        if (fp) {
          writeFiles.set(fp, (writeFiles.get(fp) || 0) + 1);
        }
      }
    }
  }

  // retry: 相邻两步 fingerprint 相同（同工具 + 同前缀 input）
  for (let i = 1; i < actions.length; i++) {
    if (actions[i].fp === actions[i - 1].fp) {
      retryCount++;
    }
  }

  // backtrack: 同一 file 写 ≥ 2 次，每超出 1 次算 1 次回溯
  let backtrackCount = 0;
  for (const count of writeFiles.values()) {
    if (count >= 2) {
      backtrackCount += count - 1;
    }
  }

  return { error_count: errorCount, retry_count: retryCount, backtrack_count: backtrackCount };
}

/**
 * 从已有 trajectory 提取 agent output
 */
export async function extractAgentOutput(
  taskSids: Array<{ sid: string; role: string }>,
  config: AdapterConfig,
): Promise<{ output: AgentOutput; metrics: TrajectoryMetrics }> {
  const meta = await loadMetaIndex(config.metaFile);

  // 选 primary sid
  const primaryEntry = taskSids.find((t) => t.role === "primary") || taskSids[0];
  if (!primaryEntry) {
    return {
      output: {
        tools_called: [],
        files_modified: [],
        files_created: [],
        steps: 0,
        final_response: "",
        exit_status: "unknown",
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

  const sid = primaryEntry.sid;
  const sessionMeta = meta.get(sid);

  // 读 trajectory 拿 final_response + L2 信号
  let finalResponse = "";
  let trajSignals = { error_count: 0, retry_count: 0, backtrack_count: 0 };
  const trajPath = join(config.trajectoryDir, sid, "trajectory.json");
  try {
    const trajContent = await Bun.file(trajPath).text();
    const trajData = JSON.parse(trajContent);
    const trajectory: TrajectoryStep[] = trajData.trajectory || [];

    // 从末尾找 assistant 消息（final_response）
    for (let i = trajectory.length - 1; i >= 0; i--) {
      const step = trajectory[i];
      if (step?.role === "assistant" && typeof step.content === "string" && step.content.length > 50) {
        finalResponse = step.content.slice(0, 3000);
        break;
      }
    }

    // 提 L2 信号
    trajSignals = analyzeTrajectorySignals(trajectory);
  } catch {
    // trajectory 文件不存在或解析失败 → 信号留 0
  }

  const output: AgentOutput = {
    tools_called: sessionMeta?.tools_used || [],
    files_modified: sessionMeta?.files_edited || [],
    files_created: [],
    steps: sessionMeta?.steps || sessionMeta?.total_steps || 0,
    final_response: finalResponse,
    exit_status: sessionMeta?.exit_status || "unknown",
  };

  // trajectory metrics（W10.D3a 起接入真信号）
  const metrics: TrajectoryMetrics = {
    steps: output.steps,
    tool_calls: output.tools_called.length,
    unique_tools: [...new Set(output.tools_called)],
    error_count: trajSignals.error_count,
    retry_count: trajSignals.retry_count,
    backtrack_count: trajSignals.backtrack_count,
  };

  return { output, metrics };
}

// 暴露纯函数给单元测试用
export { analyzeTrajectorySignals };

