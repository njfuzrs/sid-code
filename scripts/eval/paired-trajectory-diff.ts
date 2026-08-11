#!/usr/bin/env bun
/**
 * paired-trajectory-diff.ts — B0-2 MVP-T02
 *
 * 用法：
 *   bun run scripts/eval/paired-trajectory-diff.ts T0002 [...task_ids]
 *
 * 输入：
 *   - trajectory-platform/bench/tasks/<task_id>/task.yaml（task 描述 + primary sid）
 *   - trajectory-platform/data/pulled_sessions/<primary_sid>/session.traj（claude 参考轨迹）
 *   - 当前 sid-code 跑同一条 instruction 的轨迹（由 sid-code-live wrapper 实时跑）
 *
 * 输出：
 *   - _reports/sid-vs-claude/diff-<task_id>.json（结构化 diff）
 *   - 每条 task 一份独立 JSON
 *
 * 不依赖 ADR-032 / ADR-033，纯外挂脚本，符合 §0.3 infra_bug L1 自动执行。
 *
 * 设计原则（§13.8 MVP-T02）：
 *   - 只读 trajectory-platform，不修改其数据
 *   - sid-code 用 sid-code-live wrapper 实时跑，避免 mock
 *   - LLM judge 用 Claude（与 eval-judge 同源），temperature=0
 *   - JSON schema 严格约束输出，便于聚合
 */

import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import yaml from "yaml";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const TRAJ_PLATFORM = resolve(REPO_ROOT, "../trajectory-platform");
const REPORTS_DIR = join(REPO_ROOT, "_reports/sid-vs-claude");

// Compact step extracted from session.traj
interface CompactStep {
  step_index: number;
  agent: "primary" | "comparison" | string;
  message_type: "action" | "observation" | "thought" | string;
  tool_name?: string;
  tool_input_brief?: string; // 截断 200 字符
  thought_brief?: string;
  is_error?: boolean;
}

interface PairedDiff {
  task_id: string;
  task_summary: string;
  task_difficulty: string;
  step_diff: { sid: number; claude: number; ratio: number };
  tool_choice_divergence: Array<{
    step: string;
    sid_used: string;
    claude_used: string;
    verdict: string;
  }>;
  failure_modes: Array<{
    code: string; // e.g. "TS-01" / "EX-02"
    title: string;
    evidence: string;
    severity: "high" | "medium" | "low";
  }>;
  fix_suggestions: Array<{
    type: "skill_rule" | "tool_routing" | "prompt_template" | "infra";
    target: string; // e.g. "packages/core/src/skill/builtin/code-review/SKILL.md"
    content: string;
  }>;
  meta: {
    sid_steps: number;
    claude_steps: number;
    sid_tools: string[];
    claude_tools: string[];
    sid_status: "ok" | "abnormal" | "timeout";
    sid_abnormal_reason?: string;
    judged_at: string;
    judge_model: string;
  };
}

const JUDGE_MODEL = process.env.PAIRED_DIFF_MODEL ?? "claude-opus-4-7";

const PROMPT_TEMPLATE = `你是资深 agent 行为分析师。给定下面两条轨迹做对比分析：

# Task
{task_id}: {task_summary}
难度：{difficulty}
预估步数（reference）：{estimated_turns}

# 轨迹 A（sid-code，被测）
状态：{sid_status}
共 {sid_steps} 步，使用工具：{sid_tools}

\`\`\`
{sid_trace}
\`\`\`

# 轨迹 B（claude-code primary，参考）
共 {claude_steps} 步，使用工具：{claude_tools}

\`\`\`
{claude_trace}
\`\`\`

# 你的任务
请输出严格 JSON（无 markdown 包裹），按以下 schema：

{
  "task_summary": "<重述 task 一句话，<=80 字>",
  "tool_choice_divergence": [
    { "step": "<场景>", "sid_used": "<工具>", "claude_used": "<工具>", "verdict": "<谁更高效及理由 <=60 字>" }
  ],
  "failure_modes": [
    {
      "code": "<分类编码，如 TS-01 / EX-02 / CTX-03 / TOOL-04>",
      "title": "<8-16 字标题>",
      "evidence": "<具体证据，引用 step 编号 <=120 字>",
      "severity": "high" | "medium" | "low"
    }
  ],
  "fix_suggestions": [
    {
      "type": "skill_rule" | "tool_routing" | "prompt_template" | "infra",
      "target": "<受影响的具体文件路径或模块>",
      "content": "<修复建议 <=200 字>"
    }
  ]
}

# 失败模式分类编码（强约束，禁止自创）
- TS-xx：工具选择（grep vs LSP / Read vs Bash cat / 等）
- EX-xx：探索策略（盲读 vs 索引、深度 vs 宽度）
- CTX-xx：上下文管理（重复读、漏读、读错）
- TOOL-xx：工具调用错误（参数错、滥用、漏调）
- LOOP-xx：循环 / 重试 / 验证策略
- ABORT-xx：中断 / 异常 / 超时处理
- OUT-xx：输出质量（格式、完整度、解释）

# 严格约束
1. 只能基于轨迹证据，不要凭空发挥
2. 如果 sid 中断（abnormal），重点诊断中断原因，code = ABORT-*
3. 如果 sid 与 claude 表现等价，failure_modes 可为空数组
4. 只输出 JSON，禁止包裹 \`\`\`json
5. 所有字符串值禁止换行（影响 JSON parse）
`;

