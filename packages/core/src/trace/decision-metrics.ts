/**
 * 会话级「权限决策」（B11）与「一次 edit 成功」（B12）累加器。
 *
 * 纯逻辑、无 IO：collector 负责喂事件、负责落盘；这里只管口径。
 * 分开的理由与 `buildSessionIndexEntry` 同一条 —— 口径要能被单测直接钉住，
 * 而不必先造一整个会话。
 */

import type { PermissionDecisionEvent } from "../permission/decision-telemetry.ts";
import type { ConflictEvent } from "../session/conflict-analytics.ts";

// ─────────────────────────────────────────────────────────────
// B11 · 权限决策
// ─────────────────────────────────────────────────────────────

/**
 * 单会话保留的确认耗时样本上限。确认耗时要跨会话合并后算 p50/p95，
 * 所以落盘的是**原始样本**而不是本会话的分位数（分位数不能再合并）。
 * 封顶是为了不让一个弹窗几百次的会话把索引行撑大；超出部分丢弃但计数照记。
 */
export const MAX_PROMPT_DURATION_SAMPLES = 50;

/** 按维度（工具 / 规则来源）的分桶计数 */
export interface DecisionBucket {
  /** 决策总数 */
  n: number;
  /** 其中弹窗问过人的次数 */
  prompted: number;
}

export interface PermissionDecisionStats {
  /** 决策总数 = HITL 介入率 / 规则命中率的分母 */
  total: number;
  /** 弹窗问过人的次数 = HITL 介入率的分子 */
  prompted: number;
  /** 被拒次数（含弹窗后拒、规则直拒） */
  denied: number;
  /** `reasonType === "rule"` 的次数 = 规则命中率的分子 */
  ruleHits: number;
  /** 弹窗决策的耗时样本（毫秒），最多 MAX_PROMPT_DURATION_SAMPLES 个 */
  promptDurationsMs: number[];
  byTool: Record<string, DecisionBucket>;
  /** 键是 reasonType；决策没带 reason 的进 `none` 桶 —— 不并进 other，二者含义不同 */
  byReason: Record<string, DecisionBucket>;
  /** 键是 Decision.step（管线位置）；旧调用点没传的进 `none` 桶 */
  byStep: Record<string, DecisionBucket>;
  /** 键是决策时的 sid 原生权限模式；没传的进 `none` 桶 */
  byMode: Record<string, DecisionBucket>;
  /**
   * 哨兵：plan / deny-write 模式下放行了写类工具（计划文件 step=3.5 除外）的次数。
   * **恒应为 0**。模式硬约束总闸（checker.enforceModeHardConstraint）上线后，
   * 这里出现非零 = 有一条新放行口绕过了总闸。它防的是回归，不证明修复（修前本机暴露面也是 0）。
   */
  modeGuardBreaches: number;
}

/** 哨兵口径里的「写类工具」：plan / deny-write 下除计划文件外一律不该放行 */
const MODE_GUARDED_WRITE_TOOLS = new Set(["write", "edit", "notebook_edit", "bash"]);
const READ_ONLY_MODES = new Set(["plan", "deny-write"]);

export function emptyPermissionDecisionStats(): PermissionDecisionStats {
  return {
    total: 0,
    prompted: 0,
    denied: 0,
    ruleHits: 0,
    promptDurationsMs: [],
    byTool: {},
    byReason: {},
    byStep: {},
    byMode: {},
    modeGuardBreaches: 0,
  };
}

function bump(map: Record<string, DecisionBucket>, key: string, prompted: boolean): void {
  const b = (map[key] ??= { n: 0, prompted: 0 });
  b.n++;
  if (prompted) b.prompted++;
}

export function accumulatePermissionDecision(
  stats: PermissionDecisionStats,
  e: PermissionDecisionEvent,
): void {
  stats.total++;
  if (e.prompted) stats.prompted++;
  if (e.outcome === "deny") stats.denied++;
  if (e.reasonType === "rule") stats.ruleHits++;
  // 只收**弹过窗**的耗时：规则直放的耗时是微秒级的鉴权开销，混进来会把
  // 「等人确认要多久」的 p50 压成 0，正好掩盖这个指标要回答的问题。
  if (
    e.prompted &&
    typeof e.durationMs === "number" &&
    e.durationMs >= 0 &&
    stats.promptDurationsMs.length < MAX_PROMPT_DURATION_SAMPLES
  ) {
    stats.promptDurationsMs.push(e.durationMs);
  }
  bump(stats.byTool, e.tool, e.prompted);
  bump(stats.byReason, e.reasonType ?? "none", e.prompted);
  bump(stats.byStep, e.step ?? "none", e.prompted);
  bump(stats.byMode, e.mode ?? "none", e.prompted);
  if (
    e.outcome === "allow" &&
    e.mode !== undefined &&
    READ_ONLY_MODES.has(e.mode) &&
    MODE_GUARDED_WRITE_TOOLS.has(e.tool) &&
    e.step !== "3.5"
  ) {
    stats.modeGuardBreaches++;
  }
}

// ─────────────────────────────────────────────────────────────
// B12 · 一次 edit 成功率
// ─────────────────────────────────────────────────────────────

