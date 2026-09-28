/**
 * Plan Mode 状态机
 * 三态：inactive → planning → awaiting_approval
 * 管理计划文件路径、拒绝计数、状态转换
 *
 * S6-T07/T08 (ADR-028): 增加 fidelity 追踪 — plan 步骤解析 + actual tool call 对齐.
 */

import { resolve } from "path";
import { mkdirSync, existsSync } from "fs";
import { createHash } from "crypto";
import { formatPlanTime, resolvePlanProject, sanitizePlanTopic } from "./slug.ts";
import { sidPaths } from "../config/paths.ts";
import { getCwd } from "../bootstrap/state.ts";

/** Plan Mode 状态 */
export type PlanModeState = "inactive" | "planning" | "awaiting_approval";

/** ADR-028: plan markdown 解析后的单步 */
export interface PlanStep {
  index: number;
  description: string;
  matchedActualIndices: number[];
}

/** ADR-028: exit_plan_mode 后实际工具调用记录 */
export interface ActualToolCall {
  index: number;
  toolName: string;
  argsHash: string;
  matchedPlanStepIndex: number | null;
  timestamp: number;
}

/** ADR-028: fidelity 报告 (内核权威信号) */
export interface FidelityReport {
  planStepCount: number;
  actualToolCallCount: number;
  /** actual / plan, plan=0 时返回 NaN */
  stepRatio: number;
  /** matched (matchedPlanStepIndex !== null) 的 actual 占 plan 比例 */
  matchedRatio: number;
  /** matchedPlanStepIndex===null 的 actual 数 */
  offPlanCount: number;
}

/** Plan Mode 状态变更事件 */
export interface PlanModeEvent {
  from: PlanModeState;
  to: PlanModeState;
  planFilePath: string | null;
}

/** 状态变更监听器 */
export type PlanModeListener = (event: PlanModeEvent) => void;

/** Plan Mode 状态管理器 */
export class PlanModeManager {
  private state: PlanModeState = "inactive";
  private planFilePath: string | null = null;
  private rejectionCount = 0;
  private readonly maxRejections = 5;
  private listeners: PlanModeListener[] = [];
  /** 进入 plan 模式前的权限模式（退出时恢复） */
  private prePlanMode: string | null = null;
  /** 缓存的计划文件所属项目名（同一会话内复用） */
  private planProject: string | null = null;
  /** Plan Mode 提醒注入轮次计数（用于节流：每 N 轮发完整提醒） */
  private reminderTurn = 0;
  /** 完整提醒间隔（每 N 轮发一次完整提醒，其余发简短提醒） */
  private readonly fullReminderInterval = 5;
  /** 执行阶段所需权限（exit_plan_mode 声明，用户审批计划时一并审批） */
  private allowedPrompts: Array<{ tool?: string; prompt: string }> = [];
  /** Plan 文件被 write/edit 成功的时间戳序列（plan_recovery capability 用） */
  private planFileUpdates: number[] = [];
  /**
   * 是否处于"执行阶段"——计划已被 approve、正在按计划执行。
   *
   * 缺陷修复：Recovery Hook 的设计意图是"执行阶段工具失败时提醒先更新 plan 再继续"，
   * 但 approve() 后状态立刻回到 inactive、isPlanning() 为 false，recovery 永远触发不到。
   * 这里用独立标志追踪执行阶段：approve() 时置 true，下次 enter()/forceExit() 时清零。
   * 与三态状态机正交——执行阶段权限模式已恢复（非 plan），但语义上仍"在按计划干活"。
   */
  private executing = false;

  // ADR-028: fidelity 追踪字段
  /** 解析 plan markdown 拿到的步骤 */
  private planSteps: PlanStep[] = [];
  /** exit_plan_mode 后的工具调用记录 */
  private actualToolCalls: ActualToolCall[] = [];

  /** 获取进入 plan 前的权限模式 */
  getPrePlanMode(): string | null {
    return this.prePlanMode;
  }

  /** 进入 Plan Mode */
  enter(currentPermissionMode?: string, topic?: string): boolean {
    if (this.state !== "inactive") return false;
    const from = this.state;
    this.state = "planning";
    this.rejectionCount = 0;
    this.reminderTurn = 0;
    this.allowedPrompts = [];
    this.executing = false;
    this.prePlanMode = currentPermissionMode || null;
    this.planFilePath = this.generatePlanFilePath(topic);
    this.ensurePlanDir();
    this.emit({ from, to: this.state, planFilePath: this.planFilePath });
    return true;
  }