function readTaskYaml(taskId: string): {
  instruction: string;
  primary_sid: string | null;
  difficulty: string;
  estimated_turns: number;
} {
  const yamlPath = join(TRAJ_PLATFORM, "bench/tasks", taskId, "task.yaml");
  if (!existsSync(yamlPath)) throw new Error(`task.yaml 不存在：${yamlPath}`);
  const doc = yaml.parse(readFileSync(yamlPath, "utf-8")) as any;
  const sids: Array<{ sid: string; role: string; model: string; steps?: number }> =
    doc?.source?.trajectory_sids ?? [];
  const primary = sids.find((s) => s.role === "primary") ?? sids[0];
  return {
    instruction: String(doc?.instruction?.text ?? ""),
    primary_sid: primary?.sid ?? null,
    difficulty: String(doc?.difficulty ?? "unknown"),
    estimated_turns: Number(doc?.estimated_turns ?? 0),
  };
}

function readClaudeTrajectory(sid: string): { steps: CompactStep[]; tools: string[] } {
  const trajPath = join(TRAJ_PLATFORM, "data/pulled_sessions", sid, "session.traj");
  if (!existsSync(trajPath)) {
    return { steps: [], tools: [] };
  }
  const doc = JSON.parse(readFileSync(trajPath, "utf-8")) as { trajectory?: any[] };
  const arr = doc?.trajectory ?? [];
  const tools = new Set<string>();
  const steps: CompactStep[] = arr.map((t: any, i: number) => {
    if (t.tool_name) tools.add(t.tool_name);
    return {
      step_index: i,
      agent: t.agent ?? "unknown",
      message_type: t.message_type ?? "unknown",
      tool_name: t.tool_name,
      tool_input_brief: t.tool_input
        ? JSON.stringify(t.tool_input).slice(0, 200)
        : undefined,
      thought_brief: t.thought ? String(t.thought).slice(0, 200) : undefined,
      is_error: !!t.is_error,
    };
  });
  return { steps, tools: [...tools] };
}

interface SidRunResult {
  output: string;
  steps: CompactStep[];
  tools: string[];
  status: "ok" | "abnormal" | "timeout";
  abnormalReason?: string;
}

