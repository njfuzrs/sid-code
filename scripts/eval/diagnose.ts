/**
 * eval:diagnose — 自动诊断低分 case 的根因 + fix_type
 *
 * A5-2 / 评测系统报告 §诊断能力 Step 2 实现。
 *
 * 流程:
 *   1. 加载 case yaml + 当前 baseline_scores（按 provider 取最近一次 success entry）
 *   2. 加载 dispatch-rules.yaml（A5 Step 4 规则集）
 *   3. 按规则匹配,first match wins,输出 fix_type + confidence + evidence
 *   4. 与 _diagnoses/<case_id>-*.yaml gold set 做最近邻匹配（同 case_id 优先）
 *   5. 落盘到 evals/_diagnoses/runs/<timestamp>/output.json
 *
 * 用法:
 *   bun run eval:diagnose --cases case_022,case_005,case_015
 *   bun run eval:diagnose --score-below 3.5  # 自动选所有总分 < 3.5 的 case
 *   bun run eval:diagnose --provider sid_code_deepseek_v4_pro --cases case_022
 */

import { parseArgs } from "node:util";
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadAllCases } from "./lib/yaml-loader";

interface DispatchRule {
  id: string;
  priority: number;
  description: string;
  when: Record<string, unknown>;
  fix_type: "case_design" | "system_prompt" | "code_bug" | "infra_bug" | "model_limit";
  confidence: number;
  note: string;
}

interface DiagnoseInput {
  caseId: string;
  caseFilePath: string;
  caseGraderType?: string;
  caseTaskType?: string;
  casePriority?: string;
  caseAnchorList: string[];
  caseUserQuery: string;
  caseMustNotInclude: string[];
  dimensions: {
    anchor_hit?: number | null;
    rubric_score?: number | null;
    tool_compliance?: number | null;
    negative_anchor?: number | null;
    efficiency?: number | null;
    cost?: number | null;
  };
  sideband: {
    total_steps?: number | null;
    total_tokens?: number | null;
    tools_used?: string[];
    errors?: string[];
    exit_status?: string;
  };
  totalScore?: number | null;
  crossProvider?: { avg: number; delta: number; available: boolean };
  rubricVariance?: number;
}

interface DiagnoseOutput {
  case_id: string;
  total_score: number | null;
  low_dimensions: string[];
  matched_rule: string | null;
  fix_type: "case_design" | "system_prompt" | "code_bug" | "infra_bug" | "model_limit" | "unknown";
  confidence: number;
  root_cause: string;
  evidence: Array<{ field: string; value: unknown; rule: string }>;
  gold_match?: { diagnosis_id: string; verified: boolean | null; same_fix_type: boolean };
  alternative_rules?: Array<{ id: string; fix_type: string; confidence: number }>;
}

const REPO_ROOT = process.cwd();
const EVALS_DIR = join(REPO_ROOT, "evals");
const DIAGNOSES_DIR = join(EVALS_DIR, "_diagnoses");

function loadDispatchRules(): DispatchRule[] {
  const path = join(DIAGNOSES_DIR, "dispatch-rules.yaml");
  if (!existsSync(path)) {
    throw new Error(`dispatch-rules.yaml 不存在: ${path}`);
  }
  const data = parseYaml(readFileSync(path, "utf-8")) as { rules?: DispatchRule[] };
  if (!data.rules || !Array.isArray(data.rules)) {
    throw new Error("dispatch-rules.yaml 缺少 rules 数组");
  }
  return [...data.rules].sort((a, b) => b.priority - a.priority);
}

