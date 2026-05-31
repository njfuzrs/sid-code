/**
 * yaml-loader.ts — 共享 schema 归一化层
 *
 * 同时消费 sid-code 与 code-graph 两个项目的 evals/ 数据:
 *   - case yaml: p0-core / p1-common / p2-edge / holdout 四个目录
 *   - 外部周分数: _scores/wNN/case_NNN.yaml(code-graph 模式, W7-W10 单通道 / W11+ 双通道)
 *   - 内联周分数: case yaml 的 code_graph_scores 嵌套段(code-graph 历史遗留)
 *   - sid-code baseline_scores: 每条 case 内联多 tool 快照(无时序)
 *
 * 与 code-graph 的 packages/core/src/eval/score-io.mjs 的关系:
 *   功能重叠但独立实现 —— 本文件用 TS 镜像 readAllScores 逻辑,避免跨项目运行时依赖。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import yaml from "yaml";

export interface CaseDoc {
  id: string;
  category?: string;
  priority?: string;
  holdout?: boolean;
  target_score?: number;
  created_date?: string;
  eval_type?: string;
  source?: string;
  input?: { user_query?: string; repo?: string; repo_commit?: string };
  expected?: Record<string, unknown>;
  rubric?: Record<string, string>;
  baseline_scores?: Record<string, BaselineScore>;
  code_graph_scores?: Record<string, unknown>;
  related_subsystem?: string[];
  notes?: string;
  filePath: string;
  bucket: string;
}

export interface BaselineScore {
  score: number | null;
  run_status?: string;
  tested_at?: string | null;
  tested_by?: string;
  transcript_path?: string | null;
  notes?: string;
  /**
   * 公式/Grader 版本号，由 eval-runner.syncBaselineScores 写入。
   * 形如 { cost: "v6", grader: "5d-v2" }——legacy 数据可能只有 { cost: "legacy_v1" } 或缺失。
   * dashboard 默认按 grader 版本过滤显示，跨版本数据不可直接比较。
   */
  _formula_version?: { cost?: string; grader?: string };
}

export interface WeekScore {
  week: number;
  anchor: number | null;
  llm: number | null;
  llmDimensions?: Record<string, number>;
  adaptiveTriggered?: boolean;
  testedAt?: string;
}

/**
 * Bucket：case 所在桶（用于分组统计 / dashboard 双指标）。
 *
 * 当前支持：
 *   - p0-core / p1-common / p2-edge / holdout：S1-T00 之前的扁平结构（向后兼容）
 *   - general/p0-core / general/p1-common / general/p2-edge：S1-T00 起的 general 子目录
 *   - holdout/architecture/<sub>：S1 起架构 holdout（meta/kernel/form/...）
 *   - architecture/<sub>：S1 起 18 类架构 case（redline/kernel/form/discipline/meta/...）
 *
 * loadAllCases() 同时扫这三种结构，bucket 字段标示 case 实际归属。
 */
const LEGACY_GENERAL_BUCKETS = ["p0-core", "p1-common", "p2-edge", "holdout"];
const NEW_GENERAL_BUCKETS = ["general/p0-core", "general/p1-common", "general/p2-edge"];
// B5-6（2026-05-30 / ADR-032）：execution case 单独成桶，与 5d-v3 主表分开展示
const EXECUTION_BUCKET = "general/execution";

/** 判断 bucket 是否属于"行为分"（general 类，5 维 grader） */
export function isBehaviorBucket(bucket: string): boolean {
  return (
    LEGACY_GENERAL_BUCKETS.includes(bucket) ||
    (bucket.startsWith("general/") && bucket !== EXECUTION_BUCKET)
  );
}

/** 判断 bucket 是否属于"架构分"（architecture 类，binary_redline / structured_arch grader） */
export function isArchitectureBucket(bucket: string): boolean {
  return bucket.startsWith("architecture/") || bucket.startsWith("holdout/architecture/");
}

/**
 * B5-6（2026-05-30 / ADR-032）：判断 bucket 是否属于 execution 轴。
 *
 * execution case 走 grader_type=execution_test，binary 0/1，
 * **不与 5d-v3 加权混算**——必须独立成栏在 DASHBOARD 展示。
 */
export function isExecutionBucket(bucket: string): boolean {
  return bucket === EXECUTION_BUCKET || bucket.startsWith("general/execution/");
}

/**
 * B7-1（2026-05-31 / §15.2 ADR-033）：判断 bucket 是否属于 trajectory 轴。
 *
 * trajectory case 走 grader_type=trajectory_match，**M5 前仅作诊断维度，不进总分**。
 * 数据来源：evals/real-tasks/（B6-1 适配器导出）+ evals/holdout/real-tasks/（B7-3 永封）。
 */
