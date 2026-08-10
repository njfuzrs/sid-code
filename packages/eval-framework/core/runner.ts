#!/usr/bin/env bun

import { resolve, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import * as yamlLib from "yaml";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import {
  aggregate,
  makeErrorDims,
  calcBillable,
  COST_FORMULA_VERSION,
  GRADER_VERSION,
  type DimScore,
  type AgentMeta,
  type TokenBreakdown,
} from "./judge.ts";
import type { CaseYaml } from "./types.ts";
import { getGrader } from "../graders/index.ts";
import {
  syncBaselineScores as syncBaselineScoresShared,
  type BaselineResult,
} from "./baseline-sync.ts";

const ROOT = resolve(import.meta.dir, "..");
const CASE_DIRS = [
  join(ROOT, "general", "p0-core"),
  join(ROOT, "general", "p1-common"),
  join(ROOT, "general", "p2-edge"),
  join(ROOT, "general", "execution"),
];
const HOLDOUT_DIR = join(ROOT, "holdout");
const ARCHITECTURE_ROOT = join(ROOT, "architecture");
const HOLDOUT_ARCHITECTURE_ROOT = join(ROOT, "holdout", "architecture");
const REAL_TASKS_ROOT = join(ROOT, "real-tasks");
const HOLDOUT_REAL_TASKS_ROOT = join(ROOT, "holdout", "real-tasks");

/**
 * 动态发现 `evals/architecture/<sub>/` 下所有子目录。
 * S1-T01 起 architecture/ 下有 redline / form / kernel / ... 18 个子目录，
 * 每个子目录都是 case 容器；用动态扫描避免每加一类都改硬编码常量。
 */
function discoverArchitectureSubDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  const dirs: string[] = [];
  for (const entry of require("node:fs").readdirSync(root)) {
    const p = join(root, entry);
    if (require("node:fs").statSync(p).isDirectory()) dirs.push(p);
  }
  return dirs;
}

/**
 * 动态发现 `evals/real-tasks/<cat>/` 下所有子目录（B6-2/3）。
 * scripts/ 子目录存 setup_*.sh，不属于 case 桶。
 */
function discoverRealTasksSubDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  const dirs: string[] = [];
  for (const entry of require("node:fs").readdirSync(root)) {
    if (entry === "scripts") continue;
    const p = join(root, entry);
    if (require("node:fs").statSync(p).isDirectory()) dirs.push(p);
  }
  return dirs;
}

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
  /**
   * 总分；null 表示无可评分数据（wrapper 完全失败，所有维度跳过）。
   * 调用方读 baseline/run 时应区分：null = "无法测"，0 = "测了但 0 分"。
   */
  score: number | null;
  /** 各维度分数；null 表示该维度被跳过（数据缺失 / judge 不可用） */
  namedScores: Record<string, number | null>;
  dims: Record<string, DimScore>;
  response: { output: string };
  latencyMs: number;
  success: boolean;
  /** run_status：success / error / timeout / abnormal —— 与 _runs 和 baseline 共用 */
  runStatus: string;
  /** 单 case 实际跑完时间（ISO 字符串）—— 与整批 runId 不同，趋势图按这个画 */
  testedAt: string;
  /**
   * A3-1 / F-1：mandatoryPass — binary_redline grader 一票否决结果。
   *
   * 来源：
   *   - binary_redline grader：当任一红线规则违反或任一规则 abnormal（API key 缺失等 fail-safe 路径）→ false
   *   - 其它 grader（rubric_5d / structured_arch / execution_test）：默认 true（不参与一票否决语义）
   *
   * 用途：dashboard / weekly-report 用此字段单独统计"红线击穿率"，不与 score=0 混淆。
   *   旧实现：mandatoryPass=false 时 score=0；与"5 维 grader 实测打了 0 分"的 case 在 jsonl/baseline 完全
   *           无法区分。M3 Go/No-Go 条件 1 "Layer 1 红线全 pass" 因此无法用现有数据验证。
   *   新实现：mandatoryPass 字段独立落 _runs/*.jsonl + baseline_scores，红线击穿在数据层面变得可见。
   *
   * 详见：ADR-027、`docs/eval/评测系统和迭代流程的可靠性和安全性报告.md` §Grader 公式合理性 H-1
   */
  mandatoryPass: boolean;
  /**
   * A3-1 / F-1：grader 类型 — 来自 grader.type（rubric_5d / binary_redline / structured_arch / execution_test）。
   *
   * 用途：dashboard 按 grader 分类统计；跨 grader 版本号变化时的过滤维度（与 _formula_version.grader 配套）。
   */
  graderType: string;
  /**
   * 原始 token / step 元数据（来自 wrapper meta）。可选——error / timeout 时缺失。
   * 落 _runs/*.jsonl，便于事后做"provider 在 case_X 上的 median token 消耗"等分析，
   * 不再只能 grep dims.cost.reason 字符串提取（脆弱）。
   *
   * 注意：billable_tokens 是经 cache_read 折算后的等价 input token（与 gradeCost 同口径），
   * total_tokens 是 wrapper 上报的原始 sum（不折算），两者按需取用。
   */
  meta?: {
    total_tokens: number;
    total_steps: number;
    billable_tokens: number | null;
    token_breakdown?: TokenBreakdown;
  };
}

interface ProviderRegistryEntry {
  script: string;
  defaultModel: string;
  timeoutMs: number;
  maxTurns: number;
  constraints?: { modelPrefix?: string };
}

function loadProviderRegistry(): Record<string, ProviderRegistryEntry> {
  const configPath = join(ROOT, "eval.config.yaml");
  if (!existsSync(configPath)) {
    throw new Error(`eval.config.yaml 不存在: ${configPath}\n请创建配置文件或检查 evals/ 目录`);
  }
  const raw = readFileSync(configPath, "utf-8");
  const config = parseYaml(raw) as { providers: Record<string, { script: string; default_model: string; timeout_ms?: number; max_turns?: number; constraints?: { model_prefix?: string } }> };
  if (!config?.providers || typeof config.providers !== "object") {
    throw new Error(`eval.config.yaml 格式错误: 缺少 providers 字段`);
  }
  const registry: Record<string, ProviderRegistryEntry> = {};
  for (const [name, def] of Object.entries(config.providers)) {
    if (!def.script || !def.default_model) {
      throw new Error(`eval.config.yaml: provider "${name}" 缺少 script 或 default_model`);
    }
    registry[name] = {
      script: resolve(ROOT, def.script),
      defaultModel: def.default_model,
      timeoutMs: def.timeout_ms ?? 480_000,
      maxTurns: def.max_turns ?? 30,
      constraints: def.constraints ? { modelPrefix: def.constraints.model_prefix } : undefined,
    };
  }
  return registry;
}

