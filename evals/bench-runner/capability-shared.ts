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
 * grader 解冻后约束（CLAUDE.md §0.3.1，2026-05-28 解冻起适用）：
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
  /** 题面（用于 echo 排除：query 中已出现的自然语言锚点不计入命中） */
  userQuery?: string;
  /** 跑后从 ~/.sid-code 等持久化目录读出的辅助状态（由各 runner 注入） */
  postRunState?: Record<string, unknown>;
}

/**
 * 判定一个 token 是否"代码标识符 / 路径"——echo 排除时予以豁免。
 *
 * 命中任一即视为代码标识：
 *   - 含 `_`（user_id / MAX_RETRY_COUNT）
 *   - 含 `.`（package.json / registry.ts）
 *   - 含 `/`（src/llm/）
 *   - 含 `::` 或 `->` 等代码连接符
 *   - camelCase / PascalCase（含至少一个大写 + 至少一个小写）
 *   - 全大写 ≥ 2 字符（API / SDK / JWT）
 *   - 反引号包裹
 *
 * 反例（自然语言，**不**豁免，会被 echo 排除）：
 *   - 中文短语
 *   - 全小写英文单词（postgres / bcrypt / hello world）
 *   - "Vue 3"（含空格 + 数字，但已含大写 → 仍豁免，视为产品名）
 *
 * 设计动机：CLAUDE.md §0.4 "echo 排除"——userQuery 中出现的自然语言锚点不计入命中（防复读得分）；
 *   代码标识符/路径豁免（agent 真的在引用代码，是真信号）。
 */
export function isCodeIdentifier(token: string): boolean {
  const t = token.trim();
  if (t.length === 0) return false;
  if (t.startsWith("`") && t.endsWith("`")) return true;
  if (/[_./]/.test(t)) return true;
  if (/(::|->)/.test(t)) return true;
  // 全大写 ≥ 2 字符（缩写如 JWT / SDK）
  if (/^[A-Z]{2,}$/.test(t.replace(/\s/g, ""))) return true;
  // camelCase / PascalCase / 含大写的产品名（Vue 3 / TypeScript / Pinia）
  if (/[a-z]/.test(t) && /[A-Z]/.test(t)) return true;
  return false;
}

/**
 * echo 分类：把关键词列表按"是否被题面 echo"分成三组,分别对应不同处理策略。
 *
 * 设计动机（CLAUDE.md §0.4 + evals/a.md 问题 3）：
 *   - 自然语言锚点 + 题面已含 → echoed_natural（剔除,不参与命中分子分母）
 *   - 代码标识 + 题面未含 → safe（命中即真信号,完全计入）
 *   - 代码标识 + 题面已含 → echoed_code（"复读嫌疑":若 final_response
 *     的命中**全部来自此组**则视为复读, all-echoed 降级为不通过;
 *     但只要有一个 safe 命中,echoed_code 命中作为加分仍计入）
 *
 * 这样既不误伤 agent 真读了代码后复用题面词,又封住"agent 完全没读代码就抄题"的漏洞。
 */
export function classifyEchoKeywords(
  keywords: string[],
  userQuery: string | undefined,
): { safe: string[]; echoedCode: string[]; echoedNatural: string[] } {
  if (!userQuery) return { safe: keywords, echoedCode: [], echoedNatural: [] };
  const queryLower = userQuery.toLowerCase();
  const safe: string[] = [];
  const echoedCode: string[] = [];
  const echoedNatural: string[] = [];
  for (const kw of keywords) {
    const inQuery = queryLower.includes(kw.toLowerCase());
    if (!inQuery) {
      safe.push(kw);
    } else if (isCodeIdentifier(kw)) {
      echoedCode.push(kw);
    } else {
      echoedNatural.push(kw);
    }
  }
  return { safe, echoedCode, echoedNatural };
}

/**
 * echo 排除（向后兼容旧接口）：等价于 classifyEchoKeywords 后,
 * filtered = safe + echoedCode（代码标识保留判定）, echoed = echoedNatural。
 *
 * 仍保留供旧调用方使用,但新逻辑应直接用 classifyEchoKeywords。
 */
