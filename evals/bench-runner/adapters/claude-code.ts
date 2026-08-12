/**
 * Phase 3 W8 → W12: Adapter — claude-code
 * 通过 `claude` CLI 实时跑 task，解析 JSON 输出
 */

import type { AgentOutput } from "../outcome-grader.ts";
import type { TrajectoryMetrics } from "../trajectory-grader.ts";

export interface ClaudeCodeConfig {
  cliPath: string;
  model: string;
  timeoutMs: number;
  skipPermissions: boolean;
  maxTurns?: number;
}

export interface ClaudeCodeResult {
  output: AgentOutput;
  metrics: TrajectoryMetrics;
  rawJson: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  costUsd: number;
}

/**
 * 调用 claude CLI 跑单条 task
 * 命令: claude -p --output-format json [--model X] [--dangerously-skip-permissions] "instruction"
 */
export async function runClaudeCode(
  instruction: string,
  config: ClaudeCodeConfig,
): Promise<ClaudeCodeResult> {
  const args: string[] = ["-p", "--output-format", "json"];

  if (config.model) {
    args.push("--model", config.model);
  }
  if (config.skipPermissions) {
    args.push("--dangerously-skip-permissions");
  }
  if (config.maxTurns) {
    args.push("--max-turns", String(config.maxTurns));
  }
  args.push(instruction);

  const cliPath = config.cliPath || "claude";
  const proc = Bun.spawn([cliPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }, 3000);
  }, config.timeoutMs);

  const stdoutBuf = await new Response(proc.stdout).text();
  const stderrBuf = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  clearTimeout(timer);

  // 解析 JSON 输出
  let rawJson: Record<string, unknown> | null = null;
  let result = "";
  let numTurns = 0;
  let costUsd = 0;

  try {
    // claude CLI --output-format json 输出一个 JSON 对象
    const jsonStr = stdoutBuf.trim();
    if (jsonStr.startsWith("{")) {
      rawJson = JSON.parse(jsonStr);
      result = extractResult(rawJson);
      numTurns = (rawJson.num_turns as number) || 0;
      costUsd = (rawJson.total_cost_usd as number) || 0;
    } else if (jsonStr.startsWith("[")) {
      // 有时输出是 JSON 数组（多条消息）
      const arr = JSON.parse(jsonStr) as Array<Record<string, unknown>>;
      rawJson = arr[arr.length - 1] || null;
      result = arr
        .map((m) => extractResult(m))
        .filter(Boolean)
        .join("\n");
      numTurns = arr.length;
    }
  } catch {
    // JSON 解析失败，用原始 stdout 作为 final_response
    result = stdoutBuf.slice(0, 5000);
  }

  // 从 JSON 中提取工具调用信息
  const toolsCalled = rawJson ? extractToolsCalled(rawJson) : [];
  const filesModified = rawJson ? extractFilesModified(rawJson) : [];

  const output: AgentOutput = {
    tools_called: toolsCalled,
    files_modified: filesModified,
    files_created: [],
    steps: numTurns,
    final_response: result,
    exit_status: timedOut ? "timeout" : exitCode === 0 ? "end_turn" : "error",
  };

  const metrics: TrajectoryMetrics = {
    steps: numTurns,
    tool_calls: toolsCalled.length,
    unique_tools: [...new Set(toolsCalled)],
    error_count: timedOut ? 1 : exitCode !== 0 ? 1 : 0,
    retry_count: 0,
    backtrack_count: 0,
  };

  return {
    output,
    metrics,
    rawJson,
    stdout: stdoutBuf,
    stderr: stderrBuf,
    exitCode,
    timedOut,
    costUsd,
  };
}

function extractResult(obj: Record<string, unknown> | null): string {
  if (!obj) return "";
  // claude CLI JSON 输出格式: { result: "...", ... }
  if (typeof obj.result === "string") return obj.result;
  // 或者 content 数组
  if (Array.isArray(obj.content)) {
    return obj.content
      .filter((c: { type?: string; text?: string }) => c.type === "text")
      .map((c: { text?: string }) => c.text || "")
      .join("\n");
  }
  return "";
}

function extractToolsCalled(obj: Record<string, unknown> | null): string[] {
  if (!obj) return [];
  // claude CLI 不直接暴露 tools_called，但 num_turns 可用
  // 如果有 tool_uses 字段（某些版本）
  if (Array.isArray(obj.tool_uses)) {
    return (obj.tool_uses as Array<{ tool_name?: string }>).map((t) => t.tool_name || "unknown");
  }
  return [];
}

function extractFilesModified(obj: Record<string, unknown> | null): string[] {
  if (!obj) return [];
  if (Array.isArray(obj.files_modified)) {
    return obj.files_modified as string[];
  }
  return [];
}
