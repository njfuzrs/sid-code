/**
 * eval:plan-capability — 跑 Plan 子系统 capability eval（W11 入口）
 *
 * 用法：
 *   bun run eval:plan-capability -- --case plan_009       # 跑单条
 *   bun run eval:plan-capability -- --execute             # 跑全部 + 真调 LLM Judge
 *   bun run eval:plan-capability                          # 跑全部 + 跳过 LLM Judge (省钱模式)
 *
 * 必须依赖 sid-code-live adapter（ADR-016）。
 * 输出：
 *   evals/raw-outputs/capability-plan-<ts>.jsonl       — 每条 case 的详细评分
 *   evals/_reports/capability-plan-<ts>.json          — 4 维度汇总（供后续 capability-plan-w11.md 用）
 */

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import {
  runSidCodeLive,
  type SidCodeLiveConfig,
  type SidCodeLiveResult,
} from "../../evals/bench-runner/adapters/sid-code-live.ts";
import {
  runAllChecks,
  aggregateCapabilityScore,
  type CapabilityCaseExpected,
  type GraderRule,
  type CapabilityGraderInput,
} from "../../evals/bench-runner/capability-grader.ts";
import { gradeProcess, type JudgeConfig } from "../../evals/bench-runner/process-grader.ts";

const ROOT = process.cwd();
const CAPABILITY_DIR = join(ROOT, "evals/capability/plan");
const RAW_DIR = join(ROOT, "evals/raw-outputs");
const REPORT_DIR = join(ROOT, "evals/_reports");

const { values } = parseArgs({
  options: {
    case: { type: "string" }, // 只跑指定 case（e.g. plan_009）
    execute: { type: "boolean", default: false }, // 真调 LLM Judge
    timeout: { type: "string", default: "360000" }, // 单 task 超时
    model: { type: "string" }, // 覆盖默认模型
  },
  allowPositionals: true,
});

mkdirSync(RAW_DIR, { recursive: true });
mkdirSync(REPORT_DIR, { recursive: true });

interface CapabilityCase {
  id: string;
  subsystem: string;
  dimension: string;
  priority: string;
  input: {
    user_query: string;
    trigger_plan_mode?: boolean;
    mock_environment?: Record<string, unknown>;
  };
  expected: CapabilityCaseExpected;
  rubric?: Record<string, string>;
  grader: GraderRule[];
  related_adr?: string[];
}

/** 加载所有 plan_NNN_*.yaml */
function loadCases(caseFilter?: string): CapabilityCase[] {
  const files = readdirSync(CAPABILITY_DIR)
    .filter((f) => f.startsWith("plan_") && f.endsWith(".yaml"))
    .sort();
  const cases: CapabilityCase[] = [];
  for (const f of files) {
    const raw = readFileSync(join(CAPABILITY_DIR, f), "utf-8");
    const parsed = parseYaml(raw) as CapabilityCase;
    if (caseFilter && parsed.id !== caseFilter) continue;
    cases.push(parsed);
  }
  return cases;
}

/**
 * 构造给 sid-code 的 instruction
 * 把 trigger_plan_mode 和 mock_environment 拼到指令里
 */
function buildInstruction(c: CapabilityCase): { instruction: string; appendSystemPrompt: string } {
  let instruction = c.input.user_query.trim();

  if (c.input.trigger_plan_mode) {
    instruction = `[请进入 Plan Mode，先写计划再执行]\n\n${instruction}`;
  }

  // mock_environment → 注入到 system prompt
  let appendSystemPrompt = "";
  const mock = c.input.mock_environment as
    | {
        permission_denials?: Array<{ tool: string; file_pattern: string; reason: string }>;
        file_not_found?: string[];
      }
    | undefined;
  if (mock) {
    const lines: string[] = ["[评测注入]：本次会话中以下条件被模拟为失败，请按指令处理失败"];
    if (mock.permission_denials) {
      for (const p of mock.permission_denials) {
        lines.push(`- 使用 ${p.tool} 工具写入 ${p.file_pattern} 时，会返回错误："${p.reason}"`);
      }
    }
    if (mock.file_not_found) {
      for (const f of mock.file_not_found) {
        lines.push(`- 读取 ${f} 会返回 "file not found"`);
      }
    }
    appendSystemPrompt = lines.join("\n");
  }

  return { instruction, appendSystemPrompt };
}