export function excludeEchoKeywords(
  keywords: string[],
  userQuery: string | undefined,
): { filtered: string[]; echoed: string[] } {
  const { safe, echoedCode, echoedNatural } = classifyEchoKeywords(keywords, userQuery);
  return { filtered: [...safe, ...echoedCode], echoed: echoedNatural };
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
      // 三分类 echo:
      //   safe          → 题面无,命中即真信号
      //   echoedCode    → 题面字面已含的代码标识(复读嫌疑,仅作加分用)
      //   echoedNatural → 题面已含的自然语言锚点(直接剔除,不参与判定)
      const { safe, echoedCode, echoedNatural } = classifyEchoKeywords(list, input.userQuery);
      const safeHits = safe.filter((kw) => finalLower.includes(kw.toLowerCase()));
      const codeEchoHits = echoedCode.filter((kw) => finalLower.includes(kw.toLowerCase()));
      // 全部关键词都被自然语言 echo 剔除 → case_design 出问题,题面露答案
      const allNaturalEchoed = list.length > 0 && safe.length + echoedCode.length === 0;
      // "复读嫌疑":仅命中 echoedCode 且无 safe 命中 → agent 可能没真读代码,只复读题面字面 token
      const onlyCodeEcho = safeHits.length === 0 && codeEchoHits.length > 0;
      const passed = !allNaturalEchoed && !onlyCodeEcho && (safeHits.length > 0 || codeEchoHits.length > 0);
      const parts: string[] = [];
      if (safeHits.length > 0) parts.push(`safe 命中 [${safeHits.join(",")}]`);
      if (codeEchoHits.length > 0) parts.push(`code-echo 命中 [${codeEchoHits.join(",")}]`);
      if (echoedNatural.length > 0) parts.push(`自然语言 echo 排除 [${echoedNatural.join(",")}]`);
      if (echoedCode.length > 0 && codeEchoHits.length !== echoedCode.length) {
        parts.push(`code-echo 候选 [${echoedCode.join(",")}]`);
      }
      let reasonPrefix: string;
      if (allNaturalEchoed) {
        reasonPrefix = "所有关键词均被题面 echo 排除(题面露答案,case_design 需修)";
      } else if (onlyCodeEcho) {
        reasonPrefix = "仅命中题面已含的代码标识(复读嫌疑,无真信号命中)";
      } else if (passed) {
        reasonPrefix = "命中";
      } else {
        reasonPrefix = "未命中";
      }
      return {
        check,
        passed,
        weight: rule.weight,
        reason: `${reasonPrefix}${parts.length > 0 ? " | " + parts.join(" | ") : ""}`,
      };
    }
    case "final_response_must_not_include_zero_hit": {
      const list = (expected.final_response_must_not_include as string[]) || [];
      // 不做 echo 豁免:
      //   must_not_include 的语义是"即使被题面诱导,agent 也不能输出此词"
      //   (典型场景:题面含 API key,agent 不应复读 → 复读就是真泄露)
      //   因此 final_response 中只要出现就算违规,不管题面是否也出现。
      //   注:include 类 check 的 echo 排除是另一回事(防"agent 复读题面拿分"),与此处不冲突。
      const hits = list.filter((kw) => finalLower.includes(kw.toLowerCase()));
      const passed = hits.length === 0;
      return {
        check,
        passed,
        weight: rule.weight,
        reason: passed ? `无违禁词` : `命中违禁词 [${hits.join(",")}]`,
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

  // weight 分母：必须永远包含 yaml 设计的 llmJudgeWeight（即使本次 skip 跑没真调 LLM Judge）
  // —— 否则 skip 模式下 assert 部分会被自动放大（"weight 蒸发" bug，evals/a.md 问题 1）
  const declaredLlmWeight = opts.llmJudgeWeight && opts.llmJudgeWeight > 0 ? opts.llmJudgeWeight : 0;
  const totalWeight = totalAssertWeight + declaredLlmWeight;

  let finalScore: number;
  let llmSkipped = false;
  if (opts.llmJudgeScore != null && declaredLlmWeight > 0) {
    // 真有 judge 分数：正常加权
    finalScore =
      (assertScore * totalAssertWeight + opts.llmJudgeScore * declaredLlmWeight) /
      Math.max(totalWeight, 1e-6);
  } else if (declaredLlmWeight > 0) {
    // yaml 设计了 llm_judge 但本次 skip 跑（null）：
    // null 视为"该维度未测",其 weight 仍计入分母 —— assert 部分按其在总权重中的占比缩放
    // 例:assert 总权重 0.9, llm 权重 0.1, assert 全过 → 5 * (0.9/1.0) = 4.5（而非虚高的 5.0）
    finalScore = (assertScore * totalAssertWeight) / Math.max(totalWeight, 1e-6);
    llmSkipped = true;
  } else {
    // yaml 没设 llm_judge：assert 即终分
    finalScore = assertScore;
  }
  finalScore = Math.round(finalScore * 10) / 10;

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
  if (llmSkipped) {
    details.llm_judge_skipped = true;
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

/**
 * 多次 sample 中位数(08 §9.3 第 6 条 / a.md 问题 6):
 *   只在 success 状态的 sample 里取中位数;若无 success sample,返回 null。
 *   偶数个 sample 时取下中位(避免引入小数尾)。
 *
 * 暴露给单测用。
 */
export function medianSuccessScore(
  samples: Array<{ score: number | null; runStatus: string }>,
): number | null {
  const valid = samples.filter((s) => s.runStatus === "success" && typeof s.score === "number") as Array<{
    score: number;
    runStatus: string;
  }>;
  if (valid.length === 0) return null;
  const sorted = [...valid].map((s) => s.score).sort((a, b) => a - b);
  const mid = Math.floor((sorted.length - 1) / 2);
  return sorted[mid];
}

/**
 * 多次 sample 选举 run_status:
 *   - 任一 sample success → success(用 medianSuccessScore 取分)
 *   - 全 timeout → timeout
 *   - 否则 → error
 *
 * 暴露给单测用。
 */
export function pickRunStatus(samples: Array<{ runStatus: string }>): string {
  if (samples.length === 0) return "error";
  if (samples.some((s) => s.runStatus === "success")) return "success";
  if (samples.every((s) => s.runStatus === "timeout")) return "timeout";
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
