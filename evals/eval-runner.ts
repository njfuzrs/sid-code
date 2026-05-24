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
  COST_FORMULA_VERSION,
  type DimScore,
  type AgentMeta,
} from "./eval-judge.ts";
import { buildRubricPrompt } from "./_judge/rubric-template.ts";
import type { CaseYaml } from "./_types.ts";

const ROOT = resolve(import.meta.dir);
const CASE_DIRS = [
  join(ROOT, "p0-core"),
  join(ROOT, "p1-common"),
  join(ROOT, "p2-edge"),
];
const HOLDOUT_DIR = join(ROOT, "holdout");

export interface ProviderDef {
  name: string;
  script: string;
  model?: string;
  timeoutMs?: number;
  maxTurns?: number;
  extraArgs?: string[];
}

export interface ProviderResult {
  output: string;
  meta: AgentMeta & { latency_ms: number; exit_status: string; error_count: number; retry_count: number; backtrack_count: number };
  error?: boolean;
}

export interface TestResult {
  caseId: string;
  provider: string;
  score: number;
  namedScores: Record<string, number>;
  dims: Record<string, DimScore>;
  response: { output: string };
  latencyMs: number;
  success: boolean;
  /** 单 case 实际跑完时间（ISO 字符串）—— 与整批 runId 不同，趋势图按这个画 */
  testedAt: string;
}

const PROVIDER_REGISTRY: Record<string, Omit<ProviderDef, "name" | "model"> & { defaultModel: string }> = {
  "sid-code": {
    script: join(ROOT, "providers/sid-code-live.ts"),
    timeoutMs: 480_000,
    maxTurns: 30,
    defaultModel: "deepseek-v4-pro",
  },
  "claude-code": {
    script: join(ROOT, "providers/claude-code.ts"),
    timeoutMs: 480_000,
    maxTurns: 30,
    // claude CLI 只认 anthropic 模型 slug（claude-opus-4-7 / claude-sonnet-4-6 / claude-haiku-4-5）。
    // 传 deepseek-v4-pro 会让 claude 立刻报错退出 → 横向对比全部跑挂。
    defaultModel: "claude-opus-4-7",
  },
};

/**
 * 用户传单个 model（旧用法）想横向对比时，常见的不兼容映射。
 * 当某 provider 不接受当前传入的 model slug 时，自动回退到其 defaultModel
 * 并给出一行 warning，避免静默跑出垃圾数据。
 *
 * 规则朴素：
 *  - claude-code 只接受 claude-* 前缀
 *  - sid-code 不限制（quota.ts 走 provider 注册表，未知 slug 会自己报错）
 */
function reconcileModelForProvider(providerType: string, model: string): { model: string; warned: boolean } {
  const reg = PROVIDER_REGISTRY[providerType];
  if (!reg) return { model, warned: false };
  if (providerType === "claude-code" && !model.startsWith("claude-")) {
    return { model: reg.defaultModel, warned: true };
  }
  return { model, warned: false };
}

