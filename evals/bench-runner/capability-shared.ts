/**
 * capability-shared.ts — 通用 capability eval 框架（S0-T03~T06 共享）
 *
 * 设计动机：
 *   plan capability 的 capability-grader.ts 写死了 plan 维度专属的 check 类型
 *   （plan_min_steps / fidelity_step_ratio_in_range / recovery_plan_update_count_min 等）。
 *   memory / context / router / harness 4 个新子系统也需要 assert + LLM judge 双轨评分，
 *   但 check 类型语义不同（如 memory 的 memory_file_exists / context 的 message_count_after_compact）。
 *
 *   不复用 plan grader、各子系统独立写 grader 会带来 4 份骨架重复代码。
 *   本模块抽出"通用骨架"——case 加载、tools_called 检查、final_response 关键词检查、
 *   消息 token 估算等可被多子系统共用的检查类型；子系统 runner 只需扩展自己专属的 check 处理。
 *
 * 与 plan capability-grader 的边界：
 *   - capability-grader.ts：plan 子系统专属，保留不变（ADR-013 §2.5）
 *   - capability-shared.ts：memory / context / router / harness 共享底座
 *
 * grader 冻结期约束（CLAUDE.md §0.3.1）：
 *   本模块不调用 evals/eval-judge.ts 的 5 维 grader，独立维度由各子系统 yaml 决定。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

// ============================================================
// 通用 case 类型
// ============================================================

/** 通用 capability case 定义（5 子系统共享形态） */
export interface CapabilityCase<TExpected = Record<string, unknown>> {
  id: string;
  subsystem: string;
  dimension: string;
  priority: string;

  eval_type: string;
  target_score: number;
  graduated_at: string | null;
  holdout: boolean;

  input: {
    user_query: string;
    /** 触发 plan mode（plan capability 专用，其他子系统忽略） */
    trigger_plan_mode?: boolean;
    /** mock 注入（如失败注入、文件占位等，由各 runner 拼到 system prompt） */
    mock_environment?: Record<string, unknown>;
    /** 跨会话场景：先建 memory，再 query（memory capability 专用） */
    seed_memory?: Array<{ scope: "global" | "project"; key: string; value: string }>;
  };

  expected: TExpected;
  rubric?: Record<string, string>;
  grader: GraderRule[];

  source?: string;
  related_subsystem?: string[];
  related_adr?: string[];

  baseline_scores?: Record<string, unknown>;
}

export interface GraderRule {
  type: "assert" | "llm_judge";
  check?: string;
  weight: number;
  rubric_ref?: string[];
}

// ============================================================
// 通用 check 类型（所有子系统都可用）
// ============================================================

/** 通用 grader 输入：含 sid-code 实跑产物 + case 期望 */
export interface SharedGraderInput {
  expected: Record<string, unknown>;
  toolsCalled: string[];
  steps: number;
  finalResponse: string;
  /** 跑后从 ~/.sid-code 等持久化目录读出的辅助状态（由各 runner 注入） */
  postRunState?: Record<string, unknown>;
}

export interface CheckResult {
  check: string;
  passed: boolean;
  weight: number;
  reason: string;
}

/**
 * 通用 check 处理器：处理 5 子系统共用的 check 类型，未识别的 check 返回 null
 * 各子系统 runner 应先调本函数，未命中再 fallback 到自己专属的 handler
 */
export function runSharedCheck(
  rule: GraderRule,
  input: SharedGraderInput,
): CheckResult | null {
  const check = rule.check || "";
  const tools = new Set(input.toolsCalled.map((t) => t.toLowerCase()));
  const expected = input.expected;
  const finalLower = input.finalResponse.toLowerCase();

  switch (check) {
    case "execution_must_call_tools_any_of_hit": {
      const list = (expected.execution_must_call_tools_any_of as string[]) || [];
      const hit = list.some((t) => tools.has(t.toLowerCase()));
      return {
        check,
        passed: hit,
        weight: rule.weight,
        reason: hit
          ? `tools 命中 ${list.filter((t) => tools.has(t.toLowerCase())).join(",")}`
          : `未命中 [${list.join(",")}]`,
      };
    }
    case "execution_must_call_tools_all_hit": {
      const list = (expected.execution_must_call_tools_all as string[]) || [];
      const missing = list.filter((t) => !tools.has(t.toLowerCase()));
      return {
        check,
        passed: missing.length === 0,
        weight: rule.weight,
        reason: missing.length === 0 ? `全部命中` : `缺失 [${missing.join(",")}]`,
      };
    }
    case "execution_must_not_call_tools_zero_hit": {
      const list = (expected.execution_must_not_call_tools as string[]) || [];
      const hit = list.filter((t) => tools.has(t.toLowerCase()));
      return {
        check,
        passed: hit.length === 0,
        weight: rule.weight,
        reason: hit.length === 0 ? `未命中违禁工具` : `命中违禁工具 [${hit.join(",")}]`,
      };
    }
    case "final_response_must_include_any_of_hit": {
      const list = (expected.final_response_must_include_any_of as string[]) || [];
      const hits = list.filter((kw) => finalLower.includes(kw.toLowerCase()));
      return {
        check,
        passed: hits.length > 0,
        weight: rule.weight,
        reason: hits.length > 0 ? `命中 [${hits.join(",")}]` : `未命中 [${list.join(",")}]`,
      };
    }
    case "final_response_must_not_include_zero_hit": {
      const list = (expected.final_response_must_not_include as string[]) || [];
      const hits = list.filter((kw) => finalLower.includes(kw.toLowerCase()));
      return {
        check,
        passed: hits.length === 0,
        weight: rule.weight,
        reason: hits.length === 0 ? `无违禁词` : `命中违禁词 [${hits.join(",")}]`,
      };
    }
    case "max_steps_within_budget": {
      const max = (expected.max_steps as number) ?? 30;
      const ok = input.steps <= max;
      return {
        check,
        passed: ok,
        weight: rule.weight,
        reason: `steps=${input.steps} ${ok ? "≤" : ">"} ${max}`,
      };
    }
    default:
      return null;
  }
}