  /** 提交计划等待审批 */
  submitForApproval(): boolean {
    if (this.state !== "planning") return false;
    const from = this.state;
    this.state = "awaiting_approval";
    this.emit({ from, to: this.state, planFilePath: this.planFilePath });
    return true;
  }

  /** 用户批准计划 → 退出 Plan Mode，进入执行阶段 */
  approve(): boolean {
    if (this.state !== "awaiting_approval") return false;
    const from = this.state;
    this.state = "inactive";
    // 缺陷修复：进入执行阶段。此后权限模式已恢复（非 plan），但语义上在按计划执行，
    // Recovery Hook 据 isExecuting() 在执行阶段工具失败时触发"先更新 plan 再继续"。
    this.executing = true;
    this.emit({ from, to: this.state, planFilePath: this.planFilePath });
    return true;
  }

  /**
   * 用户拒绝计划 → 回到 planning 继续修改
   * 返回 true 表示可以继续修改，false 表示超过拒绝上限已强制退出
   */
  reject(): boolean {
    if (this.state !== "awaiting_approval") return false;
    this.rejectionCount++;
    const from = this.state;
    if (this.rejectionCount >= this.maxRejections) {
      this.state = "inactive";
      this.emit({ from, to: this.state, planFilePath: this.planFilePath });
      return false;
    }
    this.state = "planning";
    this.emit({ from, to: this.state, planFilePath: this.planFilePath });
    return true;
  }

  /**
   * 强制退出 Plan Mode（用户取消）。
   *
   * P1-1：`state === "inactive"` 时不再无条件 return——执行阶段的 state 正是
   * inactive 而 isExecuting() 为真，从前那个早退让 forceExit 在**唯一需要它
   * 收尾执行阶段**的时刻变成 no-op（旧测试甚至把这件事写成了预期）。
   * 在 isExecuting() 只被 Recovery Hook 读的年代这无害；它现在还是权限链
   * Step 3.5 的放行条件之一，于是「用户取消」必须真的关掉执行阶段。
   */
  forceExit(): void {
    if (this.state === "inactive" && !this.executing) return;
    const from = this.state;
    this.state = "inactive";
    this.rejectionCount = 0;
    this.reminderTurn = 0;
    this.allowedPrompts = [];
    this.planFileUpdates = [];
    this.planSteps = [];
    this.actualToolCalls = [];
    this.executing = false;
    this.emit({ from, to: this.state, planFilePath: this.planFilePath });
  }