/**
 * 推算 plan 文件 update 次数（recovery 维度专属）
 *
 * W12.D3 改动：从 adapter 暴露的 planFileUpdateCount（trajectory 真命中）取真值
 * 旧版（W11.D2 粗估）：数 tools_called 内的所有 write/edit，无法区分写的是不是 plan 文件
 *
 * 兜底：如果 trajectory 缺失（adapter 未读到 session.traj）但 planFilePath 存在
 *      （plan 文件已落盘但 trace 失败），按 1 算（plan 文件确实被写过 1 次）
 */
function planUpdateCountFromAdapter(liveResult: SidCodeLiveResult): number {
  if (liveResult.planFileUpdateCount > 0) return liveResult.planFileUpdateCount;
  // tracker miss 兜底：plan 文件存在则至少有过一次 write
  return liveResult.planFilePath ? 1 : 0;
}

const judgeConfig: JudgeConfig = {
  apiKey: process.env.ANTHROPIC_API_KEY || "",
  baseUrl: (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com") + "/v1",
  model: process.env.JUDGE_MODEL || "claude-sonnet-4-6",
  promptPath: join(ROOT, "evals/_judge/prompt-v2.md"),
};

const liveConfig: SidCodeLiveConfig = {
  cwd: ROOT,
  // 不强制要求 ANTHROPIC_API_KEY：让 sid-code 子进程读 ~/.sid-code/config.yaml 的 anthropic_key
  // 也不透传 baseUrl：避免 LLM_BASE_URL 覆盖 config.yaml 里的 dashscope/openai base_url
  // model 可选：未传则用用户 ~/.sid-code/config.yaml 默认
  model: values.model || process.env.SID_CODE_MODEL,
  timeoutMs: parseInt(values.timeout || "360000", 10),
};

const cases = loadCases(values.case);
if (cases.length === 0) {
  console.error(`✗ 未找到 capability case${values.case ? ` (filter=${values.case})` : ""}`);
  process.exit(1);
}

console.log(`Mode      : ${values.execute ? "execute (真调 LLM Judge)" : "skip-llm-judge (省钱模式)"}`);
console.log(`Adapter   : sid-code-live`);
console.log(`Model     : ${liveConfig.model || "(用户 config 默认)"}`);
console.log(`Timeout   : ${liveConfig.timeoutMs}ms`);
console.log(`Cases     : ${cases.length} 条 (${cases.map((c) => c.id).join(", ")})`);
console.log("");

const ts = Date.now();
const rawOutputPath = join(RAW_DIR, `capability-plan-${ts}.jsonl`);
const reportOutputPath = join(REPORT_DIR, `capability-plan-${ts}.json`);

interface CaseResult {
  id: string;
  dimension: string;
  priority: string;
  finalScore: number;
  assertScore: number;
  llmScore: number | null;
  details: Record<string, string | number | boolean>;
  agentSnapshot: {
    tools_called: string[];
    steps: number;
    exit_status: string;
    timed_out: boolean;
    session_dir: string | null;
    plan_file: string | null;
  };
  reasoning: string;
}

const results: CaseResult[] = [];

for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  console.log(`[${i + 1}/${cases.length}] ${c.id} (${c.dimension}) — 启动 sid-code-live ...`);

  const { instruction, appendSystemPrompt } = buildInstruction(c);
  const startedAt = Date.now();
  const live = await runSidCodeLive(instruction, {
    ...liveConfig,
    appendSystemPrompt: appendSystemPrompt || undefined,
    // Plan mode 维度 → 强制 plan permission mode
    permissionMode: c.input.trigger_plan_mode ? "plan" : undefined,
  });
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  // 读 plan 文件内容
  let planContent = "";
  if (live.planFilePath) {
    try {
      planContent = readFileSync(live.planFilePath, "utf-8");
    } catch {
      planContent = "";
    }
  }

  const planUpdateCount = planUpdateCountFromAdapter(live);

  const graderInput: CapabilityGraderInput = {
    expected: c.expected,
    planContent,
    toolsCalled: live.output.tools_called,
    steps: live.output.steps,
    finalResponse: live.output.final_response,
    planUpdateCount,
  };

  const { assertResults, llmRule } = runAllChecks(c.grader, graderInput);

  // LLM Judge（execute 模式下）
  let llmScore: number | undefined;
  if (values.execute && llmRule && judgeConfig.apiKey) {
    const judgeInput = {
      task: instruction.slice(0, 1500),
      expected: {
        ...c.expected,
        // capability 没有 must_include_keywords，借 plan_must_cover 字段塞
        must_include_keywords: c.expected.plan_must_cover_any_of,
        must_call_tools: c.expected.execution_must_call_tools_any_of,
        max_steps: c.expected.max_steps,
      },
      agentResponse: planContent || live.output.final_response,
    };
    const judgeResult = await gradeProcess(judgeInput, judgeConfig);
    llmScore = judgeResult.score;
  }

  const agg = aggregateCapabilityScore({
    assertResults,
    llmJudgeScore: llmScore,
    llmJudgeWeight: llmRule?.weight,
  });

  const checkSummary = assertResults
    .map((r) => `${r.check}=${r.passed ? "✓" : "✗"}`)
    .join(" / ");

  const result: CaseResult = {
    id: c.id,
    dimension: c.dimension,
    priority: c.priority,
    finalScore: agg.score,
    assertScore: agg.assertScore,
    llmScore: agg.llmScore,
    details: agg.details,
    agentSnapshot: {
      tools_called: live.output.tools_called,
      steps: live.output.steps,
      exit_status: live.output.exit_status,
      timed_out: live.timedOut,
      session_dir: live.sessionDir,
      plan_file: live.planFilePath,
    },
    reasoning: `${elapsed}s, ${checkSummary}${llmScore != null ? `, judge=${llmScore}` : ""}`,
  };
  // 把 stdout/stderr 摘要也写进 raw（≤ 500 chars 各，便于排错）
  (result as unknown as { _stdout: string })._stdout = live.stdout.slice(-1500);
  (result as unknown as { _stderr: string })._stderr = live.stderr.slice(-1500);
  results.push(result);

  console.log(
    `    → score=${result.finalScore}/5 (assert=${result.assertScore}${llmScore != null ? `, judge=${llmScore}` : ""}) | ${elapsed}s | ${result.agentSnapshot.exit_status}`,
  );
  if (live.timedOut) {
    console.log(`    ⚠️  timeout`);
  }
}

