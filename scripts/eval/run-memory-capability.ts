/**
 * eval:memory-capability — 跑 Memory 子系统 capability eval（S0-T03）
 *
 * 用法：
 *   bun run scripts/eval/run-memory-capability.ts                  # 跑全部 + 跳过 LLM Judge (省钱模式)
 *   bun run scripts/eval/run-memory-capability.ts --case case_mem_001  # 跑单条
 *   bun run scripts/eval/run-memory-capability.ts --execute        # 真调 LLM Judge
 *   bun run scripts/eval/run-memory-capability.ts --sync           # 回写 baseline_scores 到 yaml
 *
 * 必须依赖 sid-code-live adapter（ADR-016）。
 * 输出：
 *   evals/raw-outputs/capability-memory-<ts>.jsonl       — 每条 case 的详细评分
 *   evals/_reports/capability-memory-<ts>.json          — 5 维度汇总
 *
 * memory case 的特殊处理：
 *   - 跑前 backup ~/.sid-code/memory/memories.json 和 <cwd>/.sid-code/memory/memories.json
 *   - case yaml 含 seed_memory[] → runner 把 seed 写到对应 scope 的 memories.json
 *   - 跑完 restore（恢复跑前 snapshot），避免污染开发者本地真实 memory
 */

import { mkdirSync, readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import {
  runSidCodeLive,
  type SidCodeLiveConfig,
  type SidCodeLiveResult,
} from "../../evals/bench-runner/adapters/sid-code-live.ts";
import { gradeProcess, type JudgeConfig } from "../../evals/bench-runner/process-grader.ts";
import {
  syncBaselineScores,
  type BaselineResult,
} from "../../evals/baseline-sync.ts";
import {
  loadCapabilityCases,
  runSharedCheck,
  aggregateCapabilityScore,
  classifyRunStatus,
  excludeEchoKeywords,
  readMemoryFile,
  type SharedGraderInput,
  type CheckResult,
  type GraderRule,
} from "../../evals/bench-runner/capability-shared.ts";

const ROOT = process.cwd();
const CAPABILITY_DIR = join(ROOT, "evals/capability/memory");
const RAW_DIR = join(ROOT, "evals/raw-outputs");
const REPORT_DIR = join(ROOT, "evals/_reports");

const GLOBAL_MEMORY_FILE = join(homedir(), ".sid-code/memory/memories.json");
const PROJECT_MEMORY_FILE = join(ROOT, ".sid-code/memory/memories.json");

const { values } = parseArgs({
  options: {
    case: { type: "string" },
    execute: { type: "boolean", default: false },
    timeout: { type: "string", default: "180000" },
    model: { type: "string" },
    sync: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

mkdirSync(RAW_DIR, { recursive: true });
mkdirSync(REPORT_DIR, { recursive: true });

// ============================================================
// memory case 类型 + 专属 check
// ============================================================

interface MemoryCaseExpected {
  execution_must_call_tools_any_of?: string[];
  execution_must_not_call_tools?: string[];
  memory_write_scope_must_be?: "global" | "project";
  memory_write_keys_any_of?: string[];
  memory_write_values_any_of?: string[];
  final_response_must_include_any_of?: string[];
  final_response_must_not_include?: string[];
  final_response_must_include_some_keywords?: string[];
  memory_update_must_contain_value?: string;
  memory_update_must_not_keep_old_value?: string;
  max_steps?: number;
}

interface MemorySnapshot {
  globalEntries: Array<{ key: string; value: string; scope: string }>;
  projectEntries: Array<{ key: string; value: string; scope: string }>;
}

interface MemoryGraderInput {
  expected: MemoryCaseExpected;
  toolsCalled: string[];
  steps: number;
  finalResponse: string;
  /** 跑后从 memories.json 读出的快照 */
  postRunSnapshot: MemorySnapshot;
  /** 跑前 seed 的快照（用于"新增条目"判断） */
  preRunSnapshot: MemorySnapshot;
  /** 题面（echo 排除用） */
  userQuery: string;
}

/** memory 子系统专属 check 处理 */
function runMemoryCheck(rule: GraderRule, input: MemoryGraderInput): CheckResult {
  const check = rule.check || "";
  const expected = input.expected;
  const post = input.postRunSnapshot;
  const pre = input.preRunSnapshot;

  // 找跑后新增的条目（key 没在 pre 里）
  const preKeys = new Set([
    ...pre.globalEntries.map((e) => e.key),
    ...pre.projectEntries.map((e) => e.key),
  ]);
  const newGlobalEntries = post.globalEntries.filter((e) => !preKeys.has(e.key));
  const newProjectEntries = post.projectEntries.filter((e) => !preKeys.has(e.key));
  const newEntries = [...newGlobalEntries, ...newProjectEntries];

  switch (check) {
    case "memory_write_scope_must_be": {
      const want = expected.memory_write_scope_must_be;
      if (!want) return { check, passed: false, weight: rule.weight, reason: "缺 expected.memory_write_scope_must_be" };
      const writtenScopes = new Set(newEntries.map((e) => e.scope));
      const ok = writtenScopes.has(want);
      return {
        check,
        passed: ok,
        weight: rule.weight,
        reason: ok
          ? `${want} scope 有新条目 (写入 ${newEntries.length} 条)`
          : `期望 ${want},实际 scopes=${[...writtenScopes].join(",") || "无"}`,
      };
    }

    case "memory_write_keys_any_of_hit": {
      const list = (expected.memory_write_keys_any_of || []).map((k) => k.toLowerCase());
      const newKeysLower = newEntries.map((e) => e.key.toLowerCase());
      const hit = list.some((kw) => newKeysLower.some((k) => k.includes(kw)));
      return {
        check,
        passed: hit,
        weight: rule.weight,
        reason: hit
          ? `命中关键字: 新 keys=[${newEntries.map((e) => e.key).join(",")}]`
          : `未命中: 期望 keys 包含 [${list.join(",")}], 实际 [${newEntries.map((e) => e.key).join(",") || "空"}]`,
      };
    }

    case "memory_write_values_any_of_hit": {
      const list = (expected.memory_write_values_any_of || []).map((k) => k.toLowerCase());
      const newValsLower = newEntries.map((e) => e.value.toLowerCase());
      const hit = list.some((kw) => newValsLower.some((v) => v.includes(kw)));
      return {
        check,
        passed: hit,
        weight: rule.weight,
        reason: hit ? `value 命中` : `未命中: 期望 [${list.join(",")}]`,
      };
    }

    case "memory_isolation_keyword_count_min_2": {
      const list = expected.final_response_must_include_some_keywords || [];
      // echo 排除（CLAUDE.md §0.4）
      const { filtered, echoed } = excludeEchoKeywords(list, input.userQuery);
      const filteredLower = filtered.map((k) => k.toLowerCase());
      const lower = input.finalResponse.toLowerCase();
      const hits = filteredLower.filter((kw) => lower.includes(kw));
      const ok = hits.length >= 2;
      const reasonExtra = echoed.length > 0 ? ` | echo 排除 [${echoed.join(",")}]` : "";
      return {
        check,
        passed: ok,
        weight: rule.weight,
        reason: `命中 ${hits.length}/${filtered.length} (要求 ≥ 2): [${hits.join(",")}]${reasonExtra}`,
      };
    }

    case "memory_update_must_contain_value_hit": {
      const want = (expected.memory_update_must_contain_value || "").toLowerCase();
      if (!want) return { check, passed: false, weight: rule.weight, reason: "缺 expected" };
      // 在 post 的所有 entries 里找 value 含 want
      const allEntries = [...post.globalEntries, ...post.projectEntries];
      const hit = allEntries.some((e) => e.value.toLowerCase().includes(want));
      return {
        check,
        passed: hit,
        weight: rule.weight,
        reason: hit ? `memory 含 value=${want}` : `memory 不含 value=${want}`,
      };
    }

    case "memory_update_must_not_keep_old_value_zero_hit": {
      const old = (expected.memory_update_must_not_keep_old_value || "").toLowerCase();
      if (!old) return { check, passed: true, weight: rule.weight, reason: "无旧值约束" };
      const allEntries = [...post.globalEntries, ...post.projectEntries];
      const stillHas = allEntries.some((e) => e.value.toLowerCase().includes(old));
      return {
        check,
        passed: !stillHas,
        weight: rule.weight,
        reason: stillHas ? `仍保留旧值 ${old}` : `已覆盖旧值`,
      };
    }

    default:
      return { check, passed: false, weight: rule.weight, reason: `未知 check: ${check}` };
  }
}

// ============================================================
// seed_memory + backup/restore
// ============================================================

/** 备份当前 memory 文件,跑完用于 restore */
function snapshotMemoryFile(filePath: string): { existed: boolean; content: string | null } {
  if (!existsSync(filePath)) return { existed: false, content: null };
  try {
    return { existed: true, content: readFileSync(filePath, "utf-8") };
  } catch {
    return { existed: false, content: null };
  }
}

/** 还原 memory 文件到 snapshot 状态 */
function restoreMemoryFile(filePath: string, snapshot: { existed: boolean; content: string | null }): void {
  if (snapshot.existed && snapshot.content != null) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, snapshot.content, "utf-8");
  } else {
    // 跑前不存在 → 跑后存在 = runner 写过 seed,需要清掉
    if (existsSync(filePath)) {
      try {
        unlinkSync(filePath);
      } catch {
        // ignore
      }
    }
  }
}

/** 把 seed_memory[] 写到对应 scope 的 memories.json */
function seedMemory(
  seeds: Array<{ scope: "global" | "project"; key: string; value: string }>,
): void {
  const groups: Record<"global" | "project", Array<{ key: string; value: string }>> = {
    global: [],
    project: [],
  };
  for (const s of seeds) {
    groups[s.scope].push({ key: s.key, value: s.value });
  }

  for (const scope of ["global", "project"] as const) {
    const filePath = scope === "global" ? GLOBAL_MEMORY_FILE : PROJECT_MEMORY_FILE;
    if (groups[scope].length === 0) continue;

    // 读已有内容,把 seed 合并进去
    let data: { version: string; entries: Record<string, unknown> } = {
      version: "1.0",
      entries: {},
    };
    if (existsSync(filePath)) {
      try {
        data = JSON.parse(readFileSync(filePath, "utf-8"));
      } catch {
        // ignore parse error,用空数据
      }
    }
    if (!data.entries) data.entries = {};

    const now = Date.now();
    for (const s of groups[scope]) {
      data.entries[s.key] = {
        key: s.key,
        value: s.value,
        scope,
        createdAt: now,
        updatedAt: now,
      };
    }

    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  }
}

/** 读当前 memory 文件,返回 entries 列表 */
function readMemorySnapshot(): MemorySnapshot {
  return {
    globalEntries: readMemoryFile(GLOBAL_MEMORY_FILE).entries,
    projectEntries: readMemoryFile(PROJECT_MEMORY_FILE).entries,
  };
}

// ============================================================
// 主流程
// ============================================================

const judgeConfig: JudgeConfig = {
  apiKey: process.env.ANTHROPIC_API_KEY || "",
  baseUrl: (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com") + "/v1",
  model: process.env.JUDGE_MODEL || "claude-sonnet-4-6",
  promptPath: join(ROOT, "evals/_judge/prompt-v2.md"),
};

const liveConfig: SidCodeLiveConfig = {
  cwd: ROOT,
  model: values.model || process.env.SID_CODE_MODEL || "deepseek-v4-pro",
  timeoutMs: parseInt(values.timeout || "180000", 10),
};

const cases = loadCapabilityCases<MemoryCaseExpected>(CAPABILITY_DIR, "case_mem_", values.case);
if (cases.length === 0) {
  console.error(`✗ 未找到 memory capability case${values.case ? ` (filter=${values.case})` : ""}`);
  process.exit(1);
}

console.log(`Mode      : ${values.execute ? "execute (真调 LLM Judge)" : "skip-llm-judge (省钱模式)"}`);
console.log(`Adapter   : sid-code-live`);
console.log(`Model     : ${liveConfig.model || "(用户 config 默认)"}`);
console.log(`Timeout   : ${liveConfig.timeoutMs}ms`);
console.log(`Cases     : ${cases.length} 条 (${cases.map((c) => c.id).join(", ")})`);
console.log("");

const ts = Date.now();
const rawOutputPath = join(RAW_DIR, `capability-memory-${ts}.jsonl`);
const reportOutputPath = join(REPORT_DIR, `capability-memory-${ts}.json`);

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
  };
  reasoning: string;
}

const results: CaseResult[] = [];

for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  console.log(`[${i + 1}/${cases.length}] ${c.id} (${c.dimension}) — 启动 sid-code-live ...`);

  // 1. backup memory 文件
  const globalBackup = snapshotMemoryFile(GLOBAL_MEMORY_FILE);
  const projectBackup = snapshotMemoryFile(PROJECT_MEMORY_FILE);

  // 清空 memory(避免 backup 之外的污染干扰断言)
  if (existsSync(GLOBAL_MEMORY_FILE)) {
    try { unlinkSync(GLOBAL_MEMORY_FILE); } catch {}
  }
  if (existsSync(PROJECT_MEMORY_FILE)) {
    try { unlinkSync(PROJECT_MEMORY_FILE); } catch {}
  }

  // 2. seed memory
  if (c.input.seed_memory && c.input.seed_memory.length > 0) {
    seedMemory(c.input.seed_memory);
  }

  // 3. 读 pre snapshot
  const preSnapshot = readMemorySnapshot();

  // 4. 跑 sid-code
  const startedAt = Date.now();
  let live: SidCodeLiveResult;
  try {
    live = await runSidCodeLive(c.input.user_query.trim(), liveConfig);
  } catch (err) {
    console.log(`    ✗ adapter error: ${String(err).slice(0, 200)}`);
    // restore 后跳过本 case
    restoreMemoryFile(GLOBAL_MEMORY_FILE, globalBackup);
    restoreMemoryFile(PROJECT_MEMORY_FILE, projectBackup);
    continue;
  }
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  // 5. 读 post snapshot（必须在 restore 之前读）
  const postSnapshot = readMemorySnapshot();

  // 6. restore（在 grader 之后立刻还原,确保下条 case 干净）
  restoreMemoryFile(GLOBAL_MEMORY_FILE, globalBackup);
  restoreMemoryFile(PROJECT_MEMORY_FILE, projectBackup);

  // 7. 跑 grader
  const graderInput: MemoryGraderInput = {
    expected: c.expected,
    toolsCalled: live.output.tools_called,
    steps: live.output.steps,
    finalResponse: live.output.final_response,
    preRunSnapshot: preSnapshot,
    postRunSnapshot: postSnapshot,
    userQuery: c.input.user_query,
  };

  const assertResults: CheckResult[] = [];
  let llmRule: GraderRule | null = null;
  // 构造 shared check 用的输入（expected 拍平为 Record）
  const sharedInput: SharedGraderInput = {
    expected: c.expected as Record<string, unknown>,
    toolsCalled: graderInput.toolsCalled,
    steps: graderInput.steps,
    finalResponse: graderInput.finalResponse,
    userQuery: c.input.user_query,
  };
  for (const rule of c.grader) {
    if (rule.type === "llm_judge") {
      llmRule = rule;
      continue;
    }
    // 先 share check,未识别再 fallback memory 专属
    const shared = runSharedCheck(rule, sharedInput);
    assertResults.push(shared ?? runMemoryCheck(rule, graderInput));
  }

  // LLM Judge
  let llmScore: number | undefined;
  if (values.execute && llmRule && judgeConfig.apiKey) {
    const judgeInput = {
      task: c.input.user_query.slice(0, 1500),
      expected: {
        must_include_keywords: c.expected.final_response_must_include_any_of,
        must_call_tools: c.expected.execution_must_call_tools_any_of,
        max_steps: c.expected.max_steps,
      },
      agentResponse: live.output.final_response,
    };
    const judgeResult = await gradeProcess(judgeInput, judgeConfig);
    llmScore = judgeResult.score;
  }

  const agg = aggregateCapabilityScore({
    assertResults,
    llmJudgeScore: llmScore,
    llmJudgeWeight: llmRule?.weight,
  });

  const checkSummary = assertResults.map((r) => `${r.check}=${r.passed ? "✓" : "✗"}`).join(" / ");

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
    },
    reasoning: `${elapsed}s, ${checkSummary}${llmScore != null ? `, judge=${llmScore}` : ""}`,
  };
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

