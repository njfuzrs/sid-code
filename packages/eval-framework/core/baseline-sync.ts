/**
 * baseline-sync.ts — 回写 case yaml `baseline_scores` 字段的共享模块
 *
 * 背景（S0-T02 / docs/eval/plan-capability-baseline-sync.md）：
 *   eval-runner.ts 原本独占 syncBaselineScores 逻辑，硬编码 general case 的 4 个目录
 *   （general/p0-core / general/p1-common / general/p2-edge / holdout，S1-T00 起重组）。
 *   plan capability runner 因目录结构不同（evals/capability/plan/），无法复用，导致 capability case
 *   的 baseline 只有 _reports/ 时间戳文件可查，无法通过 eval:tally / dashboard 读取。
 *
 * 解法：把回写逻辑抽到本模块，按 SyncOptions 接受 yamlDir（capability 单目录）或 baseDir（general 多目录）。
 *   各 runner 把自家 result 类型映射成 BaselineResult 再调用本模块。
 *
 * grader 解冻后约束（CLAUDE.md §0.3.1，2026-05-28 起）：本模块只搬运回写流程，不改 grader 公式 / 权重 / 阈值。
 *   改 grader 仍需走 ADR + bump GRADER_VERSION + 单测 + holdout 验证四件事。
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as yamlLib from "yaml";

/**
 * 单条跑分的归一化结果——供回写 baseline_scores 用。
 *
 * 不同 runner 的内部 result 类型不同（general TestResult / capability CaseResult），
 * 但回写所需信息是稳定一致的。
 */
export interface BaselineResult {
  caseId: string;
  /** baseline_scores 下的一级 key，如 "sid_code_deepseek_v4_pro"、"claude_code_claude_opus_4_7" */
  provider: string;
  /** 总分；run_status !== success 时调用方应传 null（也允许传非 null，本模块按 runStatus 决定 safeScore） */
  score: number | null;
  /** success / error / timeout / abnormal —— 与 _runs / dashboard 同字典 */
  runStatus: string;
  /** ISO 字符串；单 case 实际完成时刻，与整批 runId 区分 */
  testedAt: string;
  /** 各维度归一化分；general: anchor_hit / rubric_score / tool_compliance / efficiency / cost；capability: assert / llm_judge */
  dimensions: Record<string, number | null>;
  /**
   * 公式版本号；**必传**（F-11，2026-05-30 起）。
   *   general 传 { cost: COST_FORMULA_VERSION, grader: GRADER_VERSION }
   *   capability runner 当前阶段无 cost 公式，传 { grader: "capability-plan-v1" } 等
   *
   * 设计动机：缺失等于"无版本"假装是 legacy，会让 dashboard 过滤误判，且违反 §0.3.1 解冻后
   * 约束第 1 条"baseline 必须可版本追溯"的同源精神。强制必传后，新 baseline 一定带版本，
   * 旧 legacy 走 cost: "legacy_v1" / cost: "v3" 等显式标记。
   */
  formulaVersion: Record<string, string | undefined>;
  /** transcript 文件路径，可选 */
  transcriptPath?: string | null;
  /** 覆盖默认 notes（默认按 runStatus 自动生成） */
  notes?: string;
  /**
   * A3-1 / A3-2 / F-1：红线一票否决结果。
   *   - binary_redline grader 的 case 才有意义（true=全 pass / false=任一规则违反或 abnormal）
   *   - 其它 grader 默认 true（不参与红线语义；dashboard 用 graderType 过滤）
   *   - 缺失时本模块不写字段，向后兼容旧 baseline
   */
  mandatoryPass?: boolean;
  /**
   * A3-1 / A3-2 / F-1：grader 类型（rubric_5d / binary_redline / structured_arch / execution_test / capability-*-v1）。
   * 缺失时本模块不写字段；与 _formula_version.grader 不同——
   *   _formula_version.grader 是 grader 公式版本号（5d-v3 / 5d-v4），
   *   graderType 是 grader 注册表里的 type 名，是分类维度。
   */
  graderType?: string;
  /**
   * Multi-sample baseline（08 §9.3 第 6 条 / a.md 问题 6 残留）：
   *   每条 case 跑 N 次,score 取中位数,本字段保留每次分数 + 状态用于事后审计。
   *   单次跑(N=1)时不写本字段,与历史数据兼容。
   */
  samples?: Array<{
    score: number | null;
    runStatus: string;
    testedAt: string;
    dimensions?: Record<string, number | null>;
  }>;
}

