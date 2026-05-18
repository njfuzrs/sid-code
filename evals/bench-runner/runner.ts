/**
 * Phase 3 W7 / Phase 4 W9: bench-runner 主入口
 * 协调三层 Grader，跑 bench task 并输出评分
 *
 * W9 改动：runSingleTask 默认接 adapters/sid-code（离线模式），不再用 simulate。
 */

import {
  gradeOutcome,
  type TaskExpected,
  type AgentOutput,
  type GradeResult,
} from "./outcome-grader.ts";
import { gradeTrajectory, type TrajectoryMetrics } from "./trajectory-grader.ts";
import { gradeProcess, aggregateScores, type JudgeConfig, type JudgeInput } from "./process-grader.ts";
import { extractAgentOutput, type AdapterConfig } from "./adapters/sid-code.ts";
import { runSidCodeLive, type SidCodeLiveConfig } from "./adapters/sid-code-live.ts";
import { parse as parseYaml } from "yaml";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export type AdapterName = "sid-code-offline" | "sid-code-live" | "claude-code" | "codex" | "simulate";

export interface RunConfig {
  benchDir: string; // bench/tasks/ 目录
  splitFile?: string; // splits/smoke.txt 等
  judgeConfig: JudgeConfig;
  outputDir: string;
  skipLlmJudge?: boolean; // 跳过 Layer 3（省钱模式）
  adapter?: AdapterName; // 默认 sid-code-offline
  adapterConfig?: AdapterConfig; // 离线 adapter 需要 trajectoryDir / metaFile
  liveAdapterConfig?: SidCodeLiveConfig; // sid-code-live adapter 配置
}

export interface TaskResult {
  taskId: string;
  difficulty: string;
  tags: string[];
  primaryModel: string;
  scores: {
    outcome: number;
    trajectory: number;
    process: number;
    final: number;
  };
  details: {
    outcome: Record<string, boolean | number>;
    trajectory: Record<string, boolean | number>;
    process: Record<string, boolean | number | string>;
  };
  reasoning: string;
  agentSnapshot: {
    tools_called: string[];
    files_modified: string[];
    steps: number;
    exit_status: string;
  };
}