// 写 raw outputs
const rawContent = results.map((r) => JSON.stringify(r)).join("\n") + "\n";
await Bun.write(rawOutputPath, rawContent);

// 按 dimension 聚合
const byDimension: Record<string, CaseResult[]> = {};
for (const r of results) {
  if (!byDimension[r.dimension]) byDimension[r.dimension] = [];
  byDimension[r.dimension].push(r);
}

const dimensionSummary: Record<string, { avgScore: number; count: number; passRate: number }> = {};
for (const [dim, list] of Object.entries(byDimension)) {
  const avg = list.reduce((s, r) => s + r.finalScore, 0) / list.length;
  const passed = list.filter((r) => r.finalScore >= 4.0).length;
  dimensionSummary[dim] = {
    avgScore: Math.round(avg * 100) / 100,
    count: list.length,
    passRate: Math.round((passed / list.length) * 100) / 100,
  };
}

const overall = {
  total: results.length,
  avgScore: Math.round((results.reduce((s, r) => s + r.finalScore, 0) / results.length) * 100) / 100,
  passRate:
    Math.round((results.filter((r) => r.finalScore >= 4.0).length / results.length) * 100) / 100,
};

await Bun.write(
  reportOutputPath,
  JSON.stringify(
    {
      timestamp: ts,
      mode: values.execute ? "execute" : "skip-llm-judge",
      model: liveConfig.model,
      overall,
      by_dimension: dimensionSummary,
      cases: results.map((r) => ({
        id: r.id,
        dimension: r.dimension,
        score: r.finalScore,
        assert: r.assertScore,
        judge: r.llmScore,
        timed_out: r.agentSnapshot.timed_out,
      })),
    },
    null,
    2,
  ),
);

console.log("\n" + "=".repeat(60));
console.log(`Plan capability eval done`);
console.log("=".repeat(60));
console.log(`  Total: ${overall.total} | avg=${overall.avgScore}/5 | pass=${(overall.passRate * 100).toFixed(0)}%`);
console.log(`  By dimension:`);
for (const [dim, s] of Object.entries(dimensionSummary)) {
  console.log(`    ${dim.padEnd(28)} avg=${s.avgScore} pass=${(s.passRate * 100).toFixed(0)}% (n=${s.count})`);
}
console.log(`\n  Raw  → ${rawOutputPath}`);
console.log(`  Report → ${reportOutputPath}`);