const PROVIDER_REGISTRY = loadProviderRegistry();

/**
 * 校验 provider 是否兼容指定 model。不兼容直接抛错退出，不做静默 fallback。
 *
 * 旧实现（已废弃）：claude-code + 非 claude-* model 时静默回退到 defaultModel，
 * 然后两个 provider 的 baseline 同时写入 case yaml，看起来像"同一次跑的横向对比"，
 * 实际跑的是两个不同 model（fail-fast 准则）。
 *
 * 现在：要求用户显式拆成多次跑（一次一个 provider）或传 provider 各自的 model。
 * 通过两种方式：
 *   1. 单 provider 模式：bun run eval:run --provider claude-code --model claude-opus-4-7
 *   2. 多 provider 模式不传 --model：buildProvider 用各自的 defaultModel
 */
function validateModelForProvider(providerType: string, model: string): void {
  const reg = PROVIDER_REGISTRY[providerType];
  if (!reg) return;
  const prefix = reg.constraints?.modelPrefix;
  if (prefix && !model.startsWith(prefix)) {
    throw new Error(
      `provider=${providerType} 不兼容 model=${model}（要求前缀 "${prefix}"）。\n`
      + `  解决方法：\n`
      + `    1. 拆成两次跑：先 --provider sid-code --model ${model}，再 --provider ${providerType} --model ${prefix}<X>\n`
      + `    2. 多 provider 时不传 --model：各自用 defaultModel`
    );
  }
}

function buildProvider(type: string, model: string | undefined): ProviderDef {
  const reg = PROVIDER_REGISTRY[type];
  if (!reg) throw new Error(`未知 provider 类型: ${type}，可选: ${Object.keys(PROVIDER_REGISTRY).join(", ")}`);
  const resolved = model ?? reg.defaultModel;
  validateModelForProvider(type, resolved);
  const modelSlug = resolved.replace(/[^a-zA-Z0-9]/g, "_");
  return {
    script: reg.script,
    timeoutMs: reg.timeoutMs,
    maxTurns: reg.maxTurns,
    name: `${type.replace(/-/g, "_")}_${modelSlug}`,
    model: resolved,
  };
}