function buildProvider(type: string, model: string | undefined): ProviderDef {
  const reg = PROVIDER_REGISTRY[type];
  if (!reg) throw new Error(`未知 provider 类型: ${type}，可选: ${Object.keys(PROVIDER_REGISTRY).join(", ")}`);
  const requested = model ?? reg.defaultModel;
  const { model: resolved, warned } = reconcileModelForProvider(type, requested);
  if (warned) {
    process.stderr.write(
      `[eval-runner] ⚠️  provider=${type} 不兼容 model=${requested}，回退到 ${resolved}。`
      + `如要强制使用 ${requested}，请改为只指定单一 provider 跑。\n`
    );
  }
  const modelSlug = resolved.replace(/[^a-zA-Z0-9]/g, "_");
  const { defaultModel: _ignored, ...rest } = reg;
  return { ...rest, name: `${type.replace(/-/g, "_")}_${modelSlug}`, model: resolved };
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

/**
 * 判定 provider 输出/stderr 是否为可重试的瞬时网络错误。
 * 只在网络错误时重试，业务错误（空输出 / parse_error / 模型拒绝）不重试避免污染数据。
 *
 * ⚠️ 已知边界：substring 匹配会有 false positive。
 *   - 模型输出里出现 "HTTP 502 是什么" / "issue #429" + wrapper 因其它原因 error → 会被误判可重试
 *   - 选型理由：宁可多 retry 不可漏 retry——多 retry 浪费几分钟，漏 retry 直接污染 baseline
 *   - 如要更严格，应该改为只检查 stderr（stderr 几乎只包含 wrapper 自身日志 + 子进程 stderr）
 *     当前仍检查 output 是因为部分 provider 把 HTTP 错误写到 stdout 的 [ERROR] 块里。
 */
export function isRetryableError(output: string, stderr: string): boolean {
  const combined = `${output}\n${stderr}`;
  const retryablePatterns = [
    "ECONNRESET",
    "ETIMEDOUT",
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "socket hang up",
    "fetch failed",
    "429",
    "503",
    "502",
    "504",
    "Internal Server Error",
    "Bad Gateway",
    "Service Unavailable",
    "Gateway Timeout",
    "Too Many Requests",
  ];
  return retryablePatterns.some(p => combined.includes(p));
}

export async function runProviderOnce(provider: ProviderDef, prompt: string, caseId: string): Promise<ProviderResult & { stderrTail: string }> {
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

  // stdout 上限：50MB。wrapper bug 或 LLM 输出失控时（曾观察到 ~MB 级 stream-json）
  // 防止 eval-runner 自身被拖到 OOM。超出立即 SIGKILL + 标记 error。
  const STDOUT_MAX = 50 * 1024 * 1024;
  let stdoutBuf = "";
  let stderrBuf = "";
  let stdoutOverflow = false;
  proc.stdout?.on("data", (c) => {
    if (stdoutOverflow) return;
    stdoutBuf += c.toString();
    if (stdoutBuf.length > STDOUT_MAX) {
      stdoutOverflow = true;
      process.stderr.write(`[eval-runner] stdout overflow >${STDOUT_MAX}B for ${caseId} × ${provider.name}, SIGKILL\n`);
      try { proc.kill("SIGKILL"); } catch { /* already exited */ }
    }
  });
  proc.stderr?.on("data", (c) => { stderrBuf += c.toString(); });

  // 外层 timeout 兜底：wrapper 自己有 timer，但如果 wrapper 在 spawn 之前
  // 就 hang（bun runtime 异常 / OOM 等），上面那个 Promise 永远不 resolve。
  // 外层加 timeoutMs + 30s buffer，强制 kill。
  const outerTimeoutMs = (provider.timeoutMs ?? 480_000) + 30_000;
  let outerTimedOut = false;
  const outerTimer = setTimeout(() => {
    outerTimedOut = true;
    process.stderr.write(`[eval-runner] OUTER TIMEOUT after ${outerTimeoutMs}ms for ${caseId} × ${provider.name}, SIGKILL\n`);
    try { proc.kill("SIGKILL"); } catch { /* already exited */ }
  }, outerTimeoutMs);

  const exitCode: number | null = await new Promise((res) => {
    proc.on("close", (code) => res(code));
    proc.on("error", () => res(null));
  });
  clearTimeout(outerTimer);

  if (stderrBuf) process.stderr.write(stderrBuf);

  const stderrTail = stderrBuf.slice(-2000);

  if (outerTimedOut) {
    return {
      output: `[ERROR] eval-runner OUTER TIMEOUT after ${outerTimeoutMs}ms`,
      meta: { tools_used: [], files_edited: [], total_steps: 0, total_tokens: 0, latency_ms: outerTimeoutMs, exit_status: "outer_timeout", error_count: 0, retry_count: 0, backtrack_count: 0 },
      error: true,
      stderrTail,
    };
  }

  if (stdoutOverflow) {
    return {
      output: `[ERROR] eval-runner stdout overflow >${STDOUT_MAX}B`,
      meta: { tools_used: [], files_edited: [], total_steps: 0, total_tokens: 0, latency_ms: 0, exit_status: "stdout_overflow", error_count: 0, retry_count: 0, backtrack_count: 0 },
      error: true,
      stderrTail,
    };
  }

  try {
    const result = JSON.parse(stdoutBuf.trim()) as ProviderResult;
    return { ...result, stderrTail };
  } catch {
    return {
      output: stdoutBuf || `[ERROR] provider exit=${exitCode}`,
      meta: { tools_used: [], files_edited: [], total_steps: 0, total_tokens: 0, latency_ms: 0, exit_status: "parse_error", error_count: 0, retry_count: 0, backtrack_count: 0 },
      error: true,
      stderrTail,
    };
  }
}

/**
 * Retry 与退避策略。
 * 改这两个常量时记得：
 * - main() 中预估耗时使用同一份计算
 * - 单 case 最坏耗时 = (DEFAULT_MAX_RETRIES + 1) × timeoutMs + 退避总和
 */
export const DEFAULT_MAX_RETRIES = 2;
function retryBackoffMs(attempt: number): number {
  // 指数退避基数 2s，倍数 4：2s → 8s → 32s
  return 2_000 * Math.pow(4, attempt);
}
/** 退避总和（用于耗时预估），与 retryBackoffMs 的实际触发次数一致 = DEFAULT_MAX_RETRIES 次 */
function totalBackoffMs(maxRetries: number): number {
  let total = 0;
  for (let i = 0; i < maxRetries; i++) total += retryBackoffMs(i);
  return total;
}

export async function runProvider(provider: ProviderDef, prompt: string, caseId: string, maxRetries = DEFAULT_MAX_RETRIES): Promise<ProviderResult> {
  let lastResult: ProviderResult & { stderrTail: string } | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await runProviderOnce(provider, prompt, caseId);
    lastResult = result;

    // 成功：直接返回
    if (!result.error) return stripStderr(result);

    // 不可重试错误：直接返回
    if (!isRetryableError(result.output, result.stderrTail)) return stripStderr(result);

    // 重试用尽：返回最后结果
    if (attempt === maxRetries) {
      process.stderr.write(`[eval-runner] ${caseId} × ${provider.name} retry exhausted (${attempt + 1}/${maxRetries + 1})\n`);
      return stripStderr(result);
    }

    const delayMs = retryBackoffMs(attempt);
    process.stderr.write(`[eval-runner] ${caseId} × ${provider.name} 第 ${attempt + 1}/${maxRetries + 1} 次失败（网络错误），${delayMs}ms 后重试\n`);
    await new Promise(r => setTimeout(r, delayMs));
  }
  // 不会到这里
  return stripStderr(lastResult!);
}