function loadGoldDiagnoses(): Array<{
  diagnosis_id: string;
  case_id: string;
  case_path: string;
  expected_fix_type: string;
  verified: boolean | null;
  raw: Record<string, unknown>;
}> {
  if (!existsSync(DIAGNOSES_DIR)) return [];
  const out: Array<{
    diagnosis_id: string;
    case_id: string;
    case_path: string;
    expected_fix_type: string;
    verified: boolean | null;
    raw: Record<string, unknown>;
  }> = [];
  for (const f of readdirSync(DIAGNOSES_DIR)) {
    if (!f.endsWith(".yaml") || f === "dispatch-rules.yaml") continue;
    try {
      const data = parseYaml(readFileSync(join(DIAGNOSES_DIR, f), "utf-8")) as Record<
        string,
        unknown
      >;
      if (data.diagnosis_id && data.case_id && data.expected_fix_type) {
        out.push({
          diagnosis_id: String(data.diagnosis_id),
          case_id: String(data.case_id),
          case_path: String(data.case_path ?? ""),
          expected_fix_type: String(data.expected_fix_type),
          verified:
            typeof (data.post_fix_verification as { verified?: boolean })?.verified === "boolean"
              ? (data.post_fix_verification as { verified: boolean }).verified
              : null,
          raw: data,
        });
      }
    } catch {
      // skip malformed
    }
  }
  return out;
}

/**
 * 把 gold diagnosis 的 dimensions_snapshot + sideband_metadata 转换为 DiagnoseInput,
 * 用于 self-test (跑规则对历史快照,而不是当前 baseline)。
 */
function buildInputFromGold(gold: {
  case_id: string;
  case_path: string;
  raw: Record<string, unknown>;
}): DiagnoseInput | null {
  const snap = (gold.raw.dimensions_snapshot as Record<string, number | null>) ?? {};
  const sb = (gold.raw.sideband_metadata as Record<string, unknown>) ?? {};
  const caseSnap = (gold.raw.case_snapshot as Record<string, unknown>) ?? {};
  const extraSignals = (gold.raw.extra_signals as Record<string, unknown>) ?? {};

  // 加载 case yaml 作为兜底（case_snapshot 字段优先）
  const caseFilePath = gold.case_path ? resolve(REPO_ROOT, gold.case_path) : "";
  let caseDoc: Record<string, unknown> = {};
  if (caseFilePath && existsSync(caseFilePath)) {
    try {
      caseDoc = parseYaml(readFileSync(caseFilePath, "utf-8")) as Record<string, unknown>;
    } catch {
      // ignore
    }
  }
  const expected = (caseDoc.expected as Record<string, unknown>) ?? {};
  const input = (caseDoc.input as Record<string, unknown>) ?? {};

  // case_snapshot 优先（self-test 用历史快照),不存在则用当前 case yaml
  const anchorList =
    (caseSnap.must_include_any_of as string[] | undefined) ??
    (expected.must_include_any_of as string[] | undefined) ??
    [];
  const userQuery = (caseSnap.user_query as string | undefined) ?? String(input.user_query ?? "");
  const mustNot =
    (caseSnap.must_not_include as string[] | undefined) ??
    (expected.must_not_include as string[] | undefined) ??
    [];
  const taskType =
    (caseSnap.task_type as string | undefined) ??
    (typeof caseDoc.task_type === "string" ? (caseDoc.task_type as string) : undefined);
  const priority =
    (caseSnap.priority as string | undefined) ??
    (typeof caseDoc.priority === "string" ? (caseDoc.priority as string) : undefined);
  const graderType =
    (caseSnap.grader_type as string | undefined) ??
    (typeof caseDoc.grader_type === "string" ? (caseDoc.grader_type as string) : undefined);

  const cp =
    (extraSignals.cross_provider as
      | { avg?: number; delta?: number; available?: boolean }
      | undefined) ?? undefined;

  return {
    caseId: gold.case_id,
    caseFilePath,
    caseGraderType: graderType,
    caseTaskType: taskType,
    casePriority: priority,
    caseAnchorList: anchorList,
    caseUserQuery: userQuery,
    caseMustNotInclude: mustNot,
    dimensions: {
      anchor_hit: snap.anchor_hit ?? null,
      rubric_score: snap.rubric_score ?? null,
      tool_compliance: snap.tool_compliance ?? null,
      negative_anchor: snap.negative_anchor ?? null,
      efficiency: snap.efficiency ?? null,
      cost: snap.cost ?? null,
    },
    sideband: {
      total_steps: typeof sb.total_steps === "number" ? sb.total_steps : null,
      total_tokens: typeof sb.total_tokens === "number" ? sb.total_tokens : null,
      tools_used: Array.isArray(sb.tools_used) ? (sb.tools_used as string[]) : [],
      errors: Array.isArray(sb.errors) ? (sb.errors as string[]) : [],
      exit_status: typeof sb.exit_status === "string" ? (sb.exit_status as string) : "success",
    },
    totalScore: null,
    crossProvider: cp
      ? { avg: cp.avg ?? 0, delta: cp.delta ?? 0, available: cp.available ?? true }
      : { avg: 0, delta: 0, available: false },
    rubricVariance:
      typeof extraSignals.rubric_variance_across_batches === "number"
        ? (extraSignals.rubric_variance_across_batches as number)
        : 0,
  };
}