async function loadSplit(splitFile: string): Promise<string[]> {
  const content = await Bun.file(splitFile).text();
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

async function loadTask(taskDir: string): Promise<Record<string, unknown> | null> {
  const yamlPath = join(taskDir, "task.yaml");
  try {
    const content = await Bun.file(yamlPath).text();
    return parseYaml(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 回退路径：当 adapter 抽不到任何信号时（缺 meta / 缺 trajectory），
 * 用 task.yaml 的 expected 占位，保留可观测但不会反向污染评分。
 */
function fallbackAgentOutput(task: Record<string, unknown>): AgentOutput {
  const source = (task.source || {}) as Record<string, unknown>;
  const trajectories = (source.trajectory_sids || []) as Array<Record<string, unknown>>;
  const primary = trajectories.find((t) => t.role === "primary") || trajectories[0];

  return {
    tools_called: [],
    files_modified: [],
    files_created: [],
    steps: (primary?.steps as number) || (task.estimated_turns as number) || 0,
    final_response: "",
    exit_status: "fallback_missing_trajectory",
  };
}

async function runSingleTask(
  task: Record<string, unknown>,
  config: RunConfig,
): Promise<TaskResult> {
  const taskId = task.task_id as string;
  const difficulty = (task.difficulty as string) || "medium";
  const tags = (task.tags as string[]) || [];
  const expected = (task.expected || {}) as TaskExpected;
  const source = (task.source || {}) as Record<string, unknown>;
  const trajectorySids = (source.trajectory_sids || []) as Array<{
    sid: string;
    role: string;
    model?: string;
  }>;
  const primaryEntry =
    trajectorySids.find((t) => t.role === "primary") || trajectorySids[0];
  const primaryModel = primaryEntry?.model || "unknown";

  // ── Adapter 抽取 agent output ──
  let output: AgentOutput;
  let metrics: TrajectoryMetrics;

  const adapter = config.adapter || "sid-code-offline";
  if (adapter === "sid-code-offline" && config.adapterConfig) {
    const r = await extractAgentOutput(trajectorySids, config.adapterConfig);
    output = r.output;
    metrics = r.metrics;
    // 离线 adapter 拿不到信号时退化到 fallback（exit_status="unknown" + steps=0）
    if (output.steps === 0 && output.tools_called.length === 0) {
      output = fallbackAgentOutput(task);
      metrics = {
        steps: output.steps,
        tool_calls: 0,
        unique_tools: [],
        error_count: 0,
        retry_count: 0,
        backtrack_count: 0,
      };
    }
  } else if (adapter === "sid-code-live" && config.liveAdapterConfig) {
    const instructionText = ((task.instruction as Record<string, string>)?.text ||
      (task.instruction as unknown as string) ||
      "").slice(0, 4000);
    const r = await runSidCodeLive(instructionText, config.liveAdapterConfig);
    output = r.output;
    metrics = r.metrics;
  } else {
    // 占位：simulate 模式（仅本地 debug 用，正式 baseline 不应走这里）
    output = fallbackAgentOutput(task);
    metrics = {
      steps: output.steps,
      tool_calls: 0,
      unique_tools: [],
      error_count: 0,
      retry_count: 0,
      backtrack_count: 0,
    };
  }

  // Layer 1
  // W10.D2: bench v0.1 全量 task.max_steps 硬编码 45（数据 bug，详见 docs/eval/investigations/within-max-steps-w10.md）
  // fallback：当 yaml max_steps == 45 且 estimated_turns > 45 时，用 estimated_turns × 1.5（与 auto-extract.py 原始公式对齐）
  const effectiveMaxSteps = computeEffectiveMaxSteps({
    yamlMaxSteps: expected.max_steps,
    estimatedTurns: task.estimated_turns as number | undefined,
  });
  const outcomeResult = gradeOutcome(
    { ...expected, max_steps: effectiveMaxSteps },
    output,
  );

  // Layer 2
  const trajectoryResult = gradeTrajectory(metrics, {
    max_steps: expected.max_steps,
    estimated_turns: task.estimated_turns as number,
  });

  // Layer 3
  let processResult: GradeResult;
  if (config.skipLlmJudge) {
    processResult = {
      score: 3,
      layer: "process",
      details: { skipped: true },
      reasoning: "LLM Judge skipped (省钱模式)",
    };
  } else {
    const judgeInput: JudgeInput = {
      task: ((task.instruction as Record<string, string>)?.text || "").slice(0, 1000),
      expected,
      agentResponse: output.final_response,
    };
    processResult = await gradeProcess(judgeInput, config.judgeConfig);
  }

  const { finalScore } = aggregateScores(outcomeResult, trajectoryResult, processResult);

  return {
    taskId,
    difficulty,
    tags,
    primaryModel,
    scores: {
      outcome: outcomeResult.score,
      trajectory: trajectoryResult.score,
      process: processResult.score,
      final: finalScore,
    },
    details: {
      outcome: outcomeResult.details,
      trajectory: trajectoryResult.details,
      process: processResult.details,
    },
    reasoning: `L1:${outcomeResult.reasoning} | L2:${trajectoryResult.reasoning} | L3:${processResult.reasoning}`,
    agentSnapshot: {
      tools_called: output.tools_called,
      files_modified: output.files_modified,
      steps: output.steps,
      exit_status: output.exit_status,
    },
  };
}

export async function runBench(config: RunConfig): Promise<TaskResult[]> {
  let taskIds: string[];
  if (config.splitFile) {
    taskIds = await loadSplit(config.splitFile);
  } else {
    const entries = await readdir(config.benchDir);
    taskIds = entries.filter((e) => e.startsWith("T"));
  }

  console.log(`Running bench: ${taskIds.length} tasks (adapter=${config.adapter || "sid-code-offline"})`);
  const results: TaskResult[] = [];

  for (let i = 0; i < taskIds.length; i++) {
    const taskId = taskIds[i];
    const taskDir = join(config.benchDir, taskId);
    const task = await loadTask(taskDir);

    if (!task) {
      console.log(`  SKIP ${taskId}: task.yaml not found`);
      continue;
    }

    const result = await runSingleTask(task, config);
    results.push(result);

    if ((i + 1) % 10 === 0) {
      const avgScore = results.reduce((s, r) => s + r.scores.final, 0) / results.length;
      console.log(`  [${i + 1}/${taskIds.length}] avg_score=${avgScore.toFixed(2)}`);
    }
  }

  const avg = (fn: (r: TaskResult) => number) =>
    results.reduce((s, r) => s + fn(r), 0) / Math.max(results.length, 1);

  const avgFinal = avg((r) => r.scores.final);
  const avgOutcome = avg((r) => r.scores.outcome);
  const avgTrajectory = avg((r) => r.scores.trajectory);
  const avgProcess = avg((r) => r.scores.process);

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Bench Results: ${results.length} tasks`);
  console.log(`${"=".repeat(50)}`);
  console.log(`  Final Score: ${avgFinal.toFixed(2)}/5.0`);
  console.log(`  L1 Outcome:  ${avgOutcome.toFixed(2)}/5.0`);
  console.log(`  L2 Trajectory: ${avgTrajectory.toFixed(2)}/5.0`);
  console.log(`  L3 Process:  ${avgProcess.toFixed(2)}/5.0`);

  const byDifficulty: Record<string, TaskResult[]> = {};
  for (const r of results) {
    if (!byDifficulty[r.difficulty]) byDifficulty[r.difficulty] = [];
    byDifficulty[r.difficulty].push(r);
  }
  console.log(`\n  By difficulty:`);
  for (const [diff, tasks] of Object.entries(byDifficulty)) {
    const a = tasks.reduce((s, r) => s + r.scores.final, 0) / tasks.length;
    console.log(`    ${diff}: ${a.toFixed(2)} (n=${tasks.length})`);
  }

  const outputPath = join(config.outputDir, `bench-results-${Date.now()}.jsonl`);
  const outputContent = results.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await Bun.write(outputPath, outputContent);
  console.log(`\n  Results written to: ${outputPath}`);

  return results;
}

/**
 * 计算 effective max_steps（处理 bench v0.1 数据 bug）
 * 详见 docs/eval/investigations/within-max-steps-w10.md
 *
 * - 当 yaml max_steps == FROZEN_BAD_VALUE (45) 且 estimated_turns > 45 时，
 *   用 estimated_turns × 1.5（与 trajectory-platform/scripts/phase2/auto-extract.py 公式对齐）
 * - 其他情况：返回 yaml 值或默认 30
 *
 * 暴露给单元测试用
 */
export function computeEffectiveMaxSteps(o: {
  yamlMaxSteps?: number;
  estimatedTurns?: number;
}): number {
  const FROZEN_BAD_VALUE = 45;
  if (
    o.yamlMaxSteps === FROZEN_BAD_VALUE &&
    o.estimatedTurns &&
    o.estimatedTurns > FROZEN_BAD_VALUE
  ) {
    return Math.min(Math.ceil(o.estimatedTurns * 1.5), 500);
  }
  return o.yamlMaxSteps ?? 30;
}