async function runSidCode(taskId: string, instruction: string): Promise<SidRunResult> {
  const wrapper = join(REPO_ROOT, "evals/providers/sid-code-live.ts");
  return new Promise((resolveP) => {
    const child = spawn(
      "bun",
      [
        wrapper,
        "--prompt",
        instruction,
        "--case-id",
        `paired_${taskId}`,
        "--timeout",
        "240000",
      ],
      { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 270_000);
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("close", () => {
      clearTimeout(t);
      try {
        const j = JSON.parse(stdout.trim());
        // wrapper 输出 schema：{ output, meta: { session_id, trajectory_path, tools_used, total_steps, exit_status }, error?: bool }
        const meta = j.meta ?? {};
        const wrapperError = j.error === true;
        const exitStatus: string = String(meta.exit_status ?? "");
        const status: SidRunResult["status"] = wrapperError
          ? "abnormal"
          : exitStatus === "timeout" || timedOut
            ? "timeout"
            : exitStatus === "abnormal_stdout"
              ? "abnormal"
              : "ok";
        const trajPath: string | null = meta.trajectory_path ?? null;
        let steps: CompactStep[] = [];
        const tools = new Set<string>();
        if (trajPath && existsSync(trajPath)) {
          const trj = JSON.parse(readFileSync(trajPath, "utf-8")) as { trajectory?: any[] };
          const arr = trj?.trajectory ?? [];
          steps = arr.map((t: any, i: number) => {
            if (t.tool_name) tools.add(t.tool_name);
            return {
              step_index: i,
              agent: t.agent ?? "unknown",
              message_type: t.message_type ?? "unknown",
              tool_name: t.tool_name,
              tool_input_brief: t.tool_input
                ? JSON.stringify(t.tool_input).slice(0, 200)
                : undefined,
              thought_brief: t.thought ? String(t.thought).slice(0, 200) : undefined,
              is_error: !!t.is_error,
            };
          });
        }
        resolveP({
          output: String(j.output ?? j.text ?? "").slice(0, 8000),
          steps,
          tools: [...tools],
          status,
          abnormalReason: wrapperError
            ? String(j.output ?? "").slice(0, 200)
            : undefined,
        });
      } catch (e) {
        resolveP({
          output: stdout.slice(0, 4000),
          steps: [],
          tools: [],
          status: "abnormal",
          abnormalReason: `wrapper stdout 非 JSON: ${(e as Error).message}; stderr: ${stderr.slice(0, 500)}`,
        });
      }
    });
  });
}

function compactTraceForPrompt(steps: CompactStep[], maxSteps = 40): string {
  // 仅保留 action + observation 摘要，避免 prompt 爆炸
  const trimmed = steps.slice(0, maxSteps);
  return trimmed
    .map((s) => {
      const tag =
        s.message_type === "action" ? "→" : s.message_type === "observation" ? "←" : "·";
      const tool = s.tool_name ? `[${s.tool_name}]` : "";
      const brief =
        s.message_type === "action"
          ? s.tool_input_brief ?? s.thought_brief ?? ""
          : s.is_error
            ? "(error result)"
            : "(ok result)";
      return `${s.step_index} ${tag}${tool} ${brief}`;
    })
    .join("\n");
}

async function judgeDiff(
  taskId: string,
  meta: {
    instruction: string;
    difficulty: string;
    estimated_turns: number;
    sid: SidRunResult;
    claude: { steps: CompactStep[]; tools: string[] };
  },
): Promise<PairedDiff> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY 未设置");
  const client = new Anthropic({ apiKey });

  const prompt = PROMPT_TEMPLATE.replace("{task_id}", taskId)
    .replace("{task_summary}", meta.instruction.slice(0, 400).replace(/\s+/g, " "))
    .replace("{difficulty}", meta.difficulty)
    .replace("{estimated_turns}", String(meta.estimated_turns))
    .replace("{sid_status}", `${meta.sid.status}${meta.sid.abnormalReason ? `（${meta.sid.abnormalReason.slice(0, 120)}）` : ""}`)
    .replace("{sid_steps}", String(meta.sid.steps.length))
    .replace("{sid_tools}", meta.sid.tools.join(",") || "(none)")
    .replace("{sid_trace}", compactTraceForPrompt(meta.sid.steps))
    .replace("{claude_steps}", String(meta.claude.steps.length))
    .replace("{claude_tools}", meta.claude.tools.join(",") || "(none)")
    .replace("{claude_trace}", compactTraceForPrompt(meta.claude.steps));

  const resp = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 3000,
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });
  const txt = resp.content
    .filter((c) => c.type === "text")
    .map((c) => (c as any).text)
    .join("");
  let parsed: any;
  try {
    const jsonMatch = txt.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : txt);
  } catch (e) {
    parsed = {
      task_summary: meta.instruction.slice(0, 80),
      tool_choice_divergence: [],
      failure_modes: [
        {
          code: "OUT-99",
          title: "judge JSON parse 失败",
          evidence: `model=${JUDGE_MODEL}; raw head: ${txt.slice(0, 200)}`,
          severity: "low",
        },
      ],
      fix_suggestions: [],
    };
  }

  const sidSteps = meta.sid.steps.length;
  const claudeSteps = meta.claude.steps.length;
  return {
    task_id: taskId,
    task_summary: parsed.task_summary ?? meta.instruction.slice(0, 80),
    task_difficulty: meta.difficulty,
    step_diff: {
      sid: sidSteps,
      claude: claudeSteps,
      ratio: claudeSteps > 0 ? Math.round((sidSteps / claudeSteps) * 100) / 100 : 0,
    },
    tool_choice_divergence: parsed.tool_choice_divergence ?? [],
    failure_modes: parsed.failure_modes ?? [],
    fix_suggestions: parsed.fix_suggestions ?? [],
    meta: {
      sid_steps: sidSteps,
      claude_steps: claudeSteps,
      sid_tools: meta.sid.tools,
      claude_tools: meta.claude.tools,
      sid_status: meta.sid.status,
      sid_abnormal_reason: meta.sid.abnormalReason,
      judged_at: new Date().toISOString(),
      judge_model: JUDGE_MODEL,
    },
  };
}