function stripStderr(r: ProviderResult & { stderrTail?: string }): ProviderResult {
  const { stderrTail: _ignore, ...rest } = r;
  return rest;
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

export function writeWeekScores(results: TestResult[], weekNum: number, baseDir: string = ROOT) {
  const scoresDir = join(baseDir, "_scores", `w${weekNum}`);
  mkdirSync(scoresDir, { recursive: true });

  const byCaseId = new Map<string, TestResult[]>();
  for (const r of results) {
    if (!byCaseId.has(r.caseId)) byCaseId.set(r.caseId, []);
    byCaseId.get(r.caseId)!.push(r);
  }

  for (const [caseId, caseResults] of byCaseId) {
    // 用 case 实际完成时间（多 provider 同 case 时取最晚的，避免误导）
    const latestTested = caseResults.reduce(
      (acc, r) => (r.testedAt > acc ? r.testedAt : acc),
      caseResults[0]?.testedAt ?? new Date().toISOString(),
    );
    const doc: Record<string, unknown> = { tested_at: latestTested };
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
export function appendRunHistory(results: TestResult[], runId: string, weekNum: number, baseDir: string = ROOT) {
  const runsDir = join(baseDir, "_runs");
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
        // 单 case 实际完成时间，与整批 run_id 分开。趋势图按 tested_at 画。
        tested_at: r.testedAt,
      }));
    }
    appendFileSync(filePath, lines.join("\n") + "\n", "utf-8");
  }
  console.log(`  运行历史: ${runsDir}/ (${byProvider.size} 个 provider × ${results.length / byProvider.size} 个 case)`);
}

function findCaseYamlPath(caseId: string, baseDir: string = ROOT): string | null {
  const dirs = [
    join(baseDir, "p0-core"),
    join(baseDir, "p1-common"),
    join(baseDir, "p2-edge"),
    join(baseDir, "holdout"),
  ];
  for (const dir of dirs) {
    const p = join(dir, `${caseId}.yaml`);
    if (existsSync(p)) return p;
  }
  return null;
}

