/**
 * Plan Mode 状态机
 * 三态：inactive → planning → awaiting_approval
 * 管理计划文件路径、拒绝计数、状态转换
 */

import { homedir } from "os";
import { join, resolve } from "path";
import { mkdirSync, existsSync } from "fs";

/** Plan Mode 状态 */
export type PlanModeState = "inactive" | "planning" | "awaiting_approval";

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
}