async function loadCases(
  caseFilter?: string[],
  opts: { skipHoldout?: boolean; includeHoldout?: boolean; casesDir?: string } = {},
): Promise<CaseYaml[]> {
  const { skipHoldout = true, includeHoldout = false, casesDir } = opts;
  const wantSet = caseFilter ? new Set(caseFilter) : null;
  const cases: CaseYaml[] = [];

  // --cases-dir 模式：只扫指定目录（含子目录），跳过默认的 general/architecture/holdout 逻辑
  if (casesDir) {
    const absDir = resolve(casesDir);
    if (!existsSync(absDir)) {
      throw new Error(`--cases-dir 指定的目录不存在: ${absDir}`);
    }
    const dirsToScan = [absDir];
    // 递归发现子目录
    for (const entry of require("node:fs").readdirSync(absDir)) {
      const p = join(absDir, entry);
      if (require("node:fs").statSync(p).isDirectory()) dirsToScan.push(p);
    }
    for (const dir of dirsToScan) {
      const files = await Array.fromAsync(new Bun.Glob("*.yaml").scan(dir));
      for (const f of files) {
        const content = await Bun.file(join(dir, f)).text();
        const c = parseYaml(content) as CaseYaml;
        if (wantSet && !wantSet.has(c.id)) continue;
        cases.push(c);
      }
    }
    return cases.sort((a, b) => a.id.localeCompare(b.id));
  }

  // 默认行为：扫描 general (P0/P1/P2) + architecture/<sub>/ 所有子目录 + 过滤 holdout=true 标记。
  // includeHoldout=true 时，额外扫描 evals/holdout/ + evals/holdout/architecture/<sub>/，且不再过滤 holdout 标记。
  // 注意：单独传 --cases case_004（在 holdout 目录里）的情况，
  // 会通过下面的 holdout 目录扫描分支拿到（即便 includeHoldout=false 也允许显式指定）。
  const dirsToScan = [...CASE_DIRS, ...discoverArchitectureSubDirs(ARCHITECTURE_ROOT), ...discoverRealTasksSubDirs(REAL_TASKS_ROOT)];
  const explicitlyAskedHoldoutId = wantSet ? hasHoldoutId(wantSet) : false;
  if (includeHoldout || explicitlyAskedHoldoutId) {
    dirsToScan.push(HOLDOUT_DIR);
    dirsToScan.push(...discoverArchitectureSubDirs(HOLDOUT_ARCHITECTURE_ROOT));
    dirsToScan.push(...discoverRealTasksSubDirs(HOLDOUT_REAL_TASKS_ROOT));
  }

  for (const dir of dirsToScan) {
    if (!existsSync(dir)) continue;
    const files = await Array.fromAsync(new Bun.Glob("*.yaml").scan(dir));
    for (const f of files) {
      const content = await Bun.file(join(dir, f)).text();
      const c = parseYaml(content) as CaseYaml;
      // case 在 holdout 目录/子树 或带 holdout=true 标记 → 视为 holdout
      const isHoldout =
        dir === HOLDOUT_DIR ||
        dir.startsWith(HOLDOUT_ARCHITECTURE_ROOT) ||
        c.holdout === true;
      if (isHoldout && skipHoldout && !includeHoldout && !(wantSet && wantSet.has(c.id))) continue;
      if (wantSet && !wantSet.has(c.id)) continue;
      cases.push(c);
    }
  }
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

function hasHoldoutId(want: Set<string>): boolean {
  if (existsSync(HOLDOUT_DIR)) {
    for (const id of want) {
      if (existsSync(join(HOLDOUT_DIR, `${id}.yaml`))) return true;
    }
  }
  // architecture holdout 子目录: evals/holdout/architecture/<sub>/<case>.yaml
  for (const sub of discoverArchitectureSubDirs(HOLDOUT_ARCHITECTURE_ROOT)) {
    for (const id of want) {
      if (existsSync(join(sub, `${id}.yaml`))) return true;
    }
  }
  return false;
}

/**
 * 判定 provider 输出/stderr 是否为可重试的瞬时网络错误。
 *
 * v2（审查 #9）：只检查 stderr 不扫 stdout。
 * 旧实现扫 stdout 会把 agent 输出里出现 "HTTP 502 是什么" / "issue #429" 的回答
 * 误判为可重试，触发无声重试，最终用另一次 attempt 的结果污染数据。
 * wrapper 自己已经把 HTTP 错误写到 stderr 和 [ERROR] 块，stdout 主要是 agent 答案文本。
 *
 * 同时检查 output 但只看 [ERROR] 前缀（不扫整段）—— wrapper 的错误标记格式固定，安全。
 */
export function isRetryableError(output: string, stderr: string): boolean {
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
  // 只扫 stderr 和 output 的 [ERROR]/[TIMEOUT] 前缀块（前 500 字符），避免 agent 长输出里
  // 的关键字误命中。wrapper 的错误信号都在 [ERROR] 块的开头。
  const errorPrefix = output.startsWith("[ERROR]") || output.startsWith("[TIMEOUT]") ? output.slice(0, 500) : "";
  const haystack = `${errorPrefix}\n${stderr}`;
  return retryablePatterns.some(p => haystack.includes(p));
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

  // stdout/stderr 上限：50MB / 5MB。wrapper bug 或 LLM 输出失控时（曾观察到 ~MB 级 stream-json）
  // 防止 eval-runner 自身被拖到 OOM。超出立即 SIGKILL + 标记 error。
  // stderr 单独限：上限更小（5MB 已足够装 wrapper 自己的日志），过大说明子进程 console.error 死循环。
  const STDOUT_MAX = 50 * 1024 * 1024;
  const STDERR_MAX = 5 * 1024 * 1024;
  let stdoutBuf = "";
  let stderrBuf = "";
  let stdoutOverflow = false;
  let stderrOverflow = false;
  proc.stdout?.on("data", (c) => {
    if (stdoutOverflow) return;
    stdoutBuf += c.toString();
    if (stdoutBuf.length > STDOUT_MAX) {
      stdoutOverflow = true;
      process.stderr.write(`[eval-runner] stdout overflow >${STDOUT_MAX}B for ${caseId} × ${provider.name}, SIGKILL\n`);
      try { proc.kill("SIGKILL"); } catch { /* already exited */ }
    }
  });
  proc.stderr?.on("data", (c) => {
    if (stderrOverflow) return;
    stderrBuf += c.toString();
    if (stderrBuf.length > STDERR_MAX) {
      stderrOverflow = true;
      // 截尾保留头部（更可能定位首次错误），避免后续覆盖
      stderrBuf = stderrBuf.slice(0, STDERR_MAX) + `\n[eval-runner] stderr overflow truncated at ${STDERR_MAX}B\n`;
      process.stderr.write(`[eval-runner] stderr overflow >${STDERR_MAX}B for ${caseId} × ${provider.name}, SIGKILL\n`);
      try { proc.kill("SIGKILL"); } catch { /* already exited */ }
    }
  });

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

  if (stderrOverflow) {
    return {
      output: `[ERROR] eval-runner stderr overflow >${STDERR_MAX}B (子进程 console.error 失控?)`,
      meta: { tools_used: [], files_edited: [], total_steps: 0, total_tokens: 0, latency_ms: 0, exit_status: "stderr_overflow", error_count: 0, retry_count: 0, backtrack_count: 0 },
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

/**
 * 判定一次跑分是否属于"完全失败"——直接走 null 评分，跳过所有维度。
 *
 * 修复审查 #1 + #14：
 *   旧实现：error/timeout case 仍走 gradeCase，partial trajectory 让 eff=1, cost=0.7，
 *   total_tokens=0 + mustCallTools 为空时 tool 兜底给 1.0 → 总分能虚高到 1.07~3.64。
 *
 *   新实现：检测三种"完全失败"信号，命中任一就强制所有维度 null：
 *   1. result.error === true（wrapper 自己标了 error）
 *   2. output 以 [ERROR] 或 [TIMEOUT] 开头（wrapper 错误信号）
 *   3. exit_status ∈ {timeout, error, abnormal_stdout, parse_error, stdout_overflow, stderr_overflow, outer_timeout}
 */
const FAILED_EXIT_STATUSES = new Set([
  "timeout",
  "error",
  "abnormal_stdout",
  "parse_error",
  "stdout_overflow",
  "stderr_overflow",
  "outer_timeout",
]);

/**
 * 生成 stub ProviderResult，用于 requiresAgentOutput=false 的 grader（如 structured_arch）。
 *
 * 设计：static grader 不依赖 agent 输出，让 runner 跳过 spawn agent，直接用 stub 喂 grader。
 *       避免长描述题面让 agent 真去 ls/read 文件超时（meta_001/003 案例）。
 *       stub 标记 exit_status=static_grader_skip，便于 jsonl 落盘后追溯。
 */
function makeStubProviderResult(caseId: string): ProviderResult {
  return {
    output: `[STATIC_GRADER_SKIP] case=${caseId} 走 grader.requiresAgentOutput=false 路径，未 spawn agent`,
    meta: {
      tools_used: [],
      files_edited: [],
      total_steps: 0,
      total_tokens: 0,
      latency_ms: 0,
      exit_status: "static_grader_skip",
      error_count: 0,
      retry_count: 0,
      backtrack_count: 0,
    },
    error: false,
  };
}

export function isCompleteFailure(result: ProviderResult): { failed: boolean; reason: string } {
  // static_grader_skip 是合法路径（structured_arch 不需要 agent），不算 failure
  if (result.meta?.exit_status === "static_grader_skip") return { failed: false, reason: "" };
  if (result.error === true) return { failed: true, reason: `wrapper error=true (exit_status=${result.meta.exit_status})` };
  const out = result.output ?? "";
  if (out.startsWith("[ERROR]")) return { failed: true, reason: `output 以 [ERROR] 开头: ${out.slice(0, 100)}` };
  if (out.startsWith("[TIMEOUT]")) return { failed: true, reason: `output 以 [TIMEOUT] 开头: ${out.slice(0, 100)}` };
  if (FAILED_EXIT_STATUSES.has(result.meta.exit_status)) {
    return { failed: true, reason: `exit_status=${result.meta.exit_status}` };
  }
  return { failed: false, reason: "" };
}

/**
 * 把 ProviderResult 的 status 归一化为 _runs / baseline 共用的 runStatus 字符串。
 * 与 isCompleteFailure 配套，确保 score / runStatus 一致。
 */
export function classifyRunStatus(result: ProviderResult, failure: { failed: boolean }): string {
  if (!failure.failed) return "success";
  const status = result.meta.exit_status;
  if (status === "timeout" || status === "outer_timeout") return "timeout";
  if (status === "abnormal_stdout" || status === "parse_error") return "abnormal";
  return "error";
}

async function gradeCase(
  c: CaseYaml,
  result: ProviderResult,
  skipLlmJudge: boolean,
  judgeSamples: number,
): Promise<{
  score: number | null;
  namedScores: Record<string, number | null>;
  dims: Record<string, DimScore>;
  graderType: string;
  mandatoryPass: boolean;
}> {
  // T-10: 通过注册表调度 grader（默认 rubric_5d，向后兼容）。
  // case yaml 的 grader_type 字段决定使用哪个 Grader 实例：
  //   - 缺失 → rubric_5d（现有 30 条 general case 行为不变）
  //   - "binary_redline" → 红线一票否决
  //   - "structured_arch" → 架构断言（纯文件系统检查）
  const grader = getGrader(c.grader_type);
  const r = await grader.grade({
    caseYaml: c,
    providerResult: result,
    skipLlmJudge,
    judgeSamples,
  });
  return {
    score: r.score,
    namedScores: r.namedScores,
    dims: r.dims,
    graderType: r.graderType,
    mandatoryPass: r.mandatoryPass,
  };
}

/**
 * 单 (case, provider) 多次采样后的中位数聚合。
 *
 * 设计决策：
 *   - **每维度独立取中位数**，而不是直接对总分取中位数。
 *     原因：rubric 跨次跳变（0↔1）只影响 rubric 维度，不应该污染 anchor/tool/cost。
 *     对每维度独立取中位数后再 aggregate，能保留各维度真实分布信息。
 *   - 中位数偶数项时取下中位数（lower median），不平均——保证最终 score 仍是档位制可观测值。
 *     例：rubric 4 次采样 [0, 0.85, 0.95, 1.0] → 中位数取下中位 0.85（不是均值 0.7）
 *   - score===null 的样本（wrapper 失败）从中位数集合中剔除；
 *     若 ≥半数样本 null，该维度判定为 null（"该维度多数次没法测"）；否则用剩余样本的中位数。
 *   - reason 取被选中那次（中位数对应的 sample index）的 reason，便于追溯。
 *
 * @param sampleDims N 次采样的 dims 数组，长度 = samples
 * @returns 聚合后的单次 dims（结构与单次跑结果相同）
 */
export function aggregateSamples(sampleDims: Array<Record<string, DimScore>>): Record<string, DimScore> {
  if (sampleDims.length === 0) return {};
  if (sampleDims.length === 1) return sampleDims[0];

  // 收集所有维度名（任何一个 sample 出现过的）
  const allDimNames = new Set<string>();
  for (const dims of sampleDims) {
    for (const k of Object.keys(dims)) allDimNames.add(k);
  }

  const merged: Record<string, DimScore> = {};
  for (const name of allDimNames) {
    const samples = sampleDims.map((d) => d[name]).filter((d) => d !== undefined);
    if (samples.length === 0) continue;

    const validSamples = samples.filter((s) => s.score !== null);
    // 严格多数样本有效才出分（> 50%），50% 有效率视为不可靠
    if (validSamples.length <= Math.floor(samples.length / 2)) {
      merged[name] = {
        pass: false,
        score: null,
        reason: `多数样本无可评数据（${samples.length - validSamples.length}/${samples.length} 为 null）`,
      };
      continue;
    }

    // 取下中位数：sort 升序后 idx = floor((n-1)/2)
    const sortedByScore = [...validSamples].sort((a, b) => (a.score as number) - (b.score as number));
    const medianIdx = Math.floor((sortedByScore.length - 1) / 2);
    const chosen = sortedByScore[medianIdx];
    const allScores = validSamples.map((s) => (s.score as number).toFixed(2)).join("/");
    merged[name] = {
      pass: chosen.pass,
      score: chosen.score,
      reason: `[median ${validSamples.length} samples: ${allScores}] ${chosen.reason}`,
    };
  }
  return merged;
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
    const filePath = join(scoresDir, `${caseId}.yaml`);

    // 修复：先读旧文件再 merge —— 单 provider 跑分时不能覆盖掉其它 provider 的旧快照。
    // 旧实现：writeFileSync 直接覆盖 → 跑 --provider sid-code 会让 claude_code_xxx 的数据消失。
    // 现在：保留磁盘上已有的其它 provider 字段，只覆盖本次 results 涉及的 provider。
    let existing: Record<string, unknown> = {};
    if (existsSync(filePath)) {
      try {
        const parsed = yamlLib.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown> | null;
        if (parsed && typeof parsed === "object") existing = parsed;
      } catch {
        // 旧文件损坏：忽略，按从头写处理（不阻断 eval 流程）
      }
    }

    // 用本次跑的最晚 tested_at 覆盖外层 tested_at —— 表示"此文件最后写入时间"
    const latestTested = caseResults.reduce(
      (acc, r) => (r.testedAt > acc ? r.testedAt : acc),
      caseResults[0]?.testedAt ?? new Date().toISOString(),
    );

    const doc: Record<string, unknown> = { ...existing, tested_at: latestTested };
    for (const r of caseResults) {
      const existingProviderData = existing[r.provider] as { score?: number | null } | undefined;
      doc[r.provider] = {
        // BUG-1 fix: 异常运行不覆盖已有好分数，保留磁盘上已有 score
        score: r.runStatus === "success" ? r.score : (existingProviderData?.score ?? null),
        run_status: r.runStatus,
        tested_at: r.testedAt,
        anchor: { score: r.namedScores.anchor_hit ?? null },
        llm: {
          score: r.namedScores.rubric_score ?? null,
          dimensions: r.namedScores,
        },
      };
    }
    writeFileSync(filePath, yamlLib.stringify(doc));
  }
  console.log(`  时序数据: ${scoresDir}/ (${byCaseId.size} 个 case)`);
}

/**
 * 从 wrapper ProviderResult.meta 提取需要落 _runs/*.jsonl 的字段。
 *
 * 落地原因：旧实现只存归一化后的 named_scores.cost（0~1），事后做"deepseek 在所有 case 上的 median
 * token 消耗"只能 grep dims.cost.reason 字符串，脆弱且不可靠。
 *
 * billable_tokens 复用 gradeCost 同口径的 calcBillable（应用 cache_read 折算），
 * 而 total_tokens 保留 wrapper 上报的原始 sum，两者按需取用。
 */
function extractMeta(meta: ProviderResult["meta"]): NonNullable<TestResult["meta"]> {
  return {
    total_tokens: meta.total_tokens,
    total_steps: meta.total_steps,
    billable_tokens: calcBillable(meta),
    token_breakdown: meta.token_breakdown,
  };
}

/**
 * 追加每次 run 的历史快照到 _runs/{provider}.jsonl —— 永不覆盖。
 *
 * 文件按 provider 切分，便于单 provider 趋势分析。
 * dashboard 读取这些 jsonl 画运行历史折线图。
 *
 * v2（审查 #1 + #10）：error/timeout/abnormal case 的 score 写 null（与 baseline 一致），
 * 不再写虚假的 1.07/3.17 数值。dashboard 用 run_status 过滤即可。
 */
export function appendRunHistory(
  results: TestResult[],
  runId: string,
  weekNum: number,
  baseDir: string = ROOT,
  /** 可选：raw samples（每次采样的原始记录），用 sample_index 标识，is_median=false */
  rawSamples?: Array<TestResult & { sampleIndex: number; isMedian: boolean }>,
) {
  const runsDir = join(baseDir, "_runs");
  mkdirSync(runsDir, { recursive: true });

  const byProvider = new Map<string, TestResult[]>();
  for (const r of results) {
    if (!byProvider.has(r.provider)) byProvider.set(r.provider, []);
    byProvider.get(r.provider)!.push(r);
  }

  // 把 rawSamples 也按 provider 分组（每条带 is_median=false 标识）
  const rawByProvider = new Map<string, typeof rawSamples>();
  if (rawSamples) {
    for (const r of rawSamples) {
      if (r.isMedian) continue; // median 已通过 results 写入
      if (!rawByProvider.has(r.provider)) rawByProvider.set(r.provider, []);
      rawByProvider.get(r.provider)!.push(r);
    }
  }

  for (const [provider, providerResults] of byProvider) {
    const filePath = join(runsDir, `${provider}.jsonl`);
    const lines: string[] = [];
    // 写 median / 单次 result（is_median: results 长度 = 1 单次跑则不显式标）
    for (const r of providerResults) {
      lines.push(JSON.stringify({
        run_id: runId,
        week: weekNum,
        case_id: r.caseId,
        provider: r.provider,
        // 与 baseline 一致：runStatus !== "success" 时 score 写 null
        score: r.runStatus === "success" ? r.score : null,
        named_scores: r.namedScores,
        latency_ms: r.latencyMs,
        success: r.success,
        run_status: r.runStatus,
        // A3-1：红线一票否决结果（binary_redline grader 的关键信号）+ grader 类型 + grader 版本
        // dashboard / weekly-report 用 mandatory_pass 单独统计红线击穿率，与 score=0 区分
        // grader_version：决策文档 §6 第 2 条收敛标准——legacy 数据隔离过滤器靠这个字段
        mandatory_pass: r.mandatoryPass,
        grader_type: r.graderType,
        grader_version: GRADER_VERSION,
        // 单 case 实际完成时间，与整批 run_id 分开。趋势图按 tested_at 画。
        tested_at: r.testedAt,
        // meta：原始 token / step 计数，事后分析用（不再依赖 grep dims.cost.reason）
        ...(r.meta ? { meta: r.meta } : {}),
        // B5-3 诊断：grader_reasons 落各维度 reason 文本（≤ 1KB 截断），事后无需 keepTmp 即可看 sandbox 跑出哪条命令 fail / exitCode 几 / 是否 timeout
        // 仅落非 pass 维度的 reason（pass=true 时省略，避免 jsonl 膨胀）
        grader_reasons: collectGraderReasons(r.dims),
        // is_median=true 当本批跑了 --samples > 1 后的中位数聚合；
        // dashboard 默认只读 is_median=true 或字段缺失（向后兼容单次跑）的行
        ...(rawSamples ? { is_median: true } : {}),
      }));
    }
    // 追加 raw samples（带 sample_index，is_median=false）
    const rawList = rawByProvider.get(provider) ?? [];
    for (const r of rawList) {
      lines.push(JSON.stringify({
        run_id: runId,
        week: weekNum,
        case_id: r.caseId,
        provider: r.provider,
        score: r.runStatus === "success" ? r.score : null,
        named_scores: r.namedScores,
        latency_ms: r.latencyMs,
        success: r.success,
        run_status: r.runStatus,
        // A3-1：raw sample 也落红线一票否决 + grader 类型 + grader 版本，事后追溯单次表现
        mandatory_pass: r.mandatoryPass,
        grader_type: r.graderType,
        grader_version: GRADER_VERSION,
        tested_at: r.testedAt,
        ...(r.meta ? { meta: r.meta } : {}),
        grader_reasons: collectGraderReasons(r.dims),
        sample_index: r.sampleIndex,
        is_median: false,
      }));
    }
    appendFileSync(filePath, lines.join("\n") + "\n", "utf-8");
  }
  console.log(`  运行历史: ${runsDir}/ (${byProvider.size} 个 provider × ${results.length / byProvider.size} 个 case)`);
}

/**
 * 收集各维度 reason 文本（B5-3 诊断字段）。
 *
 * 仅落非 pass 维度的 reason，pass=true 的维度省略——绝大多数情况下我们只关心 fail 原因。
 * 单条 reason 截到 1KB（4× ASCII 字符），整体最多 5 个维度，jsonl 最坏情况 ≈ 5KB——
 * 与 meta（token/step 计数）量级相当，不会让 jsonl 体积失控。
 *
 * 例：execution_test grader 失败时落
 *   { execution_check: "[1/1] ❌ bun logger.test.ts (exit=1, 234ms)\nFAIL: log file 缺失级别: debug1" }
 * 直接看就能定位是 sandbox 跑了 verify 命令但单测断言 fail，不需要 keepTmp 翻 tmpdir。
 */
function collectGraderReasons(dims: Record<string, DimScore>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  let hasAny = false;
  for (const [name, dim] of Object.entries(dims)) {
    if (!dim || dim.pass === true) continue;
    if (typeof dim.reason !== "string" || dim.reason.length === 0) continue;
    out[name] = dim.reason.length > 1000 ? dim.reason.slice(0, 1000) + "...(truncated)" : dim.reason;
    hasAny = true;
  }
  return hasAny ? out : undefined;
}

export function syncBaselineScores(results: TestResult[], baseDir: string = ROOT) {
  // 映射 TestResult → BaselineResult；general 模式按 ROOT 下 4 个目录扫
  // error / timeout 的 baseline score 写 null（不是数值 0、不是 ~2.5）。
  // 旧实现：error case 因为 3 个维度兜底 1.0、rubric 0、anchor 0 → 总分 ~2.5 落入 baseline，
  // dashboard 取均值时会把这 2.5 算进去，污染横向对比。
  // 现在：score=null + run_status=error，下游消费者用 run_status 过滤、score 仅对 success 有效。
  const baselineResults: BaselineResult[] = results.map((r) => ({
    caseId: r.caseId,
    provider: r.provider,
    score: r.score,
    runStatus: r.runStatus,
    testedAt: r.testedAt,
    dimensions: r.namedScores,
    // A3-1 / A3-2：mandatoryPass / graderType 落到 baseline_scores
    // dashboard 用 mandatory_pass 单独统计红线击穿率（与 score=0 区分）
    // grader_type 用于跨 grader 分类聚合，不与 _formula_version.grader 混淆（前者是 type 名，后者是版本号）
    mandatoryPass: r.mandatoryPass,
    graderType: r.graderType,
    // 公式版本：让后续工具/人能一眼区分新旧 baseline
    // 同一 case 同一 provider 的 cost 维度跨版本不可直接比较
    // grader 字段标识整体 5 维加权方案的版本（见 eval-judge.ts GRADER_VERSION docstring）
    // 跨 grader 版本的"总分 score"也不可直接比较——dashboard / 跨周对比要按此过滤
    formulaVersion: { cost: COST_FORMULA_VERSION, grader: GRADER_VERSION },
  }));

  syncBaselineScoresShared(baselineResults, {
    baseDir,
    testerLabel: "eval-runner",
  });
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      cases: { type: "string" },
      "cases-dir": { type: "string" },
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
      // judge-samples: LLM judge 同输出多次采样取中位数，用于在仍想覆盖 prompt 微扰时降方差。
      // temperature=0 + 档位制（rubric v3）已经足够稳，默认 1。
      // 跑 baseline / 横向对比时建议 --judge-samples=3，保险起见。
      "judge-samples": { type: "string", default: "1" },
      // samples: agent 自身跑 N 次取每维度中位数。
      // 与 judge-samples 区别：
      //   judge-samples 是"同一份 agent 输出 × N 次 judge"——只能对冲 judge 自身方差（已验证 stddev<0.05，意义不大）
      //   samples 是"同一份 case × N 次 agent"——对冲 agent 跨次输出波动（temperature>0 时同一 case 不同回答）
      // 默认 1 保持向后兼容；跑权威 baseline 建议 --samples=3 取中位数。
      "samples": { type: "string", default: "1" },
      // sync 默认行为：
      //   - 未指定 --cases（全量模式）：默认 on（baseline 必须刷新；不刷会让 dashboard 持续显示旧数据）
      //   - 指定 --cases（调试模式）：默认 off（避免单 case 调试污染 baseline_scores）
      // 显式 --sync 始终生效；显式 --no-sync 禁用回写
      // A1-4 / F-S2（2026-05-30）：评测系统报告"全量模式不 sync 会让 dashboard 滞后"
      "sync": { type: "boolean" },
      "no-sync": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      // 控制 refreshReports 失败是否让 eval-runner exit 非 0（CI 用）
      "strict-refresh": { type: "boolean", default: false },
    },
    strict: false,
  });

  const providerTypes = (values.provider as string).split(",").map(s => s.trim());
  const model = values.model as string | undefined;
  const providers = providerTypes.map(t => buildProvider(t, model));

  const caseFilter = values.cases ? (values.cases as string).split(",").map(s => s.trim()) : undefined;
  const concurrency = parseInt(values.concurrency as string, 10) || 2;
  const skipLlmJudge = values["skip-llm-judge"] as boolean;
  const judgeSamples = parseInt((values["judge-samples"] as string) || "1", 10) || 1;
  const samples = Math.max(1, parseInt((values["samples"] as string) || "1", 10) || 1);
  // A1-4：sync 默认值 — 全量模式自动 on；--cases 指定时默认 off；显式 --sync / --no-sync 覆盖默认
  const syncFlag = values["sync"] as boolean | undefined;
  const noSync = values["no-sync"] as boolean;
  let doSync: boolean;
  if (noSync) doSync = false;
  else if (syncFlag === true) doSync = true;
  else doSync = caseFilter === undefined; // 全量默认 on，单 case 默认 off
  const dryRun = values["dry-run"] as boolean;
  const strictRefresh = values["strict-refresh"] as boolean;
  const outputPath = resolve(ROOT, "..", values.output as string);
  const weekNum = values.week ? parseInt(values.week as string, 10) : currentWeekNumber();

  const cases = await loadCases(caseFilter, {
    skipHoldout: values["skip-holdout"] as boolean,
    includeHoldout: values["include-holdout"] as boolean,
    casesDir: values["cases-dir"] as string | undefined,
  });

  if (cases.length === 0) {
    console.error("未找到匹配的 case");
    process.exit(1);
  }

  console.log(`[eval-runner] ${cases.length} cases × ${providers.length} providers${samples > 1 ? ` × ${samples} samples` : ""} = ${cases.length * providers.length * samples} 次跑`);
  console.log(`  provider: ${providers.map(p => `${p.name}(model=${p.model})`).join(", ")}`);
  console.log(`  并发: ${concurrency} | LLM judge: ${skipLlmJudge ? "跳过" : `启用(judge-samples=${judgeSamples})`} | agent samples: ${samples}${samples > 1 ? "（每维度取中位数）" : ""} | week: w${weekNum}`);

  // 时长预估：单 case 最坏 = (DEFAULT_MAX_RETRIES+1) × timeoutMs + totalBackoff × samples
  // 全批最坏 = ceil(总组合数 / 并发) × 单 case 最坏 × samples
  // 一旦超过 2h，cron 任务（如 trajectory-dashboard 的 0 4 * * *）会被截断 → 直接告警
  const PER_CASE_TIMEOUT_MS = providers[0]?.timeoutMs ?? 480_000;
  const worstSingleMs = ((DEFAULT_MAX_RETRIES + 1) * PER_CASE_TIMEOUT_MS + totalBackoffMs(DEFAULT_MAX_RETRIES)) * samples;
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
  /** sampleResults：保留每次采样的中间数据，用于 --samples > 1 时写入 _runs（raw + median 都落盘）*/
  const sampleResults: Array<TestResult & { sampleIndex: number; isMedian: boolean }> = [];
  const startTime = Date.now();

  const tasks = cases.flatMap(c =>
    providers.map(p => limit(async () => {
      const taskStart = Date.now();
      const label = samples > 1 ? `${c.id} × ${p.name} (×${samples} samples)` : `${c.id} × ${p.name}`;
      console.log(`▶ ${label} ...`);

      try {
        // 多次采样：每次都跑一遍完整的 (provider, grade) 流程，收集 dims + 元数据
        const perSample: Array<{
          dims: Record<string, DimScore>;
          provResult: ProviderResult;
          runStatus: string;
          completedAt: string;
          mandatoryPass: boolean;
          graderType: string;
        }> = [];
        for (let i = 0; i < samples; i++) {
          // T-10.2 静态 grader 短路：requiresAgentOutput=false（如 structured_arch）的 case
          // 不需要 agent 输出，直接喂 stub ProviderResult 调 grader——避免 agent 在描述类
          // 题面上跑超时（meta_001/003 类长描述会让 agent 真去 ls/read 文件，超过 510s outer timeout）。
          const grader = getGrader(c.grader_type);
          const useStub = grader.requiresAgentOutput === false;
          const provResult = useStub
            ? makeStubProviderResult(c.id)
            : await runProvider(p, c.input.user_query, c.id);
          const grade = await gradeCase(c, provResult, skipLlmJudge, judgeSamples);
          const failure = isCompleteFailure(provResult);
          const runStatus = classifyRunStatus(provResult, failure);
          perSample.push({
            dims: grade.dims,
            provResult,
            runStatus,
            completedAt: new Date().toISOString(),
            mandatoryPass: grade.mandatoryPass,
            graderType: grade.graderType,
          });
          if (samples > 1) {
            const sScoreStr = grade.score === null ? `null（${runStatus}）` : String(grade.score);
            console.log(`  · sample ${i + 1}/${samples} = ${sScoreStr}`);
            // 把每次 sample 也加入 sampleResults（is_median=false），便于事后追溯单次表现
            sampleResults.push({
              caseId: c.id,
              provider: p.name,
              score: grade.score,
              namedScores: grade.namedScores,
              dims: grade.dims,
              response: { output: provResult.output },
              latencyMs: provResult.meta.latency_ms || (Date.now() - taskStart),
              success: !provResult.error,
              runStatus,
              testedAt: perSample[i].completedAt,
              mandatoryPass: grade.mandatoryPass,
              graderType: grade.graderType,
              meta: extractMeta(provResult.meta),
              sampleIndex: i,
              isMedian: false,
            });
          }
        }

        // 聚合：samples=1 → 直接用唯一一次的 dims；samples>1 → 每维度独立取中位数
        const mergedDims = samples > 1
          ? aggregateSamples(perSample.map((s) => s.dims))
          : perSample[0].dims;
        const { score, namedScores } = aggregate(mergedDims);

        // runStatus 用"多数派"：多次跑都失败才算 error；只要 ≥半数成功就算 success
        const successCount = perSample.filter((s) => s.runStatus === "success").length;
        const majorityRunStatus = successCount >= Math.ceil(samples / 2) ? "success" : perSample[perSample.length - 1].runStatus;
        // output / latency 取最后一次的（用于 _reports 展示，中位数维度已在 dims 里）
        const lastSample = perSample[perSample.length - 1];

        const elapsed = Date.now() - taskStart;
        const completedAt = new Date().toISOString();
        const emoji =
          score === null ? "⚪"
          : score >= 4.5 ? "✅"
          : score >= 3.5 ? "🟢"
          : score >= 2.5 ? "🟡"
          : "🔴";
        const scoreStr = score === null ? `null（${majorityRunStatus}）` : String(score);
        const sampleNote = samples > 1 ? ` [中位数 of ${samples}]` : "";
        // mandatoryPass 聚合：红线类用 AND（一票否决），其他类用多数派
        const mandatoryPassCount = perSample.filter((s) => s.mandatoryPass).length;
        const aggregatedGraderType = lastSample.graderType;
        const aggregatedMandatoryPass = aggregatedGraderType === "binary_redline"
          ? perSample.every((s) => s.mandatoryPass)
          : mandatoryPassCount >= Math.ceil(samples / 2);
        console.log(`  ${emoji} ${c.id} × ${p.name} = ${scoreStr}${sampleNote} (${(elapsed / 1000).toFixed(1)}s)`);

        const finalResult: TestResult = {
          caseId: c.id,
          provider: p.name,
          score,
          namedScores,
          dims: mergedDims,
          response: { output: lastSample.provResult.output },
          latencyMs: lastSample.provResult.meta.latency_ms || elapsed,
          success: majorityRunStatus === "success",
          runStatus: majorityRunStatus,
          testedAt: completedAt,
          mandatoryPass: aggregatedMandatoryPass,
          graderType: aggregatedGraderType,
          // samples > 1 时取最后一次的 meta（与 output / latency 同源；中位数维度已聚合在 dims 里）
          // 注意：billable/total_tokens 不是中位数，事后做精细分析用 sampleResults 里的 raw 行
          meta: extractMeta(lastSample.provResult.meta),
        };
        results.push(finalResult);
        if (samples > 1) {
          sampleResults.push({ ...finalResult, sampleIndex: -1, isMedian: true });
        }
      } catch (err) {
        // 单个 case 失败不能拖垮整批：记录降级结果，let 整体继续。
        // crash 时 score 写 null（不是 0）—— 区别"测了但 0 分"与"压根没测".
        const elapsed = Date.now() - taskStart;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.log(`  ⚠️  ${c.id} × ${p.name} = ERROR (${(elapsed / 1000).toFixed(1)}s): ${errMsg.slice(0, 120)}`);
        const dims = makeErrorDims(`eval-runner task crash: ${errMsg.slice(0, 200)}`);
        const { score, namedScores } = aggregate(dims);
        results.push({
          caseId: c.id,
          provider: p.name,
          score,
          namedScores,
          dims,
          response: { output: `[ERROR] eval-runner task crash: ${errMsg}` },
          latencyMs: elapsed,
          success: false,
          runStatus: "error",
          testedAt: new Date().toISOString(),
          // crash 时无法判定红线 pass/fail —— fail-safe 视为击穿（与 binary-redline-grader abnormal 路径一致）
          mandatoryPass: false,
          graderType: c.grader_type ?? "rubric_5d",
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
      cost_formula_version: COST_FORMULA_VERSION,
      grader_version: GRADER_VERSION,
    },
    results: {
      timestamp: new Date().toISOString(),
      results: results.map(r => {
        // score === null（wrapper 完全挂掉）→ 报表里把 score 写 0、pass=false，但保留 success=false 区分
        // 真实分数留在 namedScores 里（也都是 null），消费者用 success 字段过滤
        const reportedScore = r.score === null ? 0 : r.score / 5;
        const pass = r.score !== null && r.score >= 3.0;
        return {
          cost: 0,
          latencyMs: r.latencyMs,
          provider: { id: r.provider, label: r.provider },
          response: r.response,
          score: reportedScore,
          success: r.success,
          runStatus: r.runStatus,
          namedScores: r.namedScores,
          testCase: { vars: { case_id: r.caseId }, description: r.caseId },
          gradingResult: {
            pass,
            score: reportedScore,
            namedScores: r.namedScores,
            componentResults: Object.entries(r.dims).map(([metric, dim]) => ({
              assertion: { type: "custom", metric },
              pass: dim.pass,
              score: dim.score,
              reason: dim.reason,
            })),
          },
        };
      }),
    },
    stats: { totalMs: totalElapsed, count: results.length },
  };

  await Bun.write(outputPath, JSON.stringify(output, null, 2));

  const runId = output.timestamp;
  appendRunHistory(results, runId, weekNum, ROOT, samples > 1 ? sampleResults : undefined);
  writeWeekScores(results, weekNum);

  if (doSync) {
    syncBaselineScores(results);
  } else {
    // A1-4 / F-S2：未 sync 时 dashboard 会显示旧数据。在末尾打 banner 警示
    const reason = caseFilter !== undefined
      ? "（--cases 模式默认不回写，避免污染 baseline；--sync 显式启用）"
      : "（已显式 --no-sync）";
    console.log("");
    console.log("⚠️  本次未回写 baseline_scores，dashboard 将显示上次已 sync 的数据（可能滞后）");
    console.log(`    跳过原因${reason}`);
  }

  console.log("");
  console.log(`[eval-runner] 完成 ${results.length} 组评测，耗时 ${(totalElapsed / 1000).toFixed(0)}s`);
  console.log(`  输出: ${outputPath}`);
  // 平均分仅统计 score !== null 的 case（"有可评分数据"）。null case 单独计数。
  // 旧实现把 error case 的 ~2.5 算进均值，导致 17% 错误率仍能稳在 4.1，看起来"还行"。
  const valid = results.filter(r => r.score !== null);
  const nullCount = results.length - valid.length;
  if (valid.length > 0) {
    const avgScore = valid.reduce((s, r) => s + (r.score as number), 0) / valid.length;
    console.log(`  平均分: ${avgScore.toFixed(2)}/5 (n=${valid.length})${nullCount > 0 ? `；另有 ${nullCount} 个 case 无可评分数据（score=null，未计入均值）` : ""}`);
  } else {
    console.log(`  平均分: N/A（全部 ${results.length} 个 case 无可评分数据）`);
  }

  const refreshOk = await refreshReports();
  if (!refreshOk && strictRefresh) {
    console.error("[eval-runner] dashboard/cases 刷新失败，--strict-refresh 模式下 exit 1");
    process.exit(1);
  }
}

/**
 * 自动刷新 DASHBOARD.md / CASES.md。
 *
 * v2（审查 #12）：返回 boolean 标识成功，失败时调用方决定是否 exit 非 0。
 * 旧实现失败只打 ❌ 然后正常退出，CI 看不到错误。
 */
async function refreshReports(): Promise<boolean> {
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

  return dashCode === 0 && casesCode === 0;
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[eval-runner] fatal:", err);
    process.exit(1);
  });
}