export interface SyncOptions {
  /**
   * 单一 yaml 目录（capability 模式）；与 baseDir 二选一。
   * 例：`evals/capability/plan/`、`evals/capability/memory/`。
   */
  yamlDir?: string;
  /**
   * eval 根目录（general 模式）；与 yamlDir 二选一。
   * 内部扫 `${baseDir}/general/p0-core`、`${baseDir}/general/p1-common`、`${baseDir}/general/p2-edge`、`${baseDir}/holdout` 四目录。
   */
  baseDir?: string;
  /** 写到 `baseline_scores[provider].tested_by`，例："eval-runner" / "eval:plan-capability" */
  testerLabel: string;
  /**
   * F-H4(2026-05-30 起):holdout 双重防御。
   *
   * 默认 false → 命中 holdout 路径或 yaml.holdout=true 的 result 直接 skip + warn,
   * 不写入 baseline_scores(防止 holdout 跑分通过 sync 路径泄露到公开 yaml)。
   *
   * 仅 holdout 专用评测脚本(如 m3-gate-eval-runner)可显式 true,
   * 该脚本应单独写到 `evals/_meta/_private/holdout-baselines.jsonl` 而非公开 yaml。
   */
  allowHoldout?: boolean;
}

const DEFAULT_GENERAL_DIRS = ["general/p0-core", "general/p1-common", "general/p2-edge", "holdout"];

/**
 * 动态发现 architecture/<sub>/ 与 holdout/architecture/<sub>/ 下所有子目录。
 * S1-T01 起 architecture 类 case 加入 baseline_scores 回写流程；与 eval-runner.ts 的
 * discoverArchitectureSubDirs 同语义。
 */
function discoverArchitectureSubDirs(absRoot: string): string[] {
  if (!existsSync(absRoot)) return [];
  const dirs: string[] = [];
  for (const entry of readdirSync(absRoot)) {
    const p = join(absRoot, entry);
    try {
      if (require("node:fs").statSync(p).isDirectory()) dirs.push(p);
    } catch {
      /* skip */
    }
  }
  return dirs;
}

/**
 * general 模式：case yaml 文件名 = `${caseId}.yaml`，按文件名查路径。
 *
 * 这是 evals/general/p0-core/ 等 4 个目录的硬约定（case_001.yaml 内 id: case_001）。
 * 历史上 eval-runner 一直按此假设工作，S1-T00 后路径重组，目录前缀加 general/。
 */
