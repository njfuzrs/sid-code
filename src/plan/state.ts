/**
 * Plan Mode 状态机
 * 三态：inactive → planning → awaiting_approval
 * 管理计划文件路径、拒绝计数、状态转换
 *
 * S6-T07/T08 (ADR-028): 增加 fidelity 追踪 — plan 步骤解析 + actual tool call 对齐.
 */

import { homedir } from "os";
import { join, resolve } from "path";
import { mkdirSync, existsSync } from "fs";
import { createHash } from "crypto";

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
  /** Plan 文件被 write/edit 成功的时间戳序列（plan_recovery capability 用） */
  private planFileUpdates: number[] = [];

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
  enter(currentPermissionMode?: string): boolean {
    if (this.state !== "inactive") return false;
    const from = this.state;
    this.state = "planning";
    this.rejectionCount = 0;
    this.prePlanMode = currentPermissionMode || null;
    this.planFilePath = this.generatePlanFilePath();
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

  /** 用户批准计划 → 退出 Plan Mode */
  approve(): boolean {
    if (this.state !== "awaiting_approval") return false;
    const from = this.state;
    this.state = "inactive";
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

  /** 强制退出 Plan Mode（用户取消） */
  forceExit(): void {
    if (this.state === "inactive") return;
    const from = this.state;
    this.state = "inactive";
    this.rejectionCount = 0;
    this.planFileUpdates = [];
    this.planSteps = [];
    this.actualToolCalls = [];
    this.emit({ from, to: this.state, planFilePath: this.planFilePath });
  }

  // ── 查询方法 ──

  isActive(): boolean { return this.state !== "inactive"; }
  isPlanning(): boolean { return this.state === "planning"; }
  isAwaitingApproval(): boolean { return this.state === "awaiting_approval"; }
  getState(): PlanModeState { return this.state; }
  getPlanFilePath(): string | null { return this.planFilePath; }
  getRejectionCount(): number { return this.rejectionCount; }

  /** 检查给定路径是否为当前计划文件 */
  isPlanFile(filePath: string): boolean {
    if (!this.planFilePath) return false;
    return resolve(filePath) === resolve(this.planFilePath);
  }

  // ── plan_recovery capability 用 ──

  /**
   * 记录一次 plan 文件 write/edit 成功
   * 仅当 plan mode active（planning / awaiting_approval）时记录，inactive 拒绝
   * 由 app.ts:handlePlanModeTransitions 在工具执行成功后调用
   */
  recordPlanFileWrite(timestamp: number = Date.now()): boolean {
    if (this.state === "inactive") return false;
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
    let idx = 0;
    for (const raw of lines) {
      // 跳过被缩进的子项
      if (/^\s/.test(raw)) continue;
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
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private emit(event: PlanModeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  // ── 内部方法 ──

  private generatePlanFilePath(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    return join(homedir(), ".sid-code", "plans", `plan-${timestamp}.md`);
  }

  private ensurePlanDir(): void {
    const dir = join(homedir(), ".sid-code", "plans");
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