/**
 * 规则匹配。dispatch-rules.yaml 用了字符串 DSL（'>= 0.8' / '< 0.3'），这里做最小解释器。
 *
 * 支持的语法:
 *   - 字段路径: 'dimensions.anchor_hit' / 'sideband.total_steps' / 'case.task_type'
 *   - 字面量比较: number / null / boolean / 字符串
 *   - 字符串操作符: '>= 0.8' / '> 5' / '< 0.3' / '<= 0.5'
 *   - 数组操作符: '.length: 0' / '.contains_any: [a, b]'
 */
function matchRule(
  rule: DispatchRule,
  input: DiagnoseInput,
): { matched: boolean; evidence: Array<{ field: string; value: unknown; rule: string }> } {
  const evidence: Array<{ field: string; value: unknown; rule: string }> = [];
  for (const [path, expected] of Object.entries(rule.when)) {
    const got = resolveField(path, input);
    if (!compareWith(got, expected)) {
      return { matched: false, evidence: [] };
    }
    evidence.push({ field: path, value: got, rule: rule.id });
  }
  return { matched: true, evidence };
}

/**
 * 判断锚点是否是代码标识符 (与 evals/eval-judge.ts isCodeIdentifier 同语义,简化版)
 * 命中条件 (任一即是):
 *   - 含路径分隔符 / .ext 后缀 / .py / .ts / .yaml / .md
 *   - CamelCase / snake_case / kebab-case
 *   - 含括号 / 等号 / 等代码字符
 */
function isCodeIdentifierLike(s: string): boolean {
  if (/[/\\]/.test(s)) return true; // 路径
  if (/\.(ts|tsx|js|py|md|yaml|yml|json|sh)$/i.test(s)) return true; // 后缀
  if (/[(){}<>\[\]=;:]/.test(s)) return true; // 代码字符
  if (/[a-z][A-Z]/.test(s)) return true; // CamelCase
  if (/_/.test(s)) return true; // snake_case
  if (/^[A-Z][a-zA-Z]+/.test(s)) return true; // ClassName 类
  return false;
}

function resolveField(path: string, input: DiagnoseInput): unknown {
  if (path === "dimensions.anchor_hit") return input.dimensions.anchor_hit;
  if (path === "dimensions.rubric_score") return input.dimensions.rubric_score;
  if (path === "dimensions.tool_compliance") return input.dimensions.tool_compliance;
  if (path === "dimensions.negative_anchor") return input.dimensions.negative_anchor;
  if (path === "sideband.total_steps") return input.sideband.total_steps;
  if (path === "sideband.total_tokens") return input.sideband.total_tokens;
  if (path === "sideband.tools_used.length") return input.sideband.tools_used?.length ?? 0;
  if (path === "sideband.exit_status") return input.sideband.exit_status;
  if (path === "sideband.errors.contains_any") return input.sideband.errors ?? [];
  if (path === "case.grader_type") return input.caseGraderType;
  if (path === "case.task_type") return input.caseTaskType;
  if (path === "case.priority") return input.casePriority;
  if (path === "case.must_not_include.length") return input.caseMustNotInclude.length;
  if (path === "case.anchor_in_user_query") {
    return input.caseAnchorList.some((a) => {
      if (!input.caseUserQuery.includes(a)) return false;
      // 必须不是代码标识符,才算 echo bias
      return !isCodeIdentifierLike(a);
    });
  }
  if (path === "case.anchor_is_natural_language") {
    // 必须含中文 + 长度 ≥ 2 + 不含代码字符 + 不是路径
    return input.caseAnchorList.some((a) => {
      if (a.length < 2) return false;
      if (/[._\-/(){}<>\[\]=;:]/.test(a)) return false;
      // 至少含中文字符（自然语言短词）
      return /[一-龥]{2,}/.test(a);
    });
  }
  if (path === "cross_provider.avg_score") return input.crossProvider?.avg;
  if (path === "cross_provider.delta") return input.crossProvider?.delta;
  if (path === "cross_provider.available") return input.crossProvider?.available ?? false;
  if (path === "stats.rubric_variance_across_batches") return input.rubricVariance ?? 0;
  return undefined;
}