async function processOne(taskId: string): Promise<PairedDiff | null> {
  console.log(`\n[paired-diff] === ${taskId} ===`);
  const yamlInfo = readTaskYaml(taskId);
  if (!yamlInfo.primary_sid) {
    console.error(`[paired-diff] ${taskId} 无 primary sid，跳过`);
    return null;
  }
  if (!yamlInfo.instruction) {
    console.error(`[paired-diff] ${taskId} instruction 为空，跳过`);
    return null;
  }
  console.log(`[paired-diff] instruction: ${yamlInfo.instruction.slice(0, 80).replace(/\s+/g, " ")}...`);
  const claude = readClaudeTrajectory(yamlInfo.primary_sid);
  console.log(`[paired-diff] claude: ${claude.steps.length} steps / tools=${claude.tools.join(",")}`);

  console.log(`[paired-diff] running sid-code (timeout 270s)...`);
  const sid = await runSidCode(taskId, yamlInfo.instruction);
  console.log(`[paired-diff] sid: status=${sid.status} steps=${sid.steps.length} tools=${sid.tools.join(",")}`);

  console.log(`[paired-diff] judging via ${JUDGE_MODEL}...`);
  const diff = await judgeDiff(taskId, {
    instruction: yamlInfo.instruction,
    difficulty: yamlInfo.difficulty,
    estimated_turns: yamlInfo.estimated_turns,
    sid,
    claude,
  });

  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
  const outPath = join(REPORTS_DIR, `diff-${taskId}.json`);
  writeFileSync(outPath, JSON.stringify(diff, null, 2));
  console.log(`[paired-diff] wrote ${outPath}`);
  console.log(
    `[paired-diff] ${taskId}: ${diff.failure_modes.length} failure modes, step_diff sid=${diff.step_diff.sid} claude=${diff.step_diff.claude} ratio=${diff.step_diff.ratio}`,
  );
  return diff;
}

async function main(): Promise<void> {
  const taskIds = process.argv.slice(2);
  if (taskIds.length === 0) {
    console.error("用法: bun run scripts/eval/paired-trajectory-diff.ts T0002 [T0003 ...]");
    process.exit(1);
  }

  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });

  const successes: PairedDiff[] = [];
  const failures: Array<{ taskId: string; reason: string }> = [];
  for (const tid of taskIds) {
    try {
      const r = await processOne(tid);
      if (r) successes.push(r);
      else failures.push({ taskId: tid, reason: "skipped (无 primary 或 instruction 空)" });
    } catch (e) {
      console.error(`[paired-diff] ${tid} FAILED:`, e);
      failures.push({ taskId: tid, reason: (e as Error).message });
    }
  }

  const summaryPath = join(REPORTS_DIR, "paired-diff-summary.json");
  writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        total: taskIds.length,
        success: successes.length,
        failed: failures.length,
        failures,
        diffs: successes.map((d) => ({
          task_id: d.task_id,
          difficulty: d.task_difficulty,
          step_diff: d.step_diff,
          fm_count: d.failure_modes.length,
          sid_status: d.meta.sid_status,
        })),
        generated_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`\n[paired-diff] DONE. 成功 ${successes.length}/${taskIds.length}，summary: ${summaryPath}`);
  if (failures.length > 0) {
    console.error(`[paired-diff] 失败 ${failures.length} 条：`);
    for (const f of failures) console.error(`  - ${f.taskId}: ${f.reason}`);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