/**
 * 参与「一次 edit 成功率」的工具。
 *
 * **刻意不含 `write`**：write 是整文件覆盖，没有 old_string 匹配这一步，
 * 结构上几乎不会失败（新建文件尤其如此）。把它算进来，每次新建文件都是一个白送的
 * "一次成功"，指标会被会话里新建文件的多少主导，而不是被「改已有代码改得准不准」主导。
 */
const FIRST_TRY_TOOLS = new Set(["edit", "notebook_edit"]);

/** 从工具入参取目标文件路径。edit 用 file_path，notebook_edit 用 notebook_path */
export function editTargetPath(toolName: string, input: unknown): string | undefined {
  if (!FIRST_TRY_TOOLS.has(toolName) || !input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  const p = toolName === "notebook_edit" ? o.notebook_path : o.file_path;
  return typeof p === "string" && p !== "" ? p : undefined;
}

/**
 * 口径（分母与指标一起写死，改了 source 串要跟着改）：
 *
 * - **单位是「文件 × 会话」，不是调用次数**。按调用次数算，一个文件失败 5 次再成功
 *   会贡献 1/6，而同一会话里另一个文件一次成功贡献 1/1 —— 次数越多的文件权重越大，
 *   恰好让「反复返工」本身稀释了返工信号。
 * - **只看该文件在本会话里的第一次真实执行**（PostToolUse），之后的都不改变结论。
 * - **不算 PostToolUseFailure**：那一路是权限拒绝 / hook 阻止 / 参数校验失败 / 异常，
 *   edit 工具根本没开始匹配。前三者是别的方向的信号（更安全 / 工具层），不是「改得准不准」；
 *   异常极少，丢掉的偏差远小于误归因的偏差。
 */
export interface EditFirstTryStats {
  /** 分母：本会话至少真实执行过一次 edit 的文件数 */
  files: number;
  /** 分子：其中第一次执行就成功的文件数 */
  firstTryOk: number;
}

export class EditFirstTryTracker {
  /** 文件路径 → 第一次执行是否成功 */
  private readonly first = new Map<string, boolean>();

  /** 喂一次 PostToolUse。非参与工具或取不到路径时忽略 */
  record(toolName: string, input: unknown, isError: boolean): void {
    const path = editTargetPath(toolName, input);
    if (path === undefined || this.first.has(path)) return;
    this.first.set(path, !isError);
  }

  stats(): EditFirstTryStats {
    let ok = 0;
    for (const v of this.first.values()) if (v) ok++;
    return { files: this.first.size, firstTryOk: ok };
  }

  reset(): void {
    this.first.clear();
  }
}

// ─────────────────────────────────────────────────────────────
// B9 · 并发冲突检测（PR-7）
// ─────────────────────────────────────────────────────────────

/**
 * 会话级并发冲突累加器。
 *
 * 口径与 `PermissionDecisionStats` 同一套原则：只存**计数**与**原始耗时样本**，
 * 不存比率（比率不能跨会话合并，样本可以）。northstar 快照按 release 复算时：
 * - **误报率代理** = `byAction.continue` ÷ `count`（用户在弹窗里裁决"继续"的占比；
 *   `branch_auto_continue` 是无人裁决的自动放行，A1 契约刻意分开，**不进分子**）；
 * - **触发率** = `count` ÷ 同期 edit/write/notebook_edit 次数（分母在别处）。
 *
 * `hitlWaitMs` 与权限弹窗的 `promptDurationsMs` 是 HITL 等待的两个来源，digest 汇总时
 * 相加（B11：冲突弹窗的墙钟此前被误归到工具层耗时）。同样封顶、只收弹过窗的样本。
 */
export interface ConflictStats {
  /** 冲突事件总数 = 触发率分子 / 误报率代理分母 */
  count: number;
  /** 完整 action 分布（键是 ConflictAction）。误报率代理分子取 `continue`，
   *  但要能看到 `branch_auto_continue` / `blocked` / `headless_fallback` 各多少，
   *  否则"误报率降了"分不清是真误报少了还是被自动放行分流了。 */
  byAction: Record<string, number>;
  /** 按触发工具分桶（edit / write / notebook_edit） */
  byTool: Record<string, number>;
  /** 弹窗等人的墙钟样本（毫秒），最多 MAX_PROMPT_DURATION_SAMPLES 个。
   *  只来自 conflictHandler 弹窗分支（event.hitlMs 有值的那些）——自动放行 / block /
   *  无头降级都没有等人，不产生样本。 */
  hitlWaitMs: number[];
}

export function emptyConflictStats(): ConflictStats {
  return {
    count: 0,
    byAction: {},
    byTool: {},
    hitlWaitMs: [],
  };
}

export function accumulateConflictEvent(stats: ConflictStats, e: ConflictEvent): void {
  stats.count++;
  stats.byAction[e.action] = (stats.byAction[e.action] ?? 0) + 1;
  stats.byTool[e.tool] = (stats.byTool[e.tool] ?? 0) + 1;
  // 只收弹过窗的等待：与 accumulatePermissionDecision 同一条口径——自动决策的
  // 耗时是微秒级的判定开销，混进来会把「等人要多久」的 p95 压成 0。
  if (
    typeof e.hitlMs === "number" &&
    e.hitlMs >= 0 &&
    stats.hitlWaitMs.length < MAX_PROMPT_DURATION_SAMPLES
  ) {
    stats.hitlWaitMs.push(e.hitlMs);
  }
}