function compareWith(got: unknown, expected: unknown): boolean {
  // null / boolean / number 字面量
  if (expected === null) return got === null;
  if (typeof expected === "boolean") return got === expected;
  if (typeof expected === "number") return got === expected;
  if (Array.isArray(expected)) {
    // case.task_type / case.grader_type 多选 / contains_any
    if (Array.isArray(got)) {
      // contains_any 语义: 任一 got 元素包含 任一 expected 关键词（子串匹配）
      return got.some((g) =>
        expected.some((e) => typeof g === "string" && typeof e === "string" && g.includes(e)),
      );
    }
    return expected.includes(got as never);
  }
  if (typeof expected === "string") {
    // 操作符解析
    const m = expected.match(/^(>=|<=|>|<|==|!=)\s*(.+)$/);
    if (m) {
      const op = m[1];
      const rhsStr = m[2].trim();
      const rhs = isNaN(Number(rhsStr)) ? rhsStr : Number(rhsStr);
      if (got === null || got === undefined) return false;
      const lhs = got as number;
      if (op === ">=") return lhs >= (rhs as number);
      if (op === "<=") return lhs <= (rhs as number);
      if (op === ">") return lhs > (rhs as number);
      if (op === "<") return lhs < (rhs as number);
      if (op === "==") return lhs === rhs;
      if (op === "!=") return lhs !== rhs;
    }
    return got === expected;
  }
  return false;
}

function diagnose(
  input: DiagnoseInput,
  rules: DispatchRule[],
  gold: ReturnType<typeof loadGoldDiagnoses>,
): DiagnoseOutput {
  const lowDims: string[] = [];
  const dims = input.dimensions;
  if (typeof dims.anchor_hit === "number" && dims.anchor_hit < 0.5) lowDims.push("anchor_hit");
  if (typeof dims.rubric_score === "number" && dims.rubric_score < 0.5)
    lowDims.push("rubric_score");
  if (typeof dims.tool_compliance === "number" && dims.tool_compliance < 0.5)
    lowDims.push("tool_compliance");
  if (dims.negative_anchor === 0) lowDims.push("negative_anchor");
  if (dims.anchor_hit === null && dims.rubric_score === null && dims.tool_compliance === null)
    lowDims.push("all_null");

  const matched: Array<{
    rule: DispatchRule;
    evidence: Array<{ field: string; value: unknown; rule: string }>;
  }> = [];
  for (const r of rules) {
    const m = matchRule(r, input);
    if (m.matched) matched.push({ rule: r, evidence: m.evidence });
  }

  const goldHit = gold.find((g) => g.case_id === input.caseId);

  if (matched.length === 0) {
    return {
      case_id: input.caseId,
      total_score: input.totalScore ?? null,
      low_dimensions: lowDims,
      matched_rule: null,
      fix_type: "unknown",
      confidence: 0,
      root_cause: "无规则匹配；建议人审或扩 dispatch-rules.yaml",
      evidence: [],
      gold_match: goldHit
        ? { diagnosis_id: goldHit.diagnosis_id, verified: goldHit.verified, same_fix_type: false }
        : undefined,
    };
  }

  const top = matched[0];
  return {
    case_id: input.caseId,
    total_score: input.totalScore ?? null,
    low_dimensions: lowDims,
    matched_rule: top.rule.id,
    fix_type: top.rule.fix_type,
    confidence: top.rule.confidence,
    root_cause: top.rule.note,
    evidence: top.evidence,
    gold_match: goldHit
      ? {
          diagnosis_id: goldHit.diagnosis_id,
          verified: goldHit.verified,
          same_fix_type: goldHit.expected_fix_type === top.rule.fix_type,
        }
      : undefined,
    alternative_rules: matched.slice(1, 4).map((m) => ({
      id: m.rule.id,
      fix_type: m.rule.fix_type,
      confidence: m.rule.confidence,
    })),
  };
}