  /**
   * 结束执行阶段（清 executing 标志）。
   * 当一轮按计划执行彻底收尾、或用户开启新一轮 plan 时调用。
   * 注意 enter() 已会清零，此方法供"执行完成但未进入新 plan"的显式收尾场景。
   */
  endExecution(): void {
    this.executing = false;
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

  /** 记录执行阶段所需权限（exit_plan_mode 调用） */
  setAllowedPrompts(prompts: Array<{ tool?: string; prompt: string }>): void {
    this.allowedPrompts = prompts;
  }

  /** 获取执行阶段所需权限（审批流程用） */
  getAllowedPrompts(): ReadonlyArray<{ tool?: string; prompt: string }> {
    return this.allowedPrompts;
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
   * 解析 plan markdown 拿到顶层步骤列表 (1. xxx / - xxx).
   * 支持: 中文/英文编号 + 顶层 dash 项. 嵌套子步骤不计 step.
   * 解析后存入 this.planSteps 供后续对齐使用.
   * 多次调用以最后一次为准 (plan 文件更新).
   *
   * P1-2：**非步骤章节下的列表项不计入步骤**。
   *
   * 从前这个解析器对每一行只做一件事——排除缩进行，不排除任何章节。于是
   * buildPlanModePrompt 自己教模型写的「## 决策记录」小节里那几条
   * 「推迟 X / 替代方案 Y」，以及「## 风险」下的风险描述，全部被数成步骤。
   * 后果不只是数字难看：countPlanSteps 的结果喂给 buildPlanApprovedMessage，
   * 而那条「todo 清单必须覆盖全部 N 步」的强制令只在 planStepCount >= 3 时下达——
   * 口径虚高会**改变是否下达这条指令**，一份只有 1 个真步骤的计划只要写了两条
   * 决策记录就会触发它。更糟的是同一条批准消息里两条指令互相矛盾：
   * 一条要求这 N 项都要做，另一条（尊重既有决策）要求其中的决策记录项不许重做。
   */
  parsePlanFromMarkdown(md: string): PlanStep[] {
    if (typeof md !== "string") {
      this.planSteps = [];
      return [];
    }
    const steps: PlanStep[] = [];
    const lines = md.split(/\r?\n/);
    // 仅匹配顶层 (没有 leading 空格 / tab) 的有序项 "1. xxx" / "1) xxx" 或顶层 "- xxx" / "* xxx".
    const orderedRe = /^(\d+)[.)]\s+(.+)$/;
    const dashRe = /^[-*]\s+(.+)$/;
    const headingRe = /^#{1,6}\s+(.+)$/;
    let idx = 0;
    // 当前所在标题是否是「非步骤章节」。文件开头（无标题）视为步骤区，
    // 保持对不写任何标题的朴素计划的向后兼容。
    let inNonStepSection = false;
    for (const raw of lines) {
      const hm = raw.match(headingRe);
      if (hm) {
        inNonStepSection = PlanModeManager.isNonStepHeading(hm[1]);
        continue;
      }
      // 跳过被缩进的子项
      if (/^\s/.test(raw)) continue;
      // 非步骤章节下的列表项不是步骤
      if (inNonStepSection) continue;
      const om = raw.match(orderedRe);
      const dm = !om && raw.match(dashRe);
      if (om) {
        idx += 1;
        steps.push({
          index: idx,
          description: om[2].trim(),
          matchedActualIndices: [],
        });
      } else if (dm) {
        idx += 1;
        steps.push({
          index: idx,
          description: dm[1].trim(),
          matchedActualIndices: [],
        });
      }
    }
    this.planSteps = steps;
    return steps;
  }

  /**
   * 判断一个 markdown 标题是否属于「非步骤章节」——其下的列表项不该被数成步骤。
   *
   * 关键词表刻意只收**计划文件里真实会出现**的那几类，判据是
   * `plan/prompt.ts` 自己教模型写什么：buildPlanModePrompt 明确要求
   * 「## 决策记录」（含原因 / 替代方案 / 重新评估条件），阶段 2 要求考虑
   * 「潜在风险和边界情况」。剩下的是通用非步骤段落（背景 / 现状 / 参考 / 附录…）。
   *
   * 不做成「只数 `## 步骤` 章节内的项」的反向口径，理由是向后兼容：
   * 大量既有计划不写「## 步骤」这个标题，反向口径会让它们的步骤数直接归零，
   * 把一个虚高的数字换成一个恒为 0 的数字——那会让 >= 3 的强制令永不下达。
   */
  private static isNonStepHeading(title: string): boolean {
    // 去掉 markdown 强调符与前后空白，统一小写便于匹配英文标题
    const t = title
      .replace(/[*_`#]/g, "")
      .trim()
      .toLowerCase();
    return PlanModeManager.NON_STEP_HEADING_KEYWORDS.some((kw) => t.includes(kw));
  }

  /**
   * 非步骤章节的标题关键词（子串匹配，中英各一组）。
   * 用子串而非全等：实际标题常带编号或后缀（「## 三、风险与回滚」「## 决策记录（防漂移）」）。
   */
  private static readonly NON_STEP_HEADING_KEYWORDS: readonly string[] = [
    // buildPlanModePrompt 明确要求写的两类
    "决策记录",
    "风险",
    "decision",
    "risk",
    // 通用非步骤段落
    "背景",
    "现状",
    "目标",
    "非目标",
    "参考",
    "附录",
    "备注",
    "结论",
    "验收",
    "边界情况",
    "未决问题",
    "background",
    "context",
    "goal",
    "non-goal",
    "reference",
    "appendix",
    "note",
    "open question",
    "acceptance",
    "trade-off",
    "tradeoff",
    "alternative",
  ];

  /**
   * 记录一次 actual 工具调用 (在 exit_plan_mode 之后调用方负责调).
   * 用 description 中第一个名词 / 工具名做 fuzzy match — 命中算 matched, 否则 off-plan.
   */
  recordActualToolCall(toolName: string, args: unknown): ActualToolCall {
    const argsHash = this.hashArgs(args);
    const next: ActualToolCall = {
      index: this.actualToolCalls.length + 1,
      toolName,
      argsHash,
      matchedPlanStepIndex: this.matchAgainstPlan(toolName, args),
      timestamp: this.now(),
    };
    this.actualToolCalls.push(next);
    if (next.matchedPlanStepIndex !== null) {
      const step = this.planSteps.find((s) => s.index === next.matchedPlanStepIndex);
      if (step) step.matchedActualIndices.push(next.index);
    }
    return next;
  }

  /** ADR-028 §3.1: 内核权威 fidelity 报告 */
  getFidelityReport(): FidelityReport {
    const planStepCount = this.planSteps.length;
    const actualToolCallCount = this.actualToolCalls.length;
    const offPlanCount = this.actualToolCalls.filter((c) => c.matchedPlanStepIndex === null).length;
    const matchedActualCount = actualToolCallCount - offPlanCount;
    const stepRatio = planStepCount === 0 ? Number.NaN : actualToolCallCount / planStepCount;
    const matchedRatio = planStepCount === 0 ? Number.NaN : matchedActualCount / planStepCount;
    return {
      planStepCount,
      actualToolCallCount,
      stepRatio,
      matchedRatio,
      offPlanCount,
    };
  }

  /** 单测/runner 注入用 — 重置 fidelity 追踪状态 */
  resetFidelity(): void {
    this.planSteps = [];
    this.actualToolCalls = [];
  }

  // ── 事件监听 ──

  onStateChange(listener: PlanModeListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: PlanModeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  // ── 内部方法 ──

  private generatePlanFilePath(topic?: string): string {
    const project = resolvePlanProject(getCwd());
    this.planProject = project;
    const time = formatPlanTime();
    const safeTopic = sanitizePlanTopic(topic);
    const base = safeTopic ? `${time}-${safeTopic}` : time;
    // 去重：同项目同分钟内多次进入 plan（或兜底时间戳）避免覆盖
    let candidate = sidPaths.plan(project, base);
    let n = 2;
    while (existsSync(candidate)) {
      candidate = sidPaths.plan(project, `${base}-${n++}`);
    }
    return candidate;
  }

  private ensurePlanDir(): void {
    const dir = sidPaths.plansForProject(this.planProject ?? "default");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
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
   * 把 actual tool call 与 planSteps 做 fuzzy match.
   * 规则 (顺序): toolName 字面命中 step.description → 直接命中;
   *            args 中含路径 / 文件名命中 description → 命中;
   *            否则返回 null = off-plan.
   * 注意: 一个 step 可被多个 actual 命中 (matchedActualIndices 是 list).
   */
  private matchAgainstPlan(toolName: string, args: unknown): number | null {
    if (this.planSteps.length === 0) return null;
    const argText = (() => {
      try {
        return JSON.stringify(args ?? "").toLowerCase();
      } catch {
        return String(args ?? "").toLowerCase();
      }
    })();
    const lowerTool = toolName.toLowerCase();
    for (const step of this.planSteps) {
      const desc = step.description.toLowerCase();
      // 1) tool name 出现在 description
      if (desc.includes(lowerTool)) return step.index;
      // 2) description 中含中文动作词与 tool 语义对应
      const verbMap: Record<string, string[]> = {
        read: ["读", "查看", "看", "load"],
        edit: ["改", "修改", "edit"],
        write: ["写", "创建", "新建", "write"],
        bash: ["跑", "执行", "运行", "run"],
        grep: ["搜", "查找", "grep"],
        glob: ["遍历", "list"],
        exit_plan_mode: ["exit_plan", "完成", "提交"],
      };
      const verbs = verbMap[lowerTool] ?? [];
      if (verbs.some((v) => desc.includes(v))) {
        // 还要看 args 是否能锚定到该 step (args 路径 / 关键词 出现在 desc)
        const tokens = desc.split(/[\s,，、:：（）()「」"'`]+/).filter((t) => t.length >= 2);
        for (const tk of tokens) {
          if (tk && argText.includes(tk.toLowerCase())) return step.index;
        }
        // 没有 args 锚定但动作词命中: 仍算 match (LLM 在 plan 第 N 步明确说"读 X"，本次 read 即视为对应 step 的执行)
        return step.index;
      }
    }
    return null;
  }

  /** 注入点: 单测可 mock now() 控制时间戳 (默认 Date.now) */
  protected now(): number {
    return Date.now();
  }
}
