/**
 * Plan Mode 状态机
 * 三态：inactive → planning → awaiting_approval
 * 管理计划文件路径、拒绝计数、状态转换
 *
 * 计划文件路径的不变量（P3-1）：`getPlanFilePath() !== null ⇔ isActive() || isExecuting()`。
 * 路径只在 enter() 赋值，只在 forceExit() / completeExecution() 清空。
 *
 * 执行阶段的生命周期（2026-10-24 修正）：approve() 开始，结束只有三个出口——
 * 下一次 enter()（新计划取代旧计划）、forceExit()（取消 / 拒绝超限 / `/clear`）、
 * completeExecution()（计划派生的 todo 清单全部完成）。**用户回合边界不是出口**：
 * 从前每个回合开头都调 endExecution()，用户插一句话、ESC 后说「继续」、后台子代理
 * 完成通知，都会让执行阶段在计划还没做完时被清掉，随之失效的是压缩重注入、
 * 计划文件放行、Recovery Hook 与 fidelity 追踪——计划只在「批准那一轮」可寻址。
 *
 * S6-T07/T08 (ADR-028): 增加 fidelity 追踪 — plan 步骤解析 + actual tool call 对齐.
 */

import { resolve } from "path";
import { mkdirSync, existsSync, openSync, closeSync, statSync, unlinkSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { formatPlanTime, resolvePlanProject, sanitizePlanTopic } from "./slug.ts";
import { sidPaths } from "../config/paths.ts";
import { getCwd } from "../bootstrap/state.ts";

/** Plan Mode 状态 */
export type PlanModeState = "inactive" | "planning" | "awaiting_approval";

/**
 * 状态跃迁的原因（`PlanTransition` 事件的 reason 字段，闭集）。
 * 同一个 to 状态可以由不同原因到达（inactive 有 approve / cancel / reject_limit / clear 四种），
 * 不记原因就分不清「批准后执行」与「被取消」——这正是从前取消路径无法被观测的原因。
 */
export type PlanTransitionReason =
  | "enter"
  | "enter_permission_mode"
  | "submit"
  | "approve"
  | "reject"
  | "reject_limit"
  | "cancel"
  | "todos_completed"
  | "no_approver"
  | "clear";

/**
 * 一份计划的最终结局。exit_plan_mode 在非规划态被调用时据此如实回答，
 * 而不是一律说「已审批通过」——那句话曾让模型把用户取消的计划当成已批准去执行。
 *
 * `plan_only`（2026-10-26）是「计划已产出、但没有任何人批准过」：无头会话没有审批人，
 * 它既不是批准也不是用户取消，用一个独立取值避免让模型把两种情况混为一谈。
 */
export type PlanOutcome =
  | "approved"
  | "cancelled"
  | "rejected_limit"
  | "completed"
  | "cleared"
  | "plan_only";

/** 跃迁附带信息（谁做的决定、用户修改意见多长），只用于可观测性 */
export interface PlanTransitionMeta {
  /** 决策来源：TUI 审批框 / 无头自动批准 / 工具调用 / 权限模式同步 / 命令 */
  source?: "tui" | "headless" | "tool" | "permission_mode" | "command";
  /** 用户修改意见的字符数（只记长度，不落正文） */
  feedbackChars?: number;
}

/** ADR-028: plan markdown 解析后的单步 */
export interface PlanStep {
  index: number;
  description: string;
  matchedActualIndices: number[];
}

/**
 * 步骤计数所用的口径（见 parsePlanFromMarkdown）。随 PlanFidelity / PlanTransition 落盘，
 * 让「这个步数是怎么数出来的」在事后可区分——口径一变曲线就整体平移，分母必须和指标一起写死。
 */
export type PlanStepSource = "step_sections" | "excluding_non_step" | "flat";

/**
 * 步骤解析器口径版本。2026-10-24 前的事件不带此字段（视为 v1：只排除非步骤章节、不隔离围栏）；
 * v2 = 步骤章节优先 + 围栏隔离；v3（2026-10-26）= 缩进续行并入父步骤描述（**步数不变**，
 * 但续行里的路径/命令 token 从此参与锚定，匹配结果会变）。跨版本对比前必须先按版本分组。
 */
export const PLAN_STEP_PARSER_VERSION = 3;

/**
 * fidelity 指标口径版本：**匹配规则或分母规则任一变化就 +1**。
 *
 * 为什么不能只用 `PLAN_STEP_PARSER_VERSION`：那只管「步数怎么数出来」，
 * 而 `off_plan_count` 还取决于两件它管不到的事——
 *   ① 匹配规则（动作词表、锚定阈值、同分裁决）；
 *   ② **分母规则**（哪些调用进 `actualToolCalls`、被权限拒绝的算不算）。
 * 只提升解析器版本会出现「解析器版本没变、分母却变了」的不可比数据：
 * 修复前后混在一起看，就像「偏离率突然下降」，而真实原因只是口径换了。
 *
 * v0（无此字段的历史事件）：记账类工具与被拒调用都计入分母、动作词表不含「新增/增加/添加」；
 * v1（2026-10-26）：记账类与计划文件写入不计入、被拒调用单独计 `denied_count` 且不算偏离、
 *                   edit 动作词补「新增/增加/添加」。
 */
export const FIDELITY_INDICATOR_VERSION = 1;

/**
 * 会计入 fidelity 分母的工具（「会产生计划步骤」的那一类）。
 *
 * 为什么是白名单而不是「排除 todo_write」：`recordActualToolCall` 对所有工具一视同仁
 * （只看工具名与入参、**不看结果**），所以 `task_create` / `task_update` / `save_memory` /
 * `tool_search` 这些记账与检索工具同样会被记成一次偏离——计划里根本没有对应的步骤。
 * 只特判 `todo_write` 的话，下一种记账工具出现就要再改一次，而且漏改的形态是静默的
 * （曲线只是平白多出几个 off-plan）。
 *
 * 白名单的另一面是「宁可漏记也不虚报」（P2-3 的底线）：探索性 `ls` / `tool_search`
 * 不进分母，不产生任何偏离记录。计划文件的写入在 app 层按 `isPlanFile` 另行排除
 * （它需要路径上下文，且要与 plan_recovery 的计数共用同一份口径）。
 */
const FIDELITY_TRACKED_TOOLS = new Set([
  "edit",
  "write",
  "notebook_edit",
  "bash",
  "read",
  "grep",
  "glob",
  "ls",
  "read_many",
  "sub_agent",
]);

/** ADR-028: exit_plan_mode 后实际工具调用记录 */
export interface ActualToolCall {
  index: number;
  toolName: string;
  argsHash: string;
  matchedPlanStepIndex: number | null;
  timestamp: number;
  /**
   * 这次调用被**权限层**拒绝（不是工具执行失败）。
   *
   * 单列的理由是可归因性：fidelity 问的是「模型有没有按计划走」，而权限拒绝是
   * harness 的决定。把它算成偏离的话，权限层一修，偏离率就会「莫名改善」——
   * 两个改动的效果混在一个指标里，谁也说不清是谁的功劳。
   */
  denied?: boolean;
}

/** ADR-028: fidelity 报告 (内核权威信号) */
export interface FidelityReport {
  planStepCount: number;
  actualToolCallCount: number;
  /** actual / plan, plan=0 时返回 NaN */
  stepRatio: number;
  /** matched (matchedPlanStepIndex !== null) 的 actual 占 plan 比例 */
  matchedRatio: number;
  /** matchedPlanStepIndex===null 的 actual 数（不含被权限拒绝的调用） */
  offPlanCount: number;
  /** 其中被权限层拒绝的调用数。单独上报，不进 offPlanCount */
  deniedCount: number;
}

/**
 * Plan Mode 状态变更事件。
 *
 * 执行阶段的开始与结束不改变三态（approve 到 inactive、completeExecution 停在 inactive），
 * 所以 executingBefore / executingAfter 必须单独带出来，否则「执行阶段结束」这件事
 * 在事件流里不存在——从前被回合边界静默清掉时，轨迹里一条痕迹都没有。
 */
export interface PlanModeEvent {
  from: PlanModeState;
  to: PlanModeState;
  /** 跃迁涉及的计划文件（退出类跃迁取退出前的值） */
  planFilePath: string | null;
  reason: PlanTransitionReason;
  executingBefore: boolean;
  executingAfter: boolean;
  /** 跃迁发生时的拒绝次数（reject_limit 取清零前的值） */
  rejectionCount: number;
  meta?: PlanTransitionMeta;
}

/** 状态变更监听器 */
export type PlanModeListener = (event: PlanModeEvent) => void;

/** 进入规划态的入口（/clear 据此决定是否恢复权限模式） */
export type PlanEntrySource = "tool" | "permission_mode";

/** Plan Mode 状态管理器 */
export class PlanModeManager {
  private state: PlanModeState = "inactive";
  private planFilePath: string | null = null;
  private rejectionCount = 0;
  private readonly maxRejections = 5;
  private listeners: PlanModeListener[] = [];
  /**
   * 进入 plan 模式前的权限模式（退出时恢复）。
   *
   * P2-1：这是「退出规划后恢复成什么」的**唯一**事实源。从前另有两份：
   * App._originalPermissionMode（真正被读的那份）与 PermissionChecker.prePlanMode
   * （setPrePlanMode 零调用、恒为 null）；而这一份因为 enter_plan_mode 工具传 undefined
   * 同样恒为 null。三份里只有一份活着，另两份的读者拿到的都是空值。
   */
  private prePlanMode: string | null = null;
  /** 本份计划从哪个入口进入（null = 当前没有计划） */
  private entrySource: PlanEntrySource | null = null;
  /** Plan Mode 提醒注入轮次计数（用于节流：每 N 轮发完整提醒） */
  private reminderTurn = 0;
  /** 完整提醒间隔（每 N 轮发一次完整提醒，其余发简短提醒） */
  private readonly fullReminderInterval = 5;
  /** Plan 文件被 write/edit 成功的时间戳序列（plan_recovery capability 用） */
  private planFileUpdates: number[] = [];
  /**
   * 是否处于"执行阶段"——计划已被 approve、正在按计划执行。
   *
   * 与三态状态机正交——执行阶段权限模式已恢复（非 plan），但语义上仍"在按计划干活"。
   * 出口见文件头注释：enter() / forceExit() / completeExecution()，没有「回合边界」。
   */
  private executing = false;
  /**
   * 上一份计划的结局。enter() 清零，进入终态（批准 / 取消 / 超限 / 完成 / 清空）时写入。
   * exit_plan_mode 在非规划态下据此回答「你的计划现在是什么状态」。
   */
  private lastOutcome: PlanOutcome | null = null;

  // ADR-028: fidelity 追踪字段
  /** 解析 plan markdown 拿到的步骤 */
  private planSteps: PlanStep[] = [];
  /** 最近一次解析用的口径（见 PlanStepSource） */
  private planStepSource: PlanStepSource = "flat";
  /** exit_plan_mode 后的工具调用记录 */
  private actualToolCalls: ActualToolCall[] = [];
  /**
   * 与 actualToolCalls 下标一一对应的参数值（collectArgValues 的结果）。
   * 执行期计划被修订后要拿新步骤重新对齐历史调用，只存哈希做不到这一点；
   * 不放进 ActualToolCall 是因为它是对外报告结构，参数值不该随报告外流。
   */
  private actualArgValues: string[][] = [];

  /** 获取进入 plan 前的权限模式 */
  getPrePlanMode(): string | null {
    return this.prePlanMode;
  }

  /** 本份计划的进入入口（无计划时 null） */
  getEntrySource(): PlanEntrySource | null {
    return this.entrySource;
  }

  /** 上一份计划的结局（规划中 / 从未有过计划时为 null） */
  getLastOutcome(): PlanOutcome | null {
    return this.lastOutcome;
  }

  /**
   * 进入 Plan Mode
   * @param currentPermissionMode 进入前的权限模式；传 "plan" 视同未知（不能「恢复成 plan」）
   * @param source 进入入口。enter_plan_mode 工具为 "tool"，权限模式同步为 "permission_mode"
   */
  enter(currentPermissionMode?: string, topic?: string, source: PlanEntrySource = "tool"): boolean {
    if (this.state !== "inactive") return false;
    const from = this.state;
    const executingBefore = this.executing;
    this.state = "planning";
    this.rejectionCount = 0;
    this.reminderTurn = 0;
    // 进入新计划 = 上一份计划的执行阶段被取代（这是执行阶段的出口之一）
    this.executing = false;
    this.lastOutcome = null;
    this.entrySource = source;
    // B17：fidelity 追踪按「一份计划」计。同一会话第二次进入规划时不清，
    // 上一份计划执行期的调用会被算进这一份的「实际调用数 / 偏离数」。
    this.planSteps = [];
    this.planStepSource = "flat";
    this.actualToolCalls = [];
    this.actualArgValues = [];
    this.planFileUpdates = [];
    this.prePlanMode =
      currentPermissionMode && currentPermissionMode !== "plan" ? currentPermissionMode : null;
    this.planFilePath = this.reservePlanFile(topic);
    this.emit({
      from,
      to: this.state,
      planFilePath: this.planFilePath,
      reason: source === "permission_mode" ? "enter_permission_mode" : "enter",
      executingBefore,
      executingAfter: false,
      rejectionCount: 0,
      meta: { source },
    });
    return true;
  }

  /**
   * P2-1：让状态机跟上「权限模式已经是 plan」这个事实。返回是否本次新进入了规划态。
   *
   * 进入规划态有两条路：enter_plan_mode 工具（调 enter()），以及
   * `--permission-mode plan` / settings / CLAUDE.md 规则——后者只写
   * `config.permissionMode = "plan"`，从前**没有任何代码调 enter()**：
   * 权限层的只读硬拦生效了，行为层整段缺席（无计划文件路径、exit_plan_mode 走
   * 「已进入执行阶段」分支、没有审批），而每轮提醒仍在要求「写计划并提交审批」。
   *
   * 由 App 在每个用户回合开始时调用。已在规划 / 待审批时是 no-op；
   * 进入前的模式记为 null（启动即 plan，没有「之前」），退出时恢复成 default。
   * 子代理不走这里：子代理被禁止进入规划态（enter_plan_mode 拦 _agentId），
   * frontmatter 的 permissionMode: plan 对它只意味着只读，这是对的。
   */
  syncWithPermissionMode(permissionMode: string | undefined): boolean {
    if (permissionMode !== "plan" || this.isActive()) return false;
    return this.enter(undefined, undefined, "permission_mode");
  }

  /** 提交计划等待审批 */
  submitForApproval(): boolean {
    if (this.state !== "planning") return false;
    const from = this.state;
    this.state = "awaiting_approval";
    this.emit({
      from,
      to: this.state,
      planFilePath: this.planFilePath,
      reason: "submit",
      executingBefore: false,
      executingAfter: false,
      rejectionCount: this.rejectionCount,
      meta: { source: "tool" },
    });
    return true;
  }

  /** 用户批准计划 → 退出 Plan Mode，进入执行阶段 */
  approve(meta?: PlanTransitionMeta): boolean {
    if (this.state !== "awaiting_approval") return false;
    const from = this.state;
    this.state = "inactive";
    // 进入执行阶段。此后权限模式已恢复（非 plan），但语义上在按计划执行，
    // Recovery Hook / 权限链 Step 3.5 / 压缩重注入都据 isExecuting() 判断。
    this.executing = true;
    this.lastOutcome = "approved";
    this.emit({
      from,
      to: this.state,
      planFilePath: this.planFilePath,
      reason: "approve",
      executingBefore: false,
      executingAfter: true,
      rejectionCount: this.rejectionCount,
      ...(meta ? { meta } : {}),
    });
    return true;
  }

  /**
   * 用户拒绝计划 → 回到 planning 继续修改
   * 返回 true 表示可以继续修改，false 表示超过拒绝上限已强制退出
   *
   * P3-1：超限分支改走 forceExit()，让「退出规划」只有一个出口。从前这里直接
   * 改 state、不清 planFilePath，于是超限退出后路径残留，与「路径在 = 有活跃计划」
   * 的语义不符（今天没出错只是因为消费方另有 isPlanning/isExecuting 的门）。
   */
  reject(meta?: PlanTransitionMeta): boolean {
    if (this.state !== "awaiting_approval") return false;
    this.rejectionCount++;
    if (this.rejectionCount >= this.maxRejections) {
      this.exitPlan("reject_limit", "rejected_limit", meta);
      return false;
    }
    const from = this.state;
    this.state = "planning";
    this.emit({
      from,
      to: this.state,
      planFilePath: this.planFilePath,
      reason: "reject",
      executingBefore: false,
      executingAfter: false,
      rejectionCount: this.rejectionCount,
      ...(meta ? { meta } : {}),
    });
    return true;
  }

  /** 拒绝上限（拒绝消息里告诉模型「第 n / N 次」用） */
  getMaxRejections(): number {
    return this.maxRejections;
  }

  /**
   * 强制退出 Plan Mode：用户取消（默认）或 `/clear`。
   *
   * P1-1：`state === "inactive"` 时不无条件 return——执行阶段的 state 正是
   * inactive 而 isExecuting() 为真，「用户取消」必须真的关掉执行阶段
   * （它是权限链 Step 3.5 的放行条件之一）。
   *
   * P3-1：退出时同时清 planFilePath。不变量是
   * `getPlanFilePath() !== null ⇔ isActive() || isExecuting()`。
   * 事件里的 planFilePath 取退出前的值，监听方仍能知道退出的是哪份计划。
   */
  forceExit(reason: "cancel" | "clear" = "cancel", meta?: PlanTransitionMeta): void {
    this.exitPlan(reason, reason === "clear" ? "cleared" : "cancelled", meta);
  }

  /**
   * 无头会话里计划已产出、但**没有任何审批人**时收尾。
   *
   * 2026-10-26：从前无头会话一律自动 approve，而 `--permission-mode plan` 启动的会话
   * 没有「进入之前的模式」，`deactivatePlanMode` 恢复成 default，`-p` 下 default 的 ask
   * 全部被 `isNonInteractive()` 落成 deny——harness 先自动批准、紧接着拒绝执行，
   * 批准等于白做。现在的语义是：没有审批人就不假装批准，把计划留在磁盘上作为交付物，
   * 用独立的 outcome（`plan_only`）让 `exit_plan_mode` 能如实回答「这份计划没被批准过」。
   *
   * 只在待审批态生效。刻意复用 `exitPlan` 这个唯一出口：清理范围（占位文件回收、
   * fidelity 归零）与其他四条退出路径保持一致，不会各写一份然后漂移。
   */
  endWithoutApproval(meta?: PlanTransitionMeta): boolean {
    if (this.state !== "awaiting_approval") return false;
    this.exitPlan("no_approver", "plan_only", meta);
    return true;
  }

  /**
   * 计划执行完毕（计划派生的 todo 清单全部完成）→ 结束执行阶段。
   * 只在执行阶段生效；规划中 / 待审批 / 无计划时是 no-op，返回是否真的结束了。
   */
  completeExecution(): boolean {
    if (!this.executing || this.isActive()) return false;
    this.exitPlan("todos_completed", "completed");
    return true;
  }

  /**
   * 所有「退出计划」的唯一出口（取消 / 清空 / 拒绝超限 / 执行完毕）。
   * 收在一处是为了让清理范围、占位文件回收、事件形态不会在四条路径上各写一份然后漂移。
   */
  private exitPlan(
    reason: "cancel" | "clear" | "reject_limit" | "todos_completed" | "no_approver",
    outcome: PlanOutcome,
    meta?: PlanTransitionMeta,
  ): void {
    if (this.state === "inactive" && !this.executing) return;
    const from = this.state;
    const executingBefore = this.executing;
    const exitedPlanFilePath = this.planFilePath;
    const rejectionCount = this.rejectionCount;
    this.state = "inactive";
    this.rejectionCount = 0;
    this.reminderTurn = 0;
    // 正常执行完毕时保留更新次数：plan_recovery 评测在会话收尾后读它，
    // 清掉就等于把「执行期按守则改过几次计划」这个被测量本身抹掉。下一次 enter() 会清。
    // 取消 / 清空 / 超限是作废，计数随计划一起作废（既有契约）。
    if (reason !== "todos_completed") this.planFileUpdates = [];
    this.planSteps = [];
    this.planStepSource = "flat";
    this.actualToolCalls = [];
    this.actualArgValues = [];
    this.executing = false;
    this.planFilePath = null;
    this.entrySource = null;
    this.lastOutcome = outcome;
    // 占位文件从没被写入过 → 回收。有内容的计划文件是用户的决策记录，一律保留。
    if (exitedPlanFilePath) PlanModeManager.removeIfEmpty(exitedPlanFilePath);
    this.emit({
      from,
      to: this.state,
      planFilePath: exitedPlanFilePath,
      reason,
      executingBefore,
      executingAfter: false,
      rejectionCount,
      ...(meta ? { meta } : {}),
    });
  }

  // ── 查询方法 ──

  isActive(): boolean {
    return this.state !== "inactive";
  }
  isPlanning(): boolean {
    return this.state === "planning";
  }
  isAwaitingApproval(): boolean {
    return this.state === "awaiting_approval";
  }
  /**
   * 是否处于执行阶段（计划已 approve、正在按计划执行）。
   * 与 isActive() 正交：执行阶段 state 已是 inactive、权限模式已恢复，但 isExecuting() 为真。
   * Recovery Hook 据此在执行阶段工具失败时触发。
   */
  isExecuting(): boolean {
    return this.executing;
  }
  getState(): PlanModeState {
    return this.state;
  }
  getPlanFilePath(): string | null {
    return this.planFilePath;
  }
  getRejectionCount(): number {
    return this.rejectionCount;
  }

  /** 检查给定路径是否为当前计划文件 */
  isPlanFile(filePath: string): boolean {
    if (!this.planFilePath) return false;
    return resolve(filePath) === resolve(this.planFilePath);
  }

  /**
   * 推进提醒轮次并返回本轮是否应发"完整提醒"。
   * 节流策略：第 1 轮完整，第 2..(N-1) 轮简短，第 N 轮再次完整，循环往复。
   * 由 app.ts 在每次注入 plan 提醒时调用。
   */
  nextReminderIsFull(): boolean {
    this.reminderTurn++;
    return this.reminderTurn === 1 || this.reminderTurn % this.fullReminderInterval === 0;
  }

  // ── plan_recovery capability 用 ──

  /**
   * 记录一次 plan 文件 write/edit 成功
   * 由 app.ts:handlePlanModeTransitions 在工具执行成功后调用。
   *
   * P1-1：接受条件从 `state !== "inactive"` 改为「规划态 **或** 执行阶段」。
   * 从前用 `state === "inactive"` 当拒绝条件，把执行阶段整个排除了——
   * approve() 之后 state 正是 inactive 而 isExecuting() 为真（两者刻意正交，
   * 见 executing 字段注释）。而批准消息要求的「失败先更新计划文件」全部发生在
   * 执行阶段，于是 plan_recovery 评测读到的 getPlanFileUpdateCount()
   * 恒等于规划阶段的写入次数，执行阶段的更新一次都不计。
   *
   * 用 isActive() || isExecuting() 而不是继续用 state 的取反，是为了让三个
   * 消费同一语义的地方（Recovery Hook、权限链 Step 3.5、本计数器）认同一个标志。
   */
  recordPlanFileWrite(timestamp: number = Date.now()): boolean {
    if (!this.isActive() && !this.isExecuting()) return false;
    this.planFileUpdates.push(timestamp);
    return true;
  }

  /** 获取 plan 文件被 write/edit 的总次数（含初次 write） */
  getPlanFileUpdateCount(): number {
    return this.planFileUpdates.length;
  }

  /** 获取 plan 文件更新时间戳序列（capability runner 透传给 grader 用） */
  getPlanFileUpdateHistory(): readonly number[] {
    return this.planFileUpdates;
  }

  // ── ADR-028 fidelity 追踪 ──

  /**
   * 解析 plan markdown 拿到步骤列表，存入 this.planSteps（多次调用以最后一次为准）。
   *
   * 只认**顶层**列表项（`1. xxx` / `1) xxx` / `- xxx` / `* xxx`），缩进子项与代码围栏内的
   * 内容一律不计。哪些章节算步骤，按三档口径依次取（见 PlanStepSource）：
   *
   *   1. step_sections —— 存在「步骤类」标题（实施步骤 / 修改方案 / Steps …）且其下有列表项：
   *      **只数这些章节**。这是 buildPlanModePrompt 要求模型写的形态，也是唯一不靠猜的口径。
   *   2. excluding_non_step —— 有标题但没有步骤类标题：排除「非步骤」章节后计数。
   *   3. flat —— 一个标题都没有的朴素计划：全部计数。
   *
   * 2026-10-24 为什么从「只排除非步骤章节」改成「步骤章节优先」：否定口径要求关键词表
   * 穷举模型可能起的所有非步骤标题，而模型的标题是开放集。实测本机全部 7 份真实计划
   * （缺陷单只读分析）都用「结论 / 根因 / 修改方案 / 影响面 / 自测方式 / 需要补充」，
   * 词表只认得「结论」，于是 plan_step_count 记成 11–20，真实修改项只有 3–5，
   * 7/7 跨过 >= 3 的「todo 必须覆盖全部 N 步」强制令门槛。肯定口径只需要认得
   * 少数几种「步骤」标题，否定口径退为兜底。
   *
   * 代码围栏必须隔离：围栏里的 `- name: x` 会被数成步骤，围栏里的 `# 注释` 会被当成标题
   * 改写章节归属（实测一条 bash 注释能让其后整节「风险」被数成步骤）。
   */
  parsePlanFromMarkdown(md: string): PlanStep[] {
    if (typeof md !== "string") {
      this.planSteps = [];
      this.planStepSource = "flat";
      this.realignActualCalls();
      return [];
    }
    const { steps, source } = PlanModeManager.extractPlanSteps(md);
    this.planSteps = steps;
    this.planStepSource = source;
    // 执行期计划被修订（失败守则要求先改计划再继续）后，已发生的调用要按新步骤重新对齐，
    // 否则 fidelity 一直拿批准那一刻的旧步骤算，修订后的计划在报告里不存在。
    this.realignActualCalls();
    return steps;
  }

  /** 最近一次解析所用的步骤口径（PlanFidelity / PlanTransition 埋点用） */
  getPlanStepSource(): PlanStepSource {
    return this.planStepSource;
  }

  /**
   * 纯函数版解析：不改实例状态。digest 用它按**当前口径**重算历史计划文件的步数，
   * 与事件里记录的旧口径对照（数据层面的口径迁移，见 PLAN_STEP_PARSER_VERSION）。
   */
  static extractPlanSteps(md: string): { steps: PlanStep[]; source: PlanStepSource } {
    type Section = { kind: "step" | "non_step" | "neutral"; items: string[] };
    // 第一个「章节」是标题之前的前言，按中性处理（向后兼容不写标题的朴素计划）
    const sections: Section[] = [{ kind: "neutral", items: [] }];
    let sawHeading = false;
    let fence: string | null = null;
    const orderedRe = /^\d+[.)]\s+(.+)$/;
    const dashRe = /^[-*]\s+(.+)$/;
    const headingRe = /^#{1,6}\s+(.+)$/;
    // CommonMark：围栏最多缩进 3 格；用 ``` 开的只能用 ``` 关（~~~ 同理）
    const fenceRe = /^ {0,3}(`{3,}|~{3,})/;
    for (const raw of md.split(/\r?\n/)) {
      const fm = raw.match(fenceRe);
      if (fm) {
        const marker = fm[1];
        if (fence === null) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        continue;
      }
      if (fence !== null) continue;
      const hm = raw.match(headingRe);
      if (hm) {
        sawHeading = true;
        sections.push({ kind: PlanModeManager.classifyHeading(hm[1]), items: [] });
        continue;
      }
      // 缩进续行：不产生新步骤，但**并入上一条列表项的描述**。
      //
      // 2026-10-26：从前这里是 `continue`——续行里的路径、命令、文件名全部被丢掉，
      // 锚定只能靠第一行的 token。真实计划经常把「改哪个文件」写在子项里
      // （`1. 修复登录\n   - 改 src/auth.ts`），那一步就永远锚定不上任何调用。
      //
      // 选「并入」而不是「算新步骤」：**步数是分母**，并入不改分母（既有测试契约不变，
      // 「嵌套子项不计 step」仍然成立），只让匹配多一分依据；算新步骤会把一步拆成两步，
      // 等于悄悄改了分母口径——那正是「分母比分子重要」这条铁律要防的事。
      if (/^\s/.test(raw)) {
        const text = raw
          .trim()
          .replace(/^(?:\d+[.)]|[-*])\s+/, "")
          .trim();
        const items = sections[sections.length - 1].items;
        if (text && items.length > 0) {
          items[items.length - 1] = `${items[items.length - 1]} ${text}`;
        }
        continue;
      }
      const m = raw.match(orderedRe) ?? raw.match(dashRe);
      if (m) sections[sections.length - 1].items.push(m[1].trim());
    }

    let source: PlanStepSource;
    let picked: Section[];
    if (sections.some((s) => s.kind === "step" && s.items.length > 0)) {
      source = "step_sections";
      picked = sections.filter((s) => s.kind === "step");
    } else if (sawHeading) {
      source = "excluding_non_step";
      picked = sections.filter((s) => s.kind !== "non_step");
    } else {
      source = "flat";
      picked = sections;
    }
    const steps: PlanStep[] = [];
    for (const s of picked) {
      for (const description of s.items) {
        steps.push({ index: steps.length + 1, description, matchedActualIndices: [] });
      }
    }
    return { steps, source };
  }

  /**
   * 标题分类。顺序有讲究：
   *   ① 强非步骤词（决策记录 / 风险 / 替代方案）先判——「## 三、风险与回滚步骤」仍是风险节，
   *      「替代方案」含「方案」但不是要执行的方案；
   *   ② 再判步骤词——「## 实施步骤与目标」含弱非步骤词「目标」，但它是步骤节；
   *   ③ 最后判弱非步骤词（背景 / 根因 / 影响面 / 验证 …）。
   * 都不命中为中性：在 excluding_non_step 口径下照常计数。
   */
  private static classifyHeading(title: string): "step" | "non_step" | "neutral" {
    // 去掉 markdown 强调符与前后空白，统一小写便于匹配英文标题
    const t = title
      .replace(/[*_`#]/g, "")
      .trim()
      .toLowerCase();
    const has = (kws: readonly string[]) => kws.some((kw) => t.includes(kw));
    if (has(PlanModeManager.STRONG_NON_STEP_KEYWORDS)) return "non_step";
    if (has(PlanModeManager.STEP_HEADING_KEYWORDS)) return "step";
    if (has(PlanModeManager.NON_STEP_HEADING_KEYWORDS)) return "non_step";
    return "neutral";
  }

  /**
   * 步骤类标题关键词（子串匹配）。buildPlanModePrompt 要求写「## 实施步骤」，
   * 其余是真实计划里出现过的同义写法（「修改方案」来自本机 7 份真实计划）。
   */
  private static readonly STEP_HEADING_KEYWORDS: readonly string[] = [
    "步骤",
    "实施",
    "执行计划",
    "修改方案",
    "改动方案",
    "修复方案",
    "实现方案",
    "改动清单",
    "任务清单",
    "todo",
    "step",
    "implementation",
    "action plan",
    "changes",
    "tasks",
  ];

  /** 强非步骤词：命中即非步骤，优先级高于步骤词 */
  private static readonly STRONG_NON_STEP_KEYWORDS: readonly string[] = [
    "决策记录",
    "风险",
    "替代",
    "decision",
    "risk",
    "alternative",
  ];

  /**
   * 弱非步骤词（子串匹配，中英各一组）：只在没命中步骤词时生效。
   * 后半段（根因 / 影响面 / 自测 / 置信度 / 需要补充）来自本机真实计划的章节结构——
   * 旧词表一个都不认得，那 7 份计划的步数因此虚高 3–5 倍。
   */
  private static readonly NON_STEP_HEADING_KEYWORDS: readonly string[] = [
    "背景",
    "现状",
    "目标",
    "参考",
    "附录",
    "备注",
    "结论",
    "验收",
    "边界情况",
    "未决问题",
    "根因",
    "原因",
    "分析",
    "影响",
    "自测",
    "测试方式",
    "验证",
    "置信度",
    "需要补充",
    "待确认",
    "问题",
    "概述",
    "摘要",
    "background",
    "context",
    "goal",
    "reference",
    "appendix",
    "note",
    "open question",
    "acceptance",
    "trade-off",
    "tradeoff",
    "root cause",
    "analysis",
    "impact",
    "verification",
    "testing",
    "confidence",
    "summary",
    "overview",
  ];

  /**
   * 记录一次 actual 工具调用 (在 exit_plan_mode 之后调用方负责调).
   * 用 description 中第一个名词 / 工具名做 fuzzy match — 命中算 matched, 否则 off-plan.
   *
   * 2026-10-26 两条口径变化（见 `FIDELITY_INDICATOR_VERSION`）：
   *   ① **只有 `FIDELITY_TRACKED_TOOLS` 里的工具进分母**。记账类（todo_write / task_* /
   *      save_memory）与检索类（tool_search）不是计划步骤的执行动作，从前它们会被
   *      记成「计划外」，让曲线平白多出偏离。返回 null 表示本次调用未被记录。
   *   ② `opts.denied` 标记**权限层拒绝**（不是工具执行失败）。这类调用仍计入
   *      `actualToolCallCount`（它确实是模型发起的），但不计入 `offPlanCount`——
   *      偏离问的是模型有没有按计划走，权限拒绝是 harness 的决定。
   *
   * 计划文件自身的写入由调用方（app.ts）按 `isPlanFile` 先行排除，不在这里判：
   * 那需要路径上下文，且要与 plan_recovery 的计数共用同一份路径口径。
   */
  recordActualToolCall(
    toolName: string,
    args: unknown,
    opts?: { denied?: boolean },
  ): ActualToolCall | null {
    if (!FIDELITY_TRACKED_TOOLS.has(toolName)) return null;
    const argsHash = this.hashArgs(args);
    const argValues = PlanModeManager.collectArgValues(args);
    const next: ActualToolCall = {
      index: this.actualToolCalls.length + 1,
      toolName,
      argsHash,
      matchedPlanStepIndex: this.matchAgainstPlan(toolName, argValues),
      timestamp: this.now(),
      ...(opts?.denied ? { denied: true } : {}),
    };
    this.actualToolCalls.push(next);
    this.actualArgValues.push(argValues);
    if (next.matchedPlanStepIndex !== null) {
      const step = this.planSteps.find((s) => s.index === next.matchedPlanStepIndex);
      if (step) step.matchedActualIndices.push(next.index);
    }
    return next;
  }

  /**
   * 按当前 planSteps 从头重放已记录的调用。必须按原顺序逐条重放：
   * matchAgainstPlan 的同分裁决看「该步骤是否已被命中」，一次性并行算会改变结果。
   */
  private realignActualCalls(): void {
    for (const s of this.planSteps) s.matchedActualIndices = [];
    for (let i = 0; i < this.actualToolCalls.length; i++) {
      const call = this.actualToolCalls[i];
      call.matchedPlanStepIndex = this.matchAgainstPlan(
        call.toolName,
        this.actualArgValues[i] ?? [],
      );
      if (call.matchedPlanStepIndex !== null) {
        const step = this.planSteps.find((s) => s.index === call.matchedPlanStepIndex);
        if (step) step.matchedActualIndices.push(call.index);
      }
    }
  }

  /**
   * ADR-028 §3.1: 内核权威 fidelity 报告
   *
   * 2026-10-26 分母口径（见 `FIDELITY_INDICATOR_VERSION`）：
   *   · `actualToolCallCount` 含被拒调用——它们确实是模型发起的动作；
   *   · `offPlanCount` **不含**被拒调用——权限拒绝是 harness 的决定，不是模型的偏离；
   *   · `deniedCount` 单独上报，让「权限层拦了多少」与「模型偏离了多少」可分开归因。
   */
  getFidelityReport(): FidelityReport {
    const planStepCount = this.planSteps.length;
    const actualToolCallCount = this.actualToolCalls.length;
    const deniedCount = this.actualToolCalls.filter((c) => c.denied).length;
    const offPlanCount = this.actualToolCalls.filter(
      (c) => !c.denied && c.matchedPlanStepIndex === null,
    ).length;
    const matchedActualCount = actualToolCallCount - deniedCount - offPlanCount;
    const stepRatio = planStepCount === 0 ? Number.NaN : actualToolCallCount / planStepCount;
    const matchedRatio = planStepCount === 0 ? Number.NaN : matchedActualCount / planStepCount;
    return {
      planStepCount,
      actualToolCallCount,
      stepRatio,
      matchedRatio,
      offPlanCount,
      deniedCount,
    };
  }

  /** 单测/runner 注入用 — 重置 fidelity 追踪状态 */
  resetFidelity(): void {
    this.planSteps = [];
    this.planStepSource = "flat";
    this.actualToolCalls = [];
    this.actualArgValues = [];
  }

  // ── 事件监听 ──

  onStateChange(listener: PlanModeListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** 监听方抛错不得打断状态机（埋点是旁路，跃迁已经发生） */
  private emit(event: PlanModeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* 旁路失败不影响状态机 */
      }
    }
  }

  // ── 内部方法 ──

  /**
   * 生成计划文件路径并**原子占位**（O_EXCL 创建空文件），返回占到的路径。
   *
   * 2026-10-24：从前只算路径、不建文件，去重靠 `existsSync`——文件要等模型 write 才存在。
   * 同一分钟、同项目、同主题进入规划的两个会话（多 agent 并行 / 多终端 / 批量评测）
   * 都看见「不存在」，拿到同一个路径，后写的那份静默覆盖前一份。`existsSync` + 之后再写
   * 是典型的 check-then-act 竞态；`openSync(path, "wx")` 把「检查」和「占用」合成一个
   * 系统调用，EEXIST 时序号 +1 重试。
   *
   * 占位的空文件有三处配套：write 工具把「已存在但 0 字节」当新建处理（无内容可冲掉，
   * 不要求先 read）；exitPlan 回收从未写入的占位；startup-housekeeping 回收崩溃遗留的
   * 空占位。占位失败（只读文件系统等）退回只算路径，行为同从前。
   */
  private reservePlanFile(topic?: string): string {
    const project = resolvePlanProject(getCwd());
    const dir = sidPaths.plansForProject(project);
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* 目录建不出来时下面的 openSync 会失败，走兜底 */
    }
    const time = formatPlanTime();
    const safeTopic = sanitizePlanTopic(topic);
    const base = safeTopic ? `${time}-${safeTopic}` : time;
    let candidate = sidPaths.plan(project, base);
    for (let n = 2; n < 10_000; n++) {
      try {
        closeSync(openSync(candidate, "wx"));
        return candidate;
      } catch (err: any) {
        if (err?.code !== "EEXIST") break;
      }
      candidate = sidPaths.plan(project, `${base}-${n}`);
    }
    // 兜底：占不了位（只读 FS / 权限）时至少别撞已存在的文件
    let fallback = sidPaths.plan(project, base);
    let n = 2;
    while (existsSync(fallback)) fallback = sidPaths.plan(project, `${base}-${n++}`);
    return fallback;
  }

  /** 计划文件是否已有内容（占位的空文件 / 只有空白都算「尚未写」） */
  static hasPlanContent(filePath: string | null): boolean {
    if (!filePath) return false;
    try {
      if (statSync(filePath).size === 0) return false;
      return readFileSync(filePath, "utf-8").trim().length > 0;
    } catch {
      return false;
    }
  }

  /** 0 字节的占位文件才删；任何有内容的计划文件都是用户资产，不碰 */
  private static removeIfEmpty(filePath: string): void {
    try {
      if (statSync(filePath).size === 0) unlinkSync(filePath);
    } catch {
      /* 不存在 / 无权限：无事可做 */
    }
  }

  // ── ADR-028 内部 helper ──

  /**
   * 把 toolName + args 摘要做哈希, 用于偏差检测 (单测可断言 hash 稳定).
   */
  private hashArgs(args: unknown): string {
    let serial: string;
    try {
      serial = JSON.stringify(args ?? null);
    } catch {
      serial = String(args);
    }
    return createHash("sha1").update(serial).digest("hex").slice(0, 12);
  }

  /**
   * 把 actual tool call 与 planSteps 对齐，返回**最佳**匹配步骤的 index，对不上返回 null。
   *
   * 一个步骤成为候选须同时满足：
   *   ① 语义对得上 —— 工具名字面出现在描述里，或描述含该工具对应的动作词；
   *   ② 参数锚定 —— 描述里至少有一个 token 与本次调用的参数值对得上（见 anchorScore）。
   * 候选里取锚定分最高者；同分时优先尚未被命中的步骤，再按计划顺序。
   *
   * P2-3：从前②不是必要条件（动作词命中、锚定失败也 `return step.index`），
   * 且按计划顺序**第一个**命中即返回。两条合起来：任何一次 read 都会被记成
   * 「计划第一个读步骤」的执行——实测 `read /etc/hosts` 被算成「读 package.json」，
   * matchedRatio 凭空 +0.25；计划里后面几个读步骤永远显示未执行。
   * 保真度报告的全部价值在于「计划外」能被认出来，所以这里宁可漏记（算成 off-plan）
   * 也不虚报：中文描述不带空格、写不出可锚定 token 的步骤，现在会被判为未命中。
   *
   * 注意: 一个 step 可被多个 actual 命中 (matchedActualIndices 是 list).
   */
  private matchAgainstPlan(toolName: string, argValues: string[]): number | null {
    if (this.planSteps.length === 0) return null;
    if (argValues.length === 0) return null;
    const lowerTool = toolName.toLowerCase();
    const verbs = PlanModeManager.TOOL_VERBS[lowerTool] ?? [];

    let best: { step: PlanStep; score: number } | null = null;
    for (const step of this.planSteps) {
      const desc = step.description.toLowerCase();
      const semantic = desc.includes(lowerTool) || verbs.some((v) => desc.includes(v));
      if (!semantic) continue;
      const score = PlanModeManager.anchorScore(desc, argValues, lowerTool, verbs);
      if (score === 0) continue;
      if (
        !best ||
        score > best.score ||
        (score === best.score &&
          best.step.matchedActualIndices.length > 0 &&
          step.matchedActualIndices.length === 0)
      ) {
        best = { step, score };
      }
    }
    return best ? best.step.index : null;
  }

  /**
   * 工具 → 描述里对应的动作词（中英）。
   *
   * 2026-10-26：edit 补上「新增 / 增加 / 添加」。实测证据会话里计划第 1 步写的是
   * 「**新增 sub 函数**：在 `math.js` 中按 `add` 的现有风格新增并导出」——语义对得上，
   * 但旧词表只有「改 / 修改 / edit」，语义门槛没过，`edit math.js` 被记成偏离，
   * `matchedRatio` 为 0。补词后同一条调用命中 step1（已在重放脚本里逐条核对）。
   *
   * ⚠️ **扩词是开放集方向，与 P2-3「宁可漏记也不虚报」相反**：动词无穷，扩一次就可能
   * 引入一类误报。所以只补有实测证据的词，且必须配反例测试——锚定（anchorScore）
   * 仍是硬门槛，语义命中但没有参数锚定的步骤依然不会匹配。
   */
  private static readonly TOOL_VERBS: Readonly<Record<string, readonly string[]>> = {
    read: ["读", "查看", "看", "load"],
    edit: ["改", "修改", "edit", "新增", "增加", "添加"],
    write: ["写", "创建", "新建", "write"],
    bash: ["跑", "执行", "运行", "run"],
    grep: ["搜", "查找", "grep"],
    glob: ["遍历", "list"],
    exit_plan_mode: ["exit_plan", "完成", "提交"],
  };

  /**
   * 取参数里的**值**（递归收集字符串 / 数字，统一小写），不取键名。
   * 从前拿整个 JSON.stringify 做子串匹配，键名 `file_path` / `command` 也参与，
   * 描述里任何碰巧是键名子串的 token 都会锚定成功。
   */
  private static collectArgValues(args: unknown): string[] {
    const out: string[] = [];
    const walk = (v: unknown, depth: number): void => {
      if (depth > 4 || v === null || v === undefined) return;
      if (typeof v === "string") {
        const t = v.trim().toLowerCase();
        if (t) out.push(t);
      } else if (typeof v === "number") {
        out.push(String(v));
      } else if (Array.isArray(v)) {
        for (const x of v) walk(x, depth + 1);
      } else if (typeof v === "object") {
        for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
      }
    };
    walk(args, 0);
    return out;
  }

  /**
   * 描述 token 与参数值的锚定分（命中的不同 token 数，0 = 锚定失败）。
   *
   * 一个 token 算命中：与某个参数值全等，或与参数值按空白 / 路径分隔符切出的某段全等，
   * 或（token 长度 ≥ 2 时）是参数值的子串。单字符 token 只认全等，
   * 否则 `a` 会命中几乎所有参数。工具名与动作词本身不算锚点——它们已经在①里用过了。
   */
  private static anchorScore(
    desc: string,
    argValues: string[],
    lowerTool: string,
    verbs: readonly string[],
  ): number {
    // B17：`*` 也是分隔符。模型写计划几乎总用加粗（`1. **读取 package.json**`），
    // 不切掉的话 token 是 `package.json**`，任何参数都对不上 —— 真实会话里
    // 严格按计划执行的 2 次 read 被记成 2 次偏离。`_` 不切：它常出现在文件名里。
    const tokens = new Set(
      desc
        .split(/[\s,，、:：;；。（）()「」"'`*]+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0 && t !== lowerTool && !verbs.includes(t)),
    );
    const segments = new Set<string>();
    for (const v of argValues) {
      for (const seg of v.split(/[\s/\\]+/)) if (seg) segments.add(seg);
    }
    let score = 0;
    for (const tk of tokens) {
      const hit =
        argValues.includes(tk) ||
        segments.has(tk) ||
        (tk.length >= 2 && argValues.some((v) => v.includes(tk)));
      if (hit) score += 1;
    }
    return score;
  }

  /** 注入点: 单测可 mock now() 控制时间戳 (默认 Date.now) */
  protected now(): number {
    return Date.now();
  }
}