export function isTrajectoryBucket(bucket: string): boolean {
  return (
    bucket === "real-tasks" ||
    bucket.startsWith("real-tasks/") ||
    bucket === "holdout/real-tasks" ||
    bucket.startsWith("holdout/real-tasks/")
  );
}

function listArchitectureSubBuckets(evalsDir: string, base: string): string[] {
  const root = join(evalsDir, base);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    if (!existsSync(p) || !statSync(p).isDirectory()) continue;
    out.push(`${base}/${entry}`);
  }
  return out;
}

function listRealTaskSubBuckets(evalsDir: string, base: string): string[] {
  const root = join(evalsDir, base);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    if (!existsSync(p) || !statSync(p).isDirectory()) continue;
    if (entry === "scripts") continue; // setup_*.sh 不是 case yaml
    out.push(`${base}/${entry}`);
  }
  return out;
}

export function loadAllCases(evalsDir: string): CaseDoc[] {
  const out: CaseDoc[] = [];
  const buckets = [
    ...LEGACY_GENERAL_BUCKETS,
    ...NEW_GENERAL_BUCKETS,
    EXECUTION_BUCKET,
    ...listArchitectureSubBuckets(evalsDir, "architecture"),
    ...listArchitectureSubBuckets(evalsDir, "holdout/architecture"),
    // B6-2/3（2026-05-31 / §15.2 ADR-033）：trajectory case 子桶 evals/real-tasks/<cat>/
    // 文件名前缀 real_*；trajectory_match grader M5 前仅作诊断维度，不进总分。
    ...listRealTaskSubBuckets(evalsDir, "real-tasks"),
    ...listRealTaskSubBuckets(evalsDir, "holdout/real-tasks"),
  ];
  for (const bucket of buckets) {
    const abs = join(evalsDir, bucket);
    if (!existsSync(abs)) continue;
    // case 文件名前缀：legacy 用 case_*，新架构用 arch_*；B5-6 起 execution 桶用 bug_*；B6-2 起 real-tasks 用 real_*；B7-4 起 cr_* (code-review execution)；B7-5 起 csh_* (ci-self-heal execution)
    const entries = readdirSync(abs).filter(
      (f) =>
        (f.startsWith("case_") || f.startsWith("arch_") || f.startsWith("bug_") || f.startsWith("real_") || f.startsWith("cr_") || f.startsWith("csh_")) && f.endsWith(".yaml"),
    );
    for (const f of entries) {
      const p = join(abs, f);
      if (!statSync(p).isFile()) continue;
      try {
        const data = yaml.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
        if (!data || typeof data !== "object") continue;
        out.push({
          ...(data as object),
          id: String(data.id ?? basename(f, ".yaml")),
          filePath: p,
          bucket,
        } as CaseDoc);
      } catch (err) {
        console.error(`[yaml-loader] 解析失败 ${p}: ${(err as Error).message}`);
      }
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * 读取一条 case 的所有历史周分数。
 * 优先外部 _scores/wNN/case_NNN.yaml,fallback 到内联 code_graph_scores。
 */
export function loadWeekScores(caseId: string, evalsDir: string, inlineScores?: unknown): WeekScore[] {
  const byWeek = new Map<number, WeekScore>();

  if (inlineScores && typeof inlineScores === "object") {
    flattenInlineWeeks(inlineScores as Record<string, unknown>, byWeek);
  }

  const scoresDir = join(evalsDir, "_scores");
  if (existsSync(scoresDir)) {
    for (const wDir of readdirSync(scoresDir)) {
      const m = wDir.match(/^w(\d+)$/);
      if (!m) continue;
      const weekNum = Number(m[1]);
      const filePath = join(scoresDir, wDir, `${caseId}.yaml`);
      if (!existsSync(filePath)) continue;
      try {
        const doc = yaml.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
        byWeek.set(weekNum, normalizeWeekDoc(weekNum, doc));
      } catch {
        // skip malformed
      }
    }
  }

  return [...byWeek.values()].sort((a, b) => a.week - b.week);
}

function normalizeWeekDoc(week: number, doc: Record<string, unknown>): WeekScore {
  if (doc.anchor && typeof doc.anchor === "object") {
    const anchor = (doc.anchor as { score?: number }).score;
    const llm = doc.llm && typeof doc.llm === "object" ? (doc.llm as { score?: number }).score : undefined;
    const dims =
      doc.llm && typeof doc.llm === "object"
        ? ((doc.llm as { dimensions?: Record<string, number> }).dimensions ?? undefined)
        : undefined;
    const adaptive =
      doc.llm && typeof doc.llm === "object"
        ? Boolean((doc.llm as { adaptive_triggered?: boolean }).adaptive_triggered)
        : false;
    return {
      week,
      anchor: typeof anchor === "number" ? anchor : null,
      llm: typeof llm === "number" ? llm : null,
      llmDimensions: dims,
      adaptiveTriggered: adaptive,
      testedAt: typeof doc.tested_at === "string" ? doc.tested_at : undefined,
    };
  }

  return {
    week,
    anchor: typeof doc.score === "number" ? doc.score : null,
    llm: null,
    testedAt: typeof doc.tested_at === "string" ? doc.tested_at : undefined,
  };
}

function flattenInlineWeeks(node: Record<string, unknown>, out: Map<number, WeekScore>): void {
  for (const [k, v] of Object.entries(node)) {
    const m = k.match(/^w(\d+)$/);
    if (m && v && typeof v === "object") {
      const week = Number(m[1]);
      const block = v as Record<string, unknown>;
      const scoreData: Record<string, unknown> = {};
      for (const [bk, bv] of Object.entries(block)) {
        if (!/^w\d+$/.test(bk)) scoreData[bk] = bv;
      }
      if (Object.keys(scoreData).length > 0 && !out.has(week)) {
        out.set(week, normalizeWeekDoc(week, scoreData));
      }
      flattenInlineWeeks(block, out);
    } else if (v && typeof v === "object") {
      flattenInlineWeeks(v as Record<string, unknown>, out);
    }
  }
}

/**
 * 探测 baseline_scores 里出现过的所有 tool 名(用于动态生成矩阵列)。
 */
export function collectToolNames(cases: CaseDoc[]): string[] {
  const set = new Set<string>();
  for (const c of cases) {
    if (c.baseline_scores) {
      for (const k of Object.keys(c.baseline_scores)) set.add(k);
    }
  }
  return [...set].sort();
}

export interface BaselineSnapshot {
  tool: string;
  score: number | null;
  status: "tested" | "pending" | "error" | "timeout";
  testedAt?: string;
  notes?: string;
  /** Grader 版本号（如 "5d-v2"）；undefined 表示 legacy 数据（无版本标记） */
  graderVersion?: string;
  /** Cost 公式版本号（如 "v6" / "legacy_v1"） */
  costVersion?: string;
}

export function readBaseline(c: CaseDoc, tool: string): BaselineSnapshot {
  const raw = c.baseline_scores?.[tool];
  if (!raw) {
    return { tool, score: null, status: "pending" };
  }
  const score = typeof raw.score === "number" ? raw.score : null;
  let status: BaselineSnapshot["status"] = "pending";
  if (raw.run_status) {
    if (raw.run_status === "success") status = "tested";
    else if (raw.run_status === "error") status = "error";
    else if (raw.run_status === "timeout") status = "timeout";
    else status = "pending";
  } else if (score != null) {
    status = "tested";
  }
  return {
    tool,
    score,
    status,
    testedAt: raw.tested_at ?? undefined,
    notes: raw.notes,
    graderVersion: raw._formula_version?.grader,
    costVersion: raw._formula_version?.cost,
  };
}

/**
 * 当前 dashboard 默认显示的 grader 版本（与 eval-judge.ts GRADER_VERSION 同步）。
 *
 * 设计：跨 grader 版本的总分不可直接比较——5d-v1 efficiency 权重 0.3 与 5d-v2 efficiency 权重 0
 * 同一 case 同一 agent 的总分会偏移 0.05~0.15。dashboard 主表默认只显示 LATEST_GRADER_VERSION 数据，
 * 旧版本走 includeLegacy 开关（renderCaseToolMatrix 在脚注列出过滤的 legacy 条目数）。
 *
 * 升级时机：eval-judge.ts 的 GRADER_VERSION bump 后，**同步**改本常量；不允许两边漂移。
 *
 * 历史：
 *   5d-v3：rubric-template.ts CoT 评分 + task-specific scorer 注册表，2026-05-26 ~ 2026-05-29
 *   5d-v4：追溯式 bump，纳入 7c34ef6 echo 排除 + 下中位数 + binary fail-safe，2026-05-30 起，
 *           详见 ADR-027 / 评测系统报告 §人的纪律 H-1
 */
export const LATEST_GRADER_VERSION = "5d-v4";

/**
 * Capability runner 自家 grader 版本——dashboard 把这些当成 5d-v4 之外的"真版本数据"展示，不进 legacy。
 *
 * 这些 grader 各自有 mandatoryPass / score / dimensions 含义，不与 5d-v* 跨版本比较。
 * 单字符串前缀 "capability-" 用于快速识别。
 */
export const CAPABILITY_GRADER_PREFIX = "capability-";

/**
 * 判定 baseline entry 是否属于"legacy 数据"（应当被 dashboard 主表过滤）：
 *   - graderVersion 缺失（早期 promptfoo / anchor_auto_v0 数据）
 *   - graderVersion 不是 LATEST_GRADER_VERSION 且不带 capability- 前缀（5d-v1/5d-v2/5d-v3 等历史版本）
 *
 * dashboard --include-legacy 时绕过本判定一并展示。
 */
export function isLegacyBaseline(entry: { graderVersion?: string }): boolean {
  const v = entry.graderVersion;
  if (!v) return true;
  if (v === LATEST_GRADER_VERSION) return false;
  if (v.startsWith(CAPABILITY_GRADER_PREFIX)) return false;
  return true;
}

export interface RunRecord {
  runId: string;
  testedAt: string;
  week: number;
  caseId: string;
  provider: string;
  /**
   * null = 该 case 无可评分数据（wrapper error/timeout/abnormal，所有维度跳过）。
   * 旧 _runs/*.jsonl 里 Number(null) === 0 会拉低均值；消费者必须显式 filter null 后再聚合。
   */
  score: number | null;
  namedScores: Record<string, number | null>;
  latencyMs: number;
  success: boolean;
  runStatus: string;
}

/**
 * 读 evals/_runs/{provider}.jsonl —— 追加式运行历史。
 * 返回 provider → 该 provider 的所有运行记录（按 runId 排序）。
 */
export function loadRunHistory(evalsDir: string): Map<string, RunRecord[]> {
  const runsDir = join(evalsDir, "_runs");
  const byProvider = new Map<string, RunRecord[]>();
  if (!existsSync(runsDir)) return byProvider;

  for (const file of readdirSync(runsDir)) {
    if (!file.endsWith(".jsonl")) continue;
    const provider = file.slice(0, -".jsonl".length);
    const fullPath = join(runsDir, file);
    try {
      const content = readFileSync(fullPath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());
      const records: RunRecord[] = [];
      for (const line of lines) {
        try {
          const j = JSON.parse(line);
          // 过滤 raw samples（is_median=false）：dashboard 只展示中位数聚合行或旧格式行（无 is_median 字段）
          // 旧 _runs 没有 is_median 字段 → 视为有效行（向后兼容）
          // --samples > 1 时会写 is_median=true（中位数）+ is_median=false（raw），只取前者
          if (j.is_median === false) continue;
          records.push({
            runId: String(j.run_id),
            testedAt: String(j.tested_at || j.run_id),
            week: Number(j.week ?? 0),
            caseId: String(j.case_id),
            provider: String(j.provider),
            // 显式区分 null（无可评数据）和 0（实测为 0），不要走 Number(null)=0 通道
            score: j.score === null || j.score === undefined ? null : Number(j.score),
            namedScores: (j.named_scores ?? {}) as Record<string, number | null>,
            latencyMs: Number(j.latency_ms ?? 0),
            success: Boolean(j.success),
            runStatus: String(j.run_status ?? "unknown"),
          });
        } catch {
          // 跳过损坏的行
        }
      }
      records.sort((a, b) => a.testedAt.localeCompare(b.testedAt));
      byProvider.set(provider, records);
    } catch {
      // 跳过读取失败的文件
    }
  }
  return byProvider;
}

export interface ProjectSnapshot {
  projectName: string;
  evalsDir: string;
  cases: CaseDoc[];
  tools: string[];
  weeksByCase: Map<string, WeekScore[]>;
  allWeeks: number[];
  /** 每个 provider 的运行历史（追加式 jsonl），用于画 run-level 趋势 */
  runHistory: Map<string, RunRecord[]>;
}

export function buildProjectSnapshot(evalsDir: string, projectName: string): ProjectSnapshot {
  const cases = loadAllCases(evalsDir);
  const tools = collectToolNames(cases);
  const weeksByCase = new Map<string, WeekScore[]>();
  const weekSet = new Set<number>();
  for (const c of cases) {
    const weeks = loadWeekScores(c.id, evalsDir, c.code_graph_scores);
    weeksByCase.set(c.id, weeks);
    for (const w of weeks) weekSet.add(w.week);
  }
  const allWeeks = [...weekSet].sort((a, b) => a - b);
  const runHistory = loadRunHistory(evalsDir);
  return { projectName, evalsDir, cases, tools, weeksByCase, allWeeks, runHistory };
}