// raw + report 落盘
const rawContent = results.map((r) => JSON.stringify(r)).join("\n") + "\n";
await Bun.write(rawOutputPath, rawContent);

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
  avgScore:
    results.length > 0
      ? Math.round((results.reduce((s, r) => s + r.finalScore, 0) / results.length) * 100) / 100
      : 0,
  passRate:
    results.length > 0
      ? Math.round((results.filter((r) => r.finalScore >= 4.0).length / results.length) * 100) / 100
      : 0,
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
console.log(`Memory capability eval done`);
console.log("=".repeat(60));
console.log(`  Total: ${overall.total} | avg=${overall.avgScore}/5 | pass=${(overall.passRate * 100).toFixed(0)}%`);
console.log(`  By dimension:`);
for (const [dim, s] of Object.entries(dimensionSummary)) {
  console.log(`    ${dim.padEnd(28)} avg=${s.avgScore} pass=${(s.passRate * 100).toFixed(0)}% (n=${s.count})`);
}
console.log(`\n  Raw  → ${rawOutputPath}`);
console.log(`  Report → ${reportOutputPath}`);

// --sync：回写 baseline_scores
if (values.sync) {
  const modelSlug = (liveConfig.model || "default").replace(/[^a-zA-Z0-9]/g, "_");
  const providerKey = `sid_code_${modelSlug}`;

  const baselineResults: BaselineResult[] = results.map((r) => {
    const runStatus = classifyRunStatus({
      exitStatus: r.agentSnapshot.exit_status,
      timedOut: r.agentSnapshot.timed_out,
    });
    return {
      caseId: r.id,
      provider: providerKey,
      score: r.finalScore,
      runStatus,
      testedAt: new Date(ts).toISOString(),
      dimensions: {
        assert: r.assertScore,
        llm_judge: r.llmScore,
      },
      formulaVersion: { grader: "capability-memory-v1" },
    };
  });

  syncBaselineScores(baselineResults, {
    yamlDir: CAPABILITY_DIR,
    testerLabel: "eval:memory-capability",
  });
}
