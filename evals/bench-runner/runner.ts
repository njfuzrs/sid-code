/**
 * Phase 3 W7: bench-runner 主入口
 * 协调三层 Grader，跑 bench task 并输出评分
 */

import { gradeOutcome, type TaskExpected, type AgentOutput } from "./outcome-grader.ts";
import { gradeTrajectory, type TrajectoryMetrics } from "./trajectory-grader.ts";
import { gradeProcess, aggregateScores, type JudgeConfig, type JudgeInput } from "./process-grader.ts";
import { parse as parseYaml } from "yaml";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export interface RunConfig {
  benchDir: string; // bench/tasks/ 目录
  splitFile?: string; // splits/smoke.txt 等
  judgeConfig: JudgeConfig;
  outputDir: string;
  skipLlmJudge?: boolean; // 跳过 Layer 3（省钱模式）
}

export interface TaskResult {
  taskId: string;
  difficulty: string;
  scores: {
    outcome: number;
    trajectory: number;
    process: number;
    final: number;
  };
  details: {
    outcome: Record<string, boolean | number>;
    trajectory: Record<string, boolean | number>;
  };
  reasoning: string;
}

/**
 * 加载 split 文件中的 task_id 列表
 */
async function loadSplit(splitFile: string): Promise<string[]> {
  const content = await Bun.file(splitFile).text();
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * 加载单个 task.yaml
 */
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
 * 模拟 agent 输出（从已有 trajectory 提取）
 * 实际使用时会被 adapter 替换
 */
function simulateAgentOutput(task: Record<string, unknown>): AgentOutput {
  const expected = (task.expected || {}) as TaskExpected;
  const source = (task.source || {}) as Record<string, unknown>;
  const trajectories = (source.trajectory_sids || []) as Array<Record<string, unknown>>;
  const primary = trajectories.find((t) => t.role === "primary") || trajectories[0];

  return {
    tools_called: expected.must_call_tools || [],
    files_modified: expected.must_modify_files_in || [],
    files_created: expected.must_create_files || [],
    steps: (primary?.steps as number) || (task.estimated_turns as number) || 10,
    final_response: ((task.instruction as Record<string, string>)?.text || "").slice(0, 500),
    exit_status: "end_turn",
  };
}

/**
 * 从 task 数据构造 trajectory metrics
 */
function extractTrajectoryMetrics(task: Record<string, unknown>, output: AgentOutput): TrajectoryMetrics {
  return {
    steps: output.steps,
    tool_calls: output.tools_called.length,
    unique_tools: [...new Set(output.tools_called)],
    error_count: 0,
    retry_count: 0,
    backtrack_count: 0,
  };
}

/**
 * 跑单条 task 的三层评分
 */
async function runSingleTask(
  task: Record<string, unknown>,
  config: RunConfig,
): Promise<TaskResult> {
  const taskId = task.task_id as string;
  const difficulty = (task.difficulty as string) || "medium";
  const expected = (task.expected || {}) as TaskExpected;

  // 模拟 agent 输出（后续会被真实 adapter 替换）
  const output = simulateAgentOutput(task);

  // Layer 1: Outcome
  const outcomeResult = gradeOutcome(expected, output);

  // Layer 2: Trajectory
  const metrics = extractTrajectoryMetrics(task, output);
  const trajectoryResult = gradeTrajectory(metrics, {
    max_steps: expected.max_steps,
    estimated_turns: task.estimated_turns as number,
  });

  // Layer 3: Process (LLM Judge)
  let processResult;
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

  // 聚合
  const { finalScore, breakdown } = aggregateScores(outcomeResult, trajectoryResult, processResult);

  return {
    taskId,
    difficulty,
    scores: {
      outcome: outcomeResult.score,
      trajectory: trajectoryResult.score,
      process: processResult.score,
      final: finalScore,
    },
    details: {
      outcome: outcomeResult.details,
      trajectory: trajectoryResult.details,
    },
    reasoning: `L1:${outcomeResult.reasoning} | L2:${trajectoryResult.reasoning} | L3:${processResult.reasoning}`,
  };
}

/**
 * 主入口：跑 bench
 */
export async function runBench(config: RunConfig): Promise<TaskResult[]> {
  // 确定要跑的 task 列表
  let taskIds: string[];
  if (config.splitFile) {
    taskIds = await loadSplit(config.splitFile);
  } else {
    const entries = await readdir(config.benchDir);
    taskIds = entries.filter((e) => e.startsWith("T"));
  }

  console.log(`Running bench: ${taskIds.length} tasks`);
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

  // 输出汇总
  const avgFinal = results.reduce((s, r) => s + r.scores.final, 0) / results.length;
  const avgOutcome = results.reduce((s, r) => s + r.scores.outcome, 0) / results.length;
  const avgTrajectory = results.reduce((s, r) => s + r.scores.trajectory, 0) / results.length;
  const avgProcess = results.reduce((s, r) => s + r.scores.process, 0) / results.length;

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Bench Results: ${results.length} tasks`);
  console.log(`${"=".repeat(50)}`);
  console.log(`  Final Score: ${avgFinal.toFixed(2)}/5.0`);
  console.log(`  L1 Outcome:  ${avgOutcome.toFixed(2)}/5.0`);
  console.log(`  L2 Trajectory: ${avgTrajectory.toFixed(2)}/5.0`);
  console.log(`  L3 Process:  ${avgProcess.toFixed(2)}/5.0`);

  // 按难度分桶
  const byDifficulty: Record<string, TaskResult[]> = {};
  for (const r of results) {
    if (!byDifficulty[r.difficulty]) byDifficulty[r.difficulty] = [];
    byDifficulty[r.difficulty].push(r);
  }
  console.log(`\n  By difficulty:`);
  for (const [diff, tasks] of Object.entries(byDifficulty)) {
    const avg = tasks.reduce((s, r) => s + r.scores.final, 0) / tasks.length;
    console.log(`    ${diff}: ${avg.toFixed(2)} (n=${tasks.length})`);
  }

  // 写结果文件
  const outputPath = join(config.outputDir, `bench-results-${Date.now()}.jsonl`);
  const outputContent = results.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await Bun.write(outputPath, outputContent);
  console.log(`\n  Results written to: ${outputPath}`);

  return results;
}