export function syncBaselineScores(results: TestResult[], baseDir: string = ROOT) {
  const byCaseId = new Map<string, TestResult[]>();
  for (const r of results) {
    if (!byCaseId.has(r.caseId)) byCaseId.set(r.caseId, []);
    byCaseId.get(r.caseId)!.push(r);
  }

  let updated = 0;
  for (const [caseId, caseResults] of byCaseId) {
    const yamlPath = findCaseYamlPath(caseId, baseDir);
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
        tested_at: r.testedAt,
        tested_by: "eval-runner",
        transcript_path: null,
        notes: isTimeout ? "eval-runner 超时" : "",
        dimensions: r.namedScores,
        // 公式版本：让后续工具/人能一眼区分新旧 baseline
        // 同一 case 同一 provider 的 cost 维度跨版本不可直接比较
        _formula_version: { cost: COST_FORMULA_VERSION },
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
      // model 默认 undefined → buildProvider 用 provider 各自的 defaultModel
      // （sid-code → deepseek-v4-pro，claude-code → claude-opus-4-7）。
      // 显式指定 --model 会传给全部 provider；若与某 provider 不兼容会自动回退并 warning。
      model: { type: "string" },
      concurrency: { type: "string", default: "2" },
      output: { type: "string", default: "evals/_reports/eval-latest.json" },
      week: { type: "string" },
      "skip-holdout": { type: "boolean", default: true },
      "include-holdout": { type: "boolean", default: false },
      "skip-llm-judge": { type: "boolean", default: false },
      // sync 默认 off：避免调试单 case 时污染 case yaml 的 baseline_scores（diff 噪声 + git 历史污染）。
      // 跑正式 baseline / 横向对比时，显式加 --sync 才回写。
      "sync": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
    strict: false,
  });

  const providerTypes = (values.provider as string).split(",").map(s => s.trim());
  const model = values.model as string | undefined;
  const providers = providerTypes.map(t => buildProvider(t, model));

  const caseFilter = values.cases ? (values.cases as string).split(",").map(s => s.trim()) : undefined;
  const concurrency = parseInt(values.concurrency as string, 10) || 2;
  const skipLlmJudge = values["skip-llm-judge"] as boolean;
  const doSync = values["sync"] as boolean;
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
  console.log(`  provider: ${providers.map(p => `${p.name}(model=${p.model})`).join(", ")}`);
  console.log(`  并发: ${concurrency} | LLM judge: ${skipLlmJudge ? "跳过" : "启用"} | week: w${weekNum}`);

  // 时长预估：单 case 最坏 = (DEFAULT_MAX_RETRIES+1) × timeoutMs + totalBackoff
  // 全批最坏 = ceil(总组合数 / 并发) × 单 case 最坏
  // 一旦超过 2h，cron 任务（如 trajectory-dashboard 的 0 4 * * *）会被截断 → 直接告警
  const PER_CASE_TIMEOUT_MS = providers[0]?.timeoutMs ?? 480_000;
  const worstSingleMs = (DEFAULT_MAX_RETRIES + 1) * PER_CASE_TIMEOUT_MS + totalBackoffMs(DEFAULT_MAX_RETRIES);
  const totalCombos = cases.length * providers.length;
  const worstTotalMs = Math.ceil(totalCombos / concurrency) * worstSingleMs;
  const worstHours = (worstTotalMs / 3_600_000).toFixed(1);
  const expectedHours = (worstTotalMs / 3_600_000 / 3).toFixed(1); // 假设平均 1/3 最坏
  console.log(`  预估耗时: ~${expectedHours}h 正常 / ${worstHours}h 最坏（全部 retry 用尽 + 全 timeout）`);
  if (worstTotalMs > 2 * 3_600_000) {
    console.log(`  ⚠️  最坏耗时 ${worstHours}h > 2h，可能超过 cron 窗口。考虑：`);
    console.log(`     - 提高并发: --concurrency ${Math.min(8, concurrency * 2)}`);
    console.log(`     - 拆分批次: 用 --cases 分多次跑`);
    console.log(`     - 减少 case: 加 --skip-holdout（默认已开）`);
  }
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
        const completedAt = new Date().toISOString();
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
          testedAt: completedAt,
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
          testedAt: new Date().toISOString(),
        });
      }
    }))
  );

  await Promise.all(tasks);
  const totalElapsed = Date.now() - startTime;

  const output = {
    version: 2,
    timestamp: new Date().toISOString(),
    config: {
      cases: cases.map(c => c.id),
      providers: providers.map(p => ({ name: p.name, model: p.model })),
      // model 字段保留为兼容性占位（旧 dashboard 读这个）。多 provider 不同 model 时取第一个。
      model: providers[0]?.model ?? null,
      concurrency,
      week: weekNum,
    },
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

  if (doSync) {
    syncBaselineScores(results);
  } else {
    console.log("  跳过 baseline_scores 回写（默认行为；加 --sync 显式开启）");
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

if (import.meta.main) {
  main().catch((err) => {
    console.error("[eval-runner] fatal:", err);
    process.exit(1);
  });
}
