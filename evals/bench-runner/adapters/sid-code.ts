/**
 * Phase 3 W8: Adapter — sid-code
 * 从已有 trajectory 提取 agent output（离线模式）
 * 后续可扩展为实时调用 sid-code CLI
 */

import type { AgentOutput } from "../outcome-grader.ts";
import type { TrajectoryMetrics } from "../trajectory-grader.ts";
import { readdir } from "node:fs/promises";
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

  // 尝试读 trajectory 获取 final_response
  let finalResponse = "";
  const trajPath = join(config.trajectoryDir, sid, "trajectory.json");
  try {
    const trajContent = await Bun.file(trajPath).text();
    const trajData = JSON.parse(trajContent);
    const trajectory = trajData.trajectory || [];

    // 从末尾找 assistant 消息
    for (let i = trajectory.length - 1; i >= 0; i--) {
      const step = trajectory[i];
      if (step?.role === "assistant" && typeof step.content === "string" && step.content.length > 50) {
        finalResponse = step.content.slice(0, 3000);
        break;
      }
    }
  } catch {
    // trajectory 文件不存在或解析失败
  }

  const output: AgentOutput = {
    tools_called: sessionMeta?.tools_used || [],
    files_modified: sessionMeta?.files_edited || [],
    files_created: [],
    steps: sessionMeta?.steps || sessionMeta?.total_steps || 0,
    final_response: finalResponse,
    exit_status: sessionMeta?.exit_status || "unknown",
  };

  // 估算 trajectory metrics
  const metrics: TrajectoryMetrics = {
    steps: output.steps,
    tool_calls: output.tools_called.length,
    unique_tools: [...new Set(output.tools_called)],
    error_count: 0, // 需要从 trajectory 详细分析
    retry_count: 0,
    backtrack_count: 0,
  };

  return { output, metrics };
}
