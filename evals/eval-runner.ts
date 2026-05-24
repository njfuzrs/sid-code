#!/usr/bin/env bun

import { resolve, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import * as yamlLib from "yaml";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import {
  gradeAnchorHit,
  gradeRubric,
  gradeToolCompliance,
  gradeEfficiency,
  gradeCost,
  aggregate,
  type DimScore,
  type AgentMeta,
} from "./eval-judge.ts";

const ROOT = resolve(import.meta.dir);
const CASE_DIRS = [
  join(ROOT, "p0-core"),
  join(ROOT, "p1-common"),
  join(ROOT, "p2-edge"),
];
const HOLDOUT_DIR = join(ROOT, "holdout");

interface CaseYaml {
  id: string;
  category: string;
  priority: string;
  holdout?: boolean;
  input: { user_query: string };
  expected: {
    must_include_any_of?: string[];
    must_not_include?: string[];
    must_call_tools?: string[];
    /** 工具检查模式：all_of(默认) | any_of(任一即可) */
    must_call_tools_mode?: "all_of" | "any_of";
    must_not_call_tools?: string[];
    must_not_modify_files?: string[];
    max_steps?: number;
    reference_answer?: string;
  };
  rubric?: {
    completeness?: string;
    precision?: string;
    helpfulness?: string;
  };
}

interface ProviderDef {
  name: string;
  script: string;
  model?: string;
  timeoutMs?: number;
  maxTurns?: number;
  extraArgs?: string[];
}

interface ProviderResult {
  output: string;
  meta: AgentMeta & { latency_ms: number; exit_status: string; error_count: number; retry_count: number; backtrack_count: number };
  error?: boolean;
}

interface TestResult {
  caseId: string;
  provider: string;
  score: number;
  namedScores: Record<string, number>;
  dims: Record<string, DimScore>;
  response: { output: string };
  latencyMs: number;
  success: boolean;
}

const PROVIDER_REGISTRY: Record<string, Omit<ProviderDef, "name" | "model">> = {
  "sid-code": {
    script: join(ROOT, "providers/sid-code-live.ts"),
    timeoutMs: 480_000,
    maxTurns: 30,
  },
  "claude-code": {
    script: join(ROOT, "providers/claude-code.ts"),
    timeoutMs: 480_000,
    maxTurns: 30,
  },
};

function buildProvider(type: string, model: string): ProviderDef {
  const reg = PROVIDER_REGISTRY[type];
  if (!reg) throw new Error(`未知 provider 类型: ${type}，可选: ${Object.keys(PROVIDER_REGISTRY).join(", ")}`);
  const modelSlug = model.replace(/[^a-zA-Z0-9]/g, "_");
  return { ...reg, name: `${type.replace(/-/g, "_")}_${modelSlug}`, model };
}

async function loadCases(
  caseFilter?: string[],
  opts: { skipHoldout?: boolean; includeHoldout?: boolean } = {},
): Promise<CaseYaml[]> {
  const { skipHoldout = true, includeHoldout = false } = opts;
  const wantSet = caseFilter ? new Set(caseFilter) : null;
  const cases: CaseYaml[] = [];

  // 默认行为：扫描 P0/P1/P2 + 过滤 holdout=true 标记。
  // includeHoldout=true 时，额外扫描 evals/holdout/ 目录，且不再过滤 holdout 标记。
  // 注意：单独传 --cases case_004（在 holdout 目录里）的情况，
  // 会通过下面的 holdout 目录扫描分支拿到（即便 includeHoldout=false 也允许显式指定）。
  const dirsToScan = [...CASE_DIRS];
  const explicitlyAskedHoldoutId = wantSet ? hasHoldoutId(wantSet) : false;
  if (includeHoldout || explicitlyAskedHoldoutId) {
    dirsToScan.push(HOLDOUT_DIR);
  }

  for (const dir of dirsToScan) {
    if (!existsSync(dir)) continue;
    const files = await Array.fromAsync(new Bun.Glob("*.yaml").scan(dir));
    for (const f of files) {
      const content = await Bun.file(join(dir, f)).text();
      const c = parseYaml(content) as CaseYaml;
      // case 在 holdout 目录或带 holdout=true 标记 → 视为 holdout
      const isHoldout = dir === HOLDOUT_DIR || c.holdout === true;
      if (isHoldout && skipHoldout && !includeHoldout && !(wantSet && wantSet.has(c.id))) continue;
      if (wantSet && !wantSet.has(c.id)) continue;
      cases.push(c);
    }
  }
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

function hasHoldoutId(want: Set<string>): boolean {
  if (!existsSync(HOLDOUT_DIR)) return false;
  for (const id of want) {
    if (existsSync(join(HOLDOUT_DIR, `${id}.yaml`))) return true;
  }
  return false;
}

async function runProvider(provider: ProviderDef, prompt: string, caseId: string): Promise<ProviderResult> {
  const args = [
    "run", provider.script,
    "--prompt", prompt,
    "--case-id", caseId,
  ];
  if (provider.model) args.push("--model", provider.model);
  if (provider.timeoutMs) args.push("--timeout", String(provider.timeoutMs));
  if (provider.maxTurns) args.push("--max-turns", String(provider.maxTurns));
  if (provider.extraArgs) args.push(...provider.extraArgs);

  const proc = spawn("bun", args, {
    cwd: resolve(ROOT, ".."),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  proc.stdout?.on("data", (c) => { stdoutBuf += c.toString(); });
  proc.stderr?.on("data", (c) => { stderrBuf += c.toString(); });

  const exitCode: number | null = await new Promise((res) => {
    proc.on("close", (code) => res(code));
    proc.on("error", () => res(null));
  });

  if (stderrBuf) process.stderr.write(stderrBuf);

  try {
    return JSON.parse(stdoutBuf.trim()) as ProviderResult;
  } catch {
    return {
      output: stdoutBuf || `[ERROR] provider exit=${exitCode}`,
      meta: { tools_used: [], files_edited: [], total_steps: 0, total_tokens: 0, latency_ms: 0, exit_status: "parse_error", error_count: 0, retry_count: 0, backtrack_count: 0 },
      error: true,
    };
  }
}

function buildRubricPrompt(c: CaseYaml): string {
  const must = c.expected.must_include_any_of || [];
  const mustNot = c.expected.must_not_include || [];
  const refAns = c.expected.reference_answer?.trim() || "(无)";
  const r = c.rubric || {};

  const mustNotSection = mustNot.length > 0
    ? ["禁止内容(语义判断):", "  以下词如果只是作为「对比提及」或「拒绝声明」中出现，不扣分。", "  只有当输出错误地将其作为正确答案、或泄露了敏感内部信息时才扣分：", ...mustNot.map((k) => `  - ${k}`), ""]
    : [];
  const mustSection = must.length > 0
    ? ["关键词命中(参考，非强制，至少 1 个):", "  必须包含(any_of):", ...must.map((k) => `  - ${k}`), "  → 如果输出用等价表达覆盖了相同概念但未精确匹配这些词，不应因此扣分", ""]
    : [];

  return [
    `任务类别: ${c.category}(${c.priority})`, `用户问题: ${c.input.user_query}`, "",
    "参考答案(仅为一种可能的正确路径，不是唯一标准):", refAns, "",
    "=== 评判规则 ===", "",
    "【最重要】事实正确性优先：",
    "- 如果输出的核心结论与代码实际状态一致（即使表述不同于参考答案），应给予高分",
    "- 如果参考答案假设某功能不存在但实际已存在，输出回答「已存在」是正确的",
    "- 如果参考答案假设某字段存在但实际不存在，输出回答「不存在」是正确的", "",
    ...mustSection, ...mustNotSection,
    "评分维度:",
    "  - factual_accuracy: 输出的核心结论是否与代码/事实实际状态一致（优先级最高）",
    `  - completeness: ${r.completeness || "(本 case 未指定)"}`,
    `  - precision: ${r.precision || "(本 case 未指定)"}`,
    `  - helpfulness: ${r.helpfulness || "(本 case 未指定)"}`, "",
    "评分标准(0.0-1.0, threshold 0.6):",
    "  1.0 = 事实正确 + 完全满足用户需求 + 表达清晰",
    "  0.8 = 事实正确 + 核心需求满足，有小瑕疵",
    "  0.6 = 方向正确，核心事实无误(threshold)",
    "  0.4 = 部分正确但有明显错误或严重遗漏",
    "  0.2 = 方向错误或严重事实偏差",
    "  0.0 = 完全偏题或有害输出", "",
    '输出严格 JSON: {"pass": bool, "score": 0.0-1.0, "reason": "简要理由"}',
  ].join("\n");
}

async function gradeCase(c: CaseYaml, result: ProviderResult, skipLlmJudge: boolean): Promise<{ score: number; namedScores: Record<string, number>; dims: Record<string, DimScore> }> {
  const { output, meta } = result;
  const dims: Record<string, DimScore> = {};

  dims.anchor_hit = gradeAnchorHit(output, c.expected.must_include_any_of || []);
  if (skipLlmJudge) {
    dims.rubric_score = { pass: true, score: 1.0, reason: "跳过 LLM judge" };
  } else {
    dims.rubric_score = await gradeRubric(output, buildRubricPrompt(c));
  }
  dims.tool_compliance = gradeToolCompliance(meta, {
    mustCallTools: c.expected.must_call_tools,
    mustCallMode: c.expected.must_call_tools_mode,
    mustNotCallTools: c.expected.must_not_call_tools,
    mustNotModifyFiles: c.expected.must_not_modify_files,
  });
  dims.efficiency = gradeEfficiency(meta, c.expected.max_steps || 15);
  dims.cost = gradeCost(meta);

  const { score, namedScores } = aggregate(dims);
  return { score, namedScores, dims };
}

function pLimit(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return <T>(fn: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(resolve).catch(reject).finally(() => {
          active--;
          if (queue.length > 0) queue.shift()!();
        });
      };
      if (active < concurrency) run();
      else queue.push(run);
    });
  };
}

function currentWeekNumber(): number {
  const now = new Date();
  const start = new Date(2026, 0, 1);
  return Math.ceil((now.getTime() - start.getTime()) / (7 * 24 * 60 * 60 * 1000));
}

function writeWeekScores(results: TestResult[], weekNum: number) {
  const scoresDir = join(ROOT, "_scores", `w${weekNum}`);
  mkdirSync(scoresDir, { recursive: true });

  const byCaseId = new Map<string, TestResult[]>();
  for (const r of results) {
    if (!byCaseId.has(r.caseId)) byCaseId.set(r.caseId, []);
    byCaseId.get(r.caseId)!.push(r);
  }

  for (const [caseId, caseResults] of byCaseId) {
    const doc: Record<string, unknown> = { tested_at: new Date().toISOString() };
    for (const r of caseResults) {
      doc[r.provider] = {
        score: r.score,
        anchor: { score: r.namedScores.anchor_hit ?? null },
        llm: {
          score: r.namedScores.rubric_score ?? null,
          dimensions: r.namedScores,
        },
      };
    }
    const filePath = join(scoresDir, `${caseId}.yaml`);
    writeFileSync(filePath, yamlLib.stringify(doc));
  }
  console.log(`  时序数据: ${scoresDir}/ (${byCaseId.size} 个 case)`);
}

/**
 * 追加每次 run 的历史快照到 _runs/{provider}.jsonl —— 永不覆盖。
 *
 * 文件按 provider 切分，便于单 provider 趋势分析。
 * dashboard 读取这些 jsonl 画运行历史折线图。
 */
function appendRunHistory(results: TestResult[], runId: string, weekNum: number) {
  const runsDir = join(ROOT, "_runs");
  mkdirSync(runsDir, { recursive: true });

  const byProvider = new Map<string, TestResult[]>();
  for (const r of results) {
    if (!byProvider.has(r.provider)) byProvider.set(r.provider, []);
    byProvider.get(r.provider)!.push(r);
  }

  for (const [provider, providerResults] of byProvider) {
    const filePath = join(runsDir, `${provider}.jsonl`);
    const lines: string[] = [];
    for (const r of providerResults) {
      const isTimeout = r.response.output.includes("TIMEOUT");
      const isError = r.response.output.includes("[ERROR]");
      const runStatus = isTimeout ? "timeout" : isError ? "error" : "success";
      lines.push(JSON.stringify({
        run_id: runId,
        week: weekNum,
        case_id: r.caseId,
        provider: r.provider,
        score: r.score,
        named_scores: r.namedScores,
        latency_ms: r.latencyMs,
        success: r.success,
        run_status: runStatus,
        tested_at: runId,
      }));
    }
    appendFileSync(filePath, lines.join("\n") + "\n", "utf-8");
  }
  console.log(`  运行历史: ${runsDir}/ (${byProvider.size} 个 provider × ${results.length / byProvider.size} 个 case)`);
}

function findCaseYamlPath(caseId: string): string | null {
  const allDirs = [...CASE_DIRS, HOLDOUT_DIR];
  for (const dir of allDirs) {
    const p = join(dir, `${caseId}.yaml`);
    if (existsSync(p)) return p;
  }
  return null;
}

function syncBaselineScores(results: TestResult[]) {
  const timestamp = new Date().toISOString();
  const byCaseId = new Map<string, TestResult[]>();
  for (const r of results) {
    if (!byCaseId.has(r.caseId)) byCaseId.set(r.caseId, []);
    byCaseId.get(r.caseId)!.push(r);
  }

  let updated = 0;
  for (const [caseId, caseResults] of byCaseId) {
    const yamlPath = findCaseYamlPath(caseId);
    if (!yamlPath) continue;

    const content = readFileSync(yamlPath, "utf-8");
    const doc = yamlLib.parseDocument(content);
    const root = doc.contents as yamlLib.YAMLMap;

    let baselineNode = root.get("baseline_scores") as yamlLib.YAMLMap | undefined;
    if (!baselineNode) {
      baselineNode = doc.createNode({}) as yamlLib.YAMLMap;
      root.set("baseline_scores", baselineNode);
    }

    for (const r of caseResults) {
      const isTimeout = r.response.output.includes("TIMEOUT");
      const isError = r.response.output.includes("[ERROR]");
      const runStatus = isTimeout ? "timeout" : isError ? "error" : "success";

      const entry: Record<string, unknown> = {
        score: r.score,
        run_status: runStatus,
        tested_at: timestamp,
        tested_by: "eval-runner",
        transcript_path: null,
        notes: isTimeout ? "eval-runner 超时" : "",
        dimensions: r.namedScores,
      };
      baselineNode.set(r.provider, doc.createNode(entry));
    }

    writeFileSync(yamlPath, doc.toString(), "utf-8");
    updated++;
  }
  console.log(`  回写 baseline_scores: ${updated} 个 case yaml`);
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      cases: { type: "string" },
      provider: { type: "string", default: "sid-code" },
      model: { type: "string", default: "deepseek-v4-pro" },
      concurrency: { type: "string", default: "2" },
      output: { type: "string", default: "evals/_reports/eval-latest.json" },
      week: { type: "string" },
      "skip-holdout": { type: "boolean", default: true },
      "include-holdout": { type: "boolean", default: false },
      "skip-llm-judge": { type: "boolean", default: false },
      "skip-sync": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
    strict: false,
  });

  const providerTypes = (values.provider as string).split(",").map(s => s.trim());
  const model = values.model as string;
  const providers = providerTypes.map(t => buildProvider(t, model));

  const caseFilter = values.cases ? (values.cases as string).split(",").map(s => s.trim()) : undefined;
  const concurrency = parseInt(values.concurrency as string, 10) || 2;
  const skipLlmJudge = values["skip-llm-judge"] as boolean;
  const skipSync = values["skip-sync"] as boolean;
  const dryRun = values["dry-run"] as boolean;
  const outputPath = resolve(ROOT, "..", values.output as string);
  const weekNum = values.week ? parseInt(values.week as string, 10) : currentWeekNumber();

  const cases = await loadCases(caseFilter, {
    skipHoldout: values["skip-holdout"] as boolean,
    includeHoldout: values["include-holdout"] as boolean,
  });

  if (cases.length === 0) {
    console.error("未找到匹配的 case");
    process.exit(1);
  }

  console.log(`[eval-runner] ${cases.length} cases × ${providers.length} providers = ${cases.length * providers.length} 组合`);
  console.log(`  provider: ${providers.map(p => p.name).join(", ")}`);
  console.log(`  model: ${model} | 并发: ${concurrency} | LLM judge: ${skipLlmJudge ? "跳过" : "启用"} | week: w${weekNum}`);
  console.log("");

  if (dryRun) {
    console.log("dry-run 模式，跳过实际执行。将执行:");
    for (const c of cases) {
      for (const p of providers) {
        console.log(`  ${c.id} × ${p.name}`);
      }
    }
    return;
  }

  const limit = pLimit(concurrency);
  const results: TestResult[] = [];
  const startTime = Date.now();

  const tasks = cases.flatMap(c =>
    providers.map(p => limit(async () => {
      const taskStart = Date.now();
      console.log(`▶ ${c.id} × ${p.name} ...`);

      try {
        const provResult = await runProvider(p, c.input.user_query, c.id);
        const grade = await gradeCase(c, provResult, skipLlmJudge);

        const elapsed = Date.now() - taskStart;
        const emoji = grade.score >= 4.5 ? "✅" : grade.score >= 3.5 ? "🟢" : grade.score >= 2.5 ? "🟡" : "🔴";
        console.log(`  ${emoji} ${c.id} × ${p.name} = ${grade.score} (${(elapsed / 1000).toFixed(1)}s)`);

        results.push({
          caseId: c.id,
          provider: p.name,
          score: grade.score,
          namedScores: grade.namedScores,
          dims: grade.dims,
          response: { output: provResult.output },
          latencyMs: provResult.meta.latency_ms || elapsed,
          success: !provResult.error,
        });
      } catch (err) {
        // 单个 case 失败不能拖垮整批：记录降级结果，let 整体继续
        const elapsed = Date.now() - taskStart;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.log(`  ⚠️  ${c.id} × ${p.name} = ERROR (${(elapsed / 1000).toFixed(1)}s): ${errMsg.slice(0, 120)}`);
        results.push({
          caseId: c.id,
          provider: p.name,
          score: 0,
          namedScores: { anchor_hit: 0, rubric_score: 0, tool_compliance: 0, efficiency: 0, cost: 0 },
          dims: { error: { pass: false, score: 0, reason: errMsg.slice(0, 300) } },
          response: { output: `[ERROR] eval-runner task crash: ${errMsg}` },
          latencyMs: elapsed,
          success: false,
        });
      }
    }))
  );

  await Promise.all(tasks);
  const totalElapsed = Date.now() - startTime;

  const output = {
    version: 2,
    timestamp: new Date().toISOString(),
    config: { cases: cases.map(c => c.id), providers: providers.map(p => p.name), model, concurrency, week: weekNum },
    results: {
      timestamp: new Date().toISOString(),
      results: results.map(r => ({
        cost: 0,
        latencyMs: r.latencyMs,
        provider: { id: r.provider, label: r.provider },
        response: r.response,
        score: r.score / 5,
        success: r.success,
        namedScores: r.namedScores,
        testCase: { vars: { case_id: r.caseId }, description: r.caseId },
        gradingResult: {
          pass: r.score >= 3.0,
          score: r.score / 5,
          namedScores: r.namedScores,
          componentResults: Object.entries(r.dims).map(([metric, dim]) => ({
            assertion: { type: "custom", metric },
            pass: dim.pass,
            score: dim.score,
            reason: dim.reason,
          })),
        },
      })),
    },
    stats: { totalMs: totalElapsed, count: results.length },
  };

  await Bun.write(outputPath, JSON.stringify(output, null, 2));

  const runId = output.timestamp;
  appendRunHistory(results, runId, weekNum);
  writeWeekScores(results, weekNum);

  if (!skipSync) {
    syncBaselineScores(results);
  }

  console.log("");
  console.log(`[eval-runner] 完成 ${results.length} 组评测，耗时 ${(totalElapsed / 1000).toFixed(0)}s`);
  console.log(`  输出: ${outputPath}`);
  const avgScore = results.reduce((s, r) => s + r.score, 0) / results.length;
  console.log(`  平均分: ${avgScore.toFixed(2)}/5`);

  await refreshReports();
}

async function refreshReports() {
  console.log("");
  console.log("[eval-runner] 自动刷新报告...");
  const projectRoot = resolve(ROOT, "..");

  const dashboardProc = spawn("bun", ["run", "eval:dashboard"], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const casesProc = spawn("bun", ["run", join(ROOT, "gen-cases-md.ts")], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const wait = (p: ReturnType<typeof spawn>) => new Promise<number | null>((res) => {
    p.on("close", (code) => res(code));
    p.on("error", () => res(null));
  });

  const [dashCode, casesCode] = await Promise.all([wait(dashboardProc), wait(casesProc)]);
  if (dashCode === 0) console.log("  ✅ DASHBOARD.md 已刷新");
  else console.log(`  ❌ DASHBOARD.md 刷新失败 (exit=${dashCode})`);
  if (casesCode === 0) console.log("  ✅ CASES.md 已刷新");
  else console.log(`  ❌ CASES.md 刷新失败 (exit=${casesCode})`);
}

main().catch((err) => {
  console.error("[eval-runner] fatal:", err);
  process.exit(1);
});