// ============================================================
// 评分聚合：assert checks + 可选 LLM Judge
// ============================================================

export function aggregateCapabilityScore(opts: {
  assertResults: CheckResult[];
  llmJudgeScore?: number;
  llmJudgeWeight?: number;
}): {
  score: number;
  assertScore: number;
  llmScore: number | null;
  details: Record<string, string | number | boolean>;
} {
  const totalAssertWeight = opts.assertResults.reduce((s, r) => s + r.weight, 0);
  const passWeight = opts.assertResults
    .filter((r) => r.passed)
    .reduce((s, r) => s + r.weight, 0);
  const assertRatio = totalAssertWeight > 0 ? passWeight / totalAssertWeight : 0;
  const assertScore = Math.round(assertRatio * 5 * 10) / 10;

  let finalScore = assertScore;
  if (opts.llmJudgeScore != null && opts.llmJudgeWeight && opts.llmJudgeWeight > 0) {
    const totalWeight = totalAssertWeight + opts.llmJudgeWeight;
    finalScore =
      (assertScore * totalAssertWeight + opts.llmJudgeScore * opts.llmJudgeWeight) /
      Math.max(totalWeight, 1e-6);
    finalScore = Math.round(finalScore * 10) / 10;
  }

  const details: Record<string, string | number | boolean> = {
    assert_pass_ratio: assertRatio,
    assert_score: assertScore,
  };
  for (const r of opts.assertResults) {
    details[r.check] = r.passed;
  }
  if (opts.llmJudgeScore != null) {
    details.llm_judge_score = opts.llmJudgeScore;
  }

  return {
    score: Math.min(5, Math.max(0, finalScore)),
    assertScore,
    llmScore: opts.llmJudgeScore ?? null,
    details,
  };
}

// ============================================================
// case 加载（按文件名前缀过滤）
// ============================================================

/**
 * 加载某目录下所有 capability case yaml
 *
 * @param dir       例：evals/capability/memory
 * @param prefix    例："case_mem_"（过滤 README.md / .gitkeep 等）
 * @param caseId    可选：只加载指定 id（用于 --case 调试）
 */
export function loadCapabilityCases<T = Record<string, unknown>>(
  dir: string,
  prefix: string,
  caseId?: string,
): CapabilityCase<T>[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".yaml"))
    .sort();

  const cases: CapabilityCase<T>[] = [];
  for (const f of files) {
    const raw = readFileSync(join(dir, f), "utf-8");
    const parsed = parseYaml(raw) as CapabilityCase<T>;
    if (caseId && parsed.id !== caseId) continue;
    cases.push(parsed);
  }
  return cases;
}

// ============================================================
// 子进程退出状态归一化（与 plan runner 同语义）
// ============================================================

/**
 * 把 sid-code-live adapter 暴露的 exit_status / timed_out 归一化为 baseline-sync 的三态：
 *   timeout | success | error
 *
 * 与 run-plan-capability.ts 的判定逻辑对齐：
 *   - timed_out=true 或 exit_status=timeout/outer_timeout → timeout
 *   - exit_status ∈ {end_turn, stop_sequence} → success
 *   - 其他（unknown / spawn_exit_N / parse_error / api_error）→ error
 */
export function classifyRunStatus(opts: {
  exitStatus: string;
  timedOut: boolean;
}): "timeout" | "success" | "error" {
  if (opts.timedOut || opts.exitStatus === "timeout" || opts.exitStatus === "outer_timeout") {
    return "timeout";
  }
  if (opts.exitStatus === "end_turn" || opts.exitStatus === "stop_sequence") {
    return "success";
  }
  return "error";
}

// ============================================================
// 报告 IO 工具
// ============================================================

/** 为子系统跑分准备 raw / report 输出目录与时间戳 */
export function prepareCapabilityOutputs(
  rootDir: string,
  subsystem: string,
): {
  ts: number;
  rawOutputPath: string;
  reportOutputPath: string;
} {
  const ts = Date.now();
  const rawDir = join(rootDir, "evals/raw-outputs");
  const reportDir = join(rootDir, "evals/_reports");
  // mkdir 由调用方负责（避免本模块隐式 IO）
  return {
    ts,
    rawOutputPath: join(rawDir, `capability-${subsystem}-${ts}.jsonl`),
    reportOutputPath: join(reportDir, `capability-${subsystem}-${ts}.json`),
  };
}

/**
 * 从 ~/.sid-code/memory/ 读取 memories.json（memory capability runner 用）
 *
 * 暴露给单测用
 */
export function readMemoryFile(filePath: string): {
  exists: boolean;
  entries: Array<{ key: string; value: string; scope: string }>;
} {
  if (!existsSync(filePath)) return { exists: false, entries: [] };
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as {
      entries?: Record<string, { key: string; value: string; scope: string }>;
    };
    const entries = Object.values(parsed.entries || {});
    return { exists: true, entries };
  } catch {
    return { exists: false, entries: [] };
  }
}

/**
 * 检查文件 mtime 是否在某时间点之后被修改
 *
 * 暴露给单测用
 */
export function isFileTouchedAfter(filePath: string, sinceMs: number): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const s = statSync(filePath);
    return s.mtimeMs >= sinceMs - 1000; // 1s 容差
  } catch {
    return false;
  }
}