function buildInputFromCaseAndBaseline(
  caseDoc: Record<string, unknown>,
  caseFilePath: string,
  provider: string,
): DiagnoseInput {
  const baseline = (
    ((caseDoc.baseline_scores as Record<string, unknown>) ?? {}) as Record<string, unknown>
  )[provider] as
    | {
        score?: number;
        run_status?: string;
        dimensions?: Record<string, number | null>;
        meta?: Record<string, unknown>;
        mandatory_pass?: boolean;
        grader_type?: string;
      }
    | undefined;
  const expected = (caseDoc.expected as Record<string, unknown>) ?? {};
  const input = (caseDoc.input as Record<string, unknown>) ?? {};
  const dimensions = (baseline?.dimensions ?? {}) as Record<string, number | null>;
  const meta = (baseline?.meta ?? {}) as Record<string, unknown>;
  const graderType =
    baseline?.grader_type ??
    (typeof caseDoc.grader_type === "string" ? (caseDoc.grader_type as string) : undefined);

  return {
    caseId: String(caseDoc.id ?? "unknown"),
    caseFilePath,
    caseGraderType: graderType,
    caseTaskType: typeof caseDoc.task_type === "string" ? (caseDoc.task_type as string) : undefined,
    casePriority: typeof caseDoc.priority === "string" ? (caseDoc.priority as string) : undefined,
    caseAnchorList: (expected.must_include_any_of as string[] | undefined) ?? [],
    caseUserQuery: String(input.user_query ?? ""),
    caseMustNotInclude: (expected.must_not_include as string[] | undefined) ?? [],
    dimensions: {
      anchor_hit: dimensions.anchor_hit ?? null,
      rubric_score: dimensions.rubric_score ?? null,
      tool_compliance: dimensions.tool_compliance ?? null,
      negative_anchor: dimensions.negative_anchor ?? null,
      efficiency: dimensions.efficiency ?? null,
      cost: dimensions.cost ?? null,
    },
    sideband: {
      total_steps: typeof meta.total_steps === "number" ? meta.total_steps : null,
      total_tokens: typeof meta.total_tokens === "number" ? meta.total_tokens : null,
      tools_used: Array.isArray(meta.tools_used) ? (meta.tools_used as string[]) : [],
      errors: Array.isArray(meta.errors) ? (meta.errors as string[]) : [],
      exit_status:
        typeof meta.exit_status === "string"
          ? meta.exit_status
          : (baseline?.run_status ?? "success"),
    },
    totalScore: typeof baseline?.score === "number" ? baseline.score : null,
    crossProvider: { avg: 0, delta: 0, available: false },
  };
}