function findGeneralCaseYamlPath(caseId: string, searchDirs: string[]): string | null {
  for (const dir of searchDirs) {
    const p = join(dir, `${caseId}.yaml`);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * capability 模式：case yaml 文件名是描述性的（plan_009_premature_exit_typo.yaml）
 * 而 yaml 内 `id: plan_009`——按文件名找不到，需扫目录读 id 字段建索引。
 *
 * 缓存于本次调用的局部变量，避免对同目录每条 case 都重扫。
 */
function buildCapabilityIdIndex(yamlDir: string): Map<string, string> {
  const index = new Map<string, string>();
  if (!existsSync(yamlDir)) return index;
  const files = readdirSync(yamlDir).filter((f) => f.endsWith(".yaml"));
  for (const f of files) {
    const p = join(yamlDir, f);
    try {
      const content = readFileSync(p, "utf-8");
      const parsed = yamlLib.parse(content) as { id?: unknown } | null;
      const id = parsed && typeof parsed === "object" ? parsed.id : undefined;
      if (typeof id === "string" && id.length > 0) {
        index.set(id, p);
      }
    } catch {
      // 单文件解析失败不阻断整体回写流程
    }
  }
  return index;
}

/**
 * 回写 baseline_scores 到对应 case yaml；返回成功更新的 case 数。
 *
 * 与原 eval-runner.syncBaselineScores 行为一致：
 *   - runStatus !== "success" 时 score 落 null（不是 0 / 不是 ~2.5），避免污染 dashboard 均值
 *   - notes 按 runStatus 自动生成（timeout / error 文案），调用方可通过 result.notes 覆盖
 *   - 同 caseId 同 provider 的多次 result 后写覆盖前写（极少触发，仅 --samples > 1 时）
 */
export function syncBaselineScores(results: BaselineResult[], opts: SyncOptions): number {
  let resolveYamlPath: (caseId: string) => string | null;
  if (opts.yamlDir) {
    // capability 模式：文件名描述性，按 yaml 内 id 字段建索引
    const index = buildCapabilityIdIndex(opts.yamlDir);
    resolveYamlPath = (caseId: string) => index.get(caseId) ?? null;
  } else if (opts.baseDir) {
    // general + architecture 模式：约定文件名 = caseId.yaml
    // architecture 子目录动态发现 —— S1-T01 起 evals/architecture/<sub>/<case>.yaml 加入 sync
    const archSubs = discoverArchitectureSubDirs(join(opts.baseDir, "architecture"));
    const holdoutArchSubs = discoverArchitectureSubDirs(
      join(opts.baseDir, "holdout", "architecture"),
    );
    const searchDirs = [
      ...DEFAULT_GENERAL_DIRS.map((d) => join(opts.baseDir!, d)),
      ...archSubs,
      ...holdoutArchSubs,
    ];
    resolveYamlPath = (caseId: string) => findGeneralCaseYamlPath(caseId, searchDirs);
  } else {
    throw new Error("syncBaselineScores: opts.yamlDir 或 opts.baseDir 至少传一个");
  }

  const byCaseId = new Map<string, BaselineResult[]>();
  for (const r of results) {
    if (!byCaseId.has(r.caseId)) byCaseId.set(r.caseId, []);
    byCaseId.get(r.caseId)!.push(r);
  }

  let updated = 0;
  let droppedHoldout = 0;
  for (const [caseId, caseResults] of byCaseId) {
    const yamlPath = resolveYamlPath(caseId);
    if (!yamlPath) continue;

    // F-H4: 双重防御。yamlPath 含 "/holdout/" 或 yaml 内 holdout: true 必须开关
    const isHoldoutPath = /[\\/]holdout[\\/]/.test(yamlPath);

    const content = readFileSync(yamlPath, "utf-8");
    const doc = yamlLib.parseDocument(content);
    const root = doc.contents as yamlLib.YAMLMap;
    const isHoldoutFlag = root.get("holdout") === true;

    if ((isHoldoutPath || isHoldoutFlag) && !opts.allowHoldout) {
      droppedHoldout += caseResults.length;
      // 不打印 caseId/score 等敏感信息;仅给计数,避免 stdout 也泄露
      process.stderr.write(
        `[baseline-sync] F-H4 holdout case skipped (allowHoldout=false): caseId=<redacted> path=<redacted>\n`,
      );
      continue;
    }

    let baselineNode = root.get("baseline_scores") as yamlLib.YAMLMap | undefined;
    if (!baselineNode) {
      baselineNode = doc.createNode({}) as yamlLib.YAMLMap;
      root.set("baseline_scores", baselineNode);
    }

    for (const r of caseResults) {
      const isTimeout = r.runStatus === "timeout";
      const isError = r.runStatus === "error" || r.runStatus === "abnormal";
      const isAbnormal = isTimeout || isError;
      const safeScore = r.runStatus === "success" ? r.score : null;
      // run_status !== success 时,各 dimensions 同样落 null —— 否则会被 dashboard / 子系统平均值统计
      // 入污染分母（evals/a.md 问题 7）
      const safeDimensions: Record<string, number | null> = isAbnormal
        ? Object.fromEntries(Object.keys(r.dimensions).map((k) => [k, null]))
        : r.dimensions;
      const defaultNotes = isTimeout
        ? `${opts.testerLabel} 超时（score=null,dimensions 已置 null）`
        : isError
          ? `${opts.testerLabel} error（score=null,dimensions 已置 null,仅 run_status 有效）`
          : "";
      const entry: Record<string, unknown> = {
        score: safeScore,
        run_status: r.runStatus,
        tested_at: r.testedAt,
        tested_by: opts.testerLabel,
        transcript_path: r.transcriptPath ?? null,
        notes: r.notes ?? defaultNotes,
        dimensions: safeDimensions,
      };
      // A3-1 / A3-2：写 mandatory_pass / grader_type；abnormal 时 mandatory_pass 落 null（无法判定）
      if (typeof r.mandatoryPass === "boolean") {
        entry.mandatory_pass = isAbnormal ? null : r.mandatoryPass;
      }
      if (typeof r.graderType === "string" && r.graderType.length > 0) {
        entry.grader_type = r.graderType;
      }
      if (r.formulaVersion) {
        entry._formula_version = r.formulaVersion;
      }
      if (r.samples && r.samples.length > 0) {
        entry.samples = r.samples;
      }
      baselineNode.set(r.provider, doc.createNode(entry));
    }

    writeFileSync(yamlPath, doc.toString(), "utf-8");
    updated++;
  }
  if (droppedHoldout > 0) {
    console.warn(
      `  ⚠️ F-H4 holdout 防御:跳过 ${droppedHoldout} 条 holdout result(allowHoldout=false)`,
    );
  }
  console.log(`  回写 baseline_scores: ${updated} 个 case yaml`);
  return updated;
}