function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      cases: { type: "string" },
      provider: { type: "string", default: "sid_code_deepseek_v4_pro" },
      "score-below": { type: "string" },
      "out-dir": { type: "string" },
      "self-test": { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const provider = values.provider as string;
  const scoreBelow = values["score-below"] ? Number(values["score-below"]) : null;
  const targetCases =
    (values.cases as string | undefined)
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  const selfTest = values["self-test"] as boolean;

  const rules = loadDispatchRules();
  const gold = loadGoldDiagnoses();

  if (selfTest) {
    console.log(`[diagnose:self-test] 跑 ${gold.length} 条 gold diagnosis 验证规则准确率`);
    const results: DiagnoseOutput[] = [];
    let correct = 0;
    for (const g of gold) {
      const input = buildInputFromGold(g);
      if (!input) continue;
      const out = diagnose(input, rules, gold);
      results.push(out);
      const ok = out.fix_type === g.expected_fix_type;
      if (ok) correct++;
      console.log(
        `  ${ok ? "✅" : "❌"} ${g.diagnosis_id}  expected=${g.expected_fix_type}  got=${out.fix_type}` +
          (out.matched_rule ? `  rule=${out.matched_rule}  conf=${out.confidence}` : ""),
      );
    }
    const total = gold.length;
    const accuracy = total > 0 ? (correct / total) * 100 : 0;
    console.log(
      `\n[diagnose:self-test] 准确率: ${correct}/${total} (${accuracy.toFixed(1)}%)  门槛 ≥ 80%: ${accuracy >= 80 ? "✅" : "❌"}`,
    );

    const outDir =
      (values["out-dir"] as string | undefined) ?? join(DIAGNOSES_DIR, "runs", "self-test");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, "output.json"),
      JSON.stringify({ mode: "self-test", accuracy, correct, total, results }, null, 2),
    );
    console.log(`[diagnose:self-test] 输出: ${resolve(outDir)}/output.json`);

    if (accuracy < 80) {
      process.exit(1);
    }
    return;
  }

  const allCases = loadAllCases(EVALS_DIR);
  console.log(
    `[diagnose] 加载 ${allCases.length} case, ${rules.length} dispatch rules, ${gold.length} gold diagnoses`,
  );

  const selected: typeof allCases = [];
  for (const c of allCases) {
    if (targetCases.length > 0 && !targetCases.includes(c.id)) continue;
    const baseline = (
      (c as unknown as Record<string, unknown>).baseline_scores as
        | Record<string, { score?: number }>
        | undefined
    )?.[provider];
    if (scoreBelow !== null) {
      if (typeof baseline?.score !== "number" || baseline.score >= scoreBelow) continue;
    }
    selected.push(c);
  }

  if (selected.length === 0) {
    console.error(
      `[diagnose] 未匹配任何 case (cases=${targetCases.join(",") || "<all>"} score-below=${scoreBelow ?? "<none>"})`,
    );
    process.exit(2);
  }

  const ts = "manual"; // §0 禁止使用 Date.now;手动 timestamp 由调用方传 --out-dir 覆盖
  const outDir = (values["out-dir"] as string | undefined) ?? join(DIAGNOSES_DIR, "runs", ts);
  mkdirSync(outDir, { recursive: true });

  const results: DiagnoseOutput[] = [];
  for (const c of selected) {
    const input = buildInputFromCaseAndBaseline(
      c as unknown as Record<string, unknown>,
      (c as { filePath: string }).filePath,
      provider,
    );
    const out = diagnose(input, rules, gold);
    results.push(out);
    console.log(
      `\n[diagnose] ${out.case_id}  fix_type=${out.fix_type}  confidence=${out.confidence}` +
        (out.matched_rule ? `  rule=${out.matched_rule}` : "") +
        (out.gold_match
          ? `  gold=${out.gold_match.diagnosis_id} (same_fix=${out.gold_match.same_fix_type})`
          : "") +
        `\n  root_cause: ${out.root_cause}` +
        (out.low_dimensions.length > 0
          ? `\n  low_dimensions: ${out.low_dimensions.join(", ")}`
          : ""),
    );
  }

  writeFileSync(
    join(outDir, "output.json"),
    JSON.stringify({ provider, scoreBelow, results }, null, 2),
  );
  console.log(`\n[diagnose] 输出: ${resolve(outDir)}/output.json`);

  // gold accuracy
  const withGold = results.filter((r) => r.gold_match);
  if (withGold.length > 0) {
    const correct = withGold.filter((r) => r.gold_match!.same_fix_type).length;
    console.log(
      `[diagnose] gold 命中率: ${correct}/${withGold.length} (${((correct / withGold.length) * 100).toFixed(1)}%)`,
    );
  }
}

main();
