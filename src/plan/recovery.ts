/**
 * Plan Recovery Hook (ADR-028 §3.2)
 *
 * 当 tool 执行失败时, 触发器决定是否给 LLM 注入 "更新 plan" 的 system reminder.
 * 这不是强制行为, recovery 决策权在 LLM, 本模块只负责"提醒"而不"代写".
 *
 * 设计取舍:
 *   - 不直接修改 user message (违反协议)
 *   - 同 plan 文件 5 次 recovery 内不重复触发同 trigger (抖动守护)
 *   - 4 类 trigger 覆盖 plan_007/008 真信号场景 (permission_denied / file_not_found)
 *
 * 与 PlanModeManager 的关系:
 *   - 本模块独立于 state.ts, 不持有 plan 状态
 *   - 调用方 (app.ts:handlePlanModeTransitions / 后续 dogfood 阶段挂载) 负责把 ctx 传进来
 */

/** Recovery 触发场景 (ADR-028 §3.2) */
export type RecoveryTrigger =
  | "tool_failure"          // 通用工具失败 (isError=true)
  | "file_not_found"        // 特化 read/edit 路径不存在
  | "permission_denied"     // 权限拒绝 (sandbox / acceptEdits 拒绝)
  | "user_correction";      // 用户在 plan mode 中纠正方向

/** Recovery 触发上下文 — 调用方填好后传入 hook */
export interface RecoveryContext {
  toolName: string;
  errorMessage: string;
  failedArgs: unknown;
  /** 当前 plan 文件路径 (state.getPlanFilePath() 拿) */
  currentPlanFilePath: string;
  /** 当前 actual 调用对应的 planStep.index, null = off-plan */
  planStepIndex: number | null;
}

/** Recovery hook 接口 */
export interface RecoveryHook {
  /** 是否应触发 recovery (返回 false 时静默) */
  shouldTrigger(trigger: RecoveryTrigger, ctx: RecoveryContext): boolean;
  /** 构造给 LLM 的提示文本 (注入到下一轮 system reminder) */
  buildRecoveryHint(trigger: RecoveryTrigger, ctx: RecoveryContext): string;
  /** 记录一次触发 (内部抖动守护用) */
  recordTrigger(trigger: RecoveryTrigger, planFilePath: string): void;
  /** 单测/runner 重置 */
  reset(): void;
  /** 触发计数 (单测断言用) */
  getTriggerCount(trigger: RecoveryTrigger, planFilePath: string): number;
}

/**
 * 默认实现: 同 plan 文件 5 次窗口内不重复触发同 trigger.
 * 不持久化, 进程重启后清零.
 */
export class DefaultRecoveryHook implements RecoveryHook {
  /** key = `${planFilePath}::${trigger}` -> 计数 */
  private counters = new Map<string, number>();
  /** 抖动窗口大小 */
  private readonly windowSize: number;

  constructor(windowSize: number = 5) {
    this.windowSize = Math.max(1, windowSize);
  }

  shouldTrigger(trigger: RecoveryTrigger, ctx: RecoveryContext): boolean {
    if (!this.isValidContext(ctx)) return false;
    const key = this.makeKey(ctx.currentPlanFilePath, trigger);
    const cur = this.counters.get(key) ?? 0;
    return cur < this.windowSize;
  }

  buildRecoveryHint(trigger: RecoveryTrigger, ctx: RecoveryContext): string {
    const head =
      `[plan-recovery] 上一步工具调用失败, 建议更新 plan 反映新策略后再继续:`;
    const tail =
      `提示: 不要无声忽略错误; 也不要 hallucinate 创建不存在的目录或文件. 如果失败的路径已经被改/删, 请在 plan 中显式承认.`;

    switch (trigger) {
      case "file_not_found":
        return [
          head,
          `  - 失败工具: ${ctx.toolName}`,
          `  - 失败原因: 文件/目录不存在 (${this.summarizeArgs(ctx.failedArgs)})`,
          `  - 当前 plan 步骤: ${ctx.planStepIndex ?? "off-plan"}`,
          `  - 建议: 用 ls / glob 确认实际目录结构, 然后用 edit 工具更新 plan 文件 ${ctx.currentPlanFilePath}`,
          ``,
          tail,
        ].join("\n");

      case "permission_denied":
        return [
          head,
          `  - 失败工具: ${ctx.toolName}`,
          `  - 失败原因: 权限被拒 (${ctx.errorMessage.slice(0, 200)})`,
          `  - 当前 plan 步骤: ${ctx.planStepIndex ?? "off-plan"}`,
          `  - 建议: 不要绕过 permission, 在 plan 文件 ${ctx.currentPlanFilePath} 中改成"请用户手动..."或选择只读路径`,
          ``,
          tail,
        ].join("\n");

      case "user_correction":
        return [
          head,
          `  - 用户在 plan mode 中提出了纠正`,
          `  - 错误信息: ${ctx.errorMessage.slice(0, 200)}`,
          `  - 建议: 把用户纠正的方向写进 plan 文件 ${ctx.currentPlanFilePath}, 而不是仅口头确认`,
          ``,
          tail,
        ].join("\n");

      case "tool_failure":
      default:
        return [
          head,
          `  - 失败工具: ${ctx.toolName}`,
          `  - 失败原因: ${ctx.errorMessage.slice(0, 200)}`,
          `  - 当前 plan 步骤: ${ctx.planStepIndex ?? "off-plan"}`,
          `  - 建议: 重新评估这一步是否还成立, 必要时用 edit 工具更新 plan ${ctx.currentPlanFilePath}`,
          ``,
          tail,
        ].join("\n");
    }
  }

  recordTrigger(trigger: RecoveryTrigger, planFilePath: string): void {
    const key = this.makeKey(planFilePath, trigger);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  reset(): void {
    this.counters.clear();
  }

  getTriggerCount(trigger: RecoveryTrigger, planFilePath: string): number {
    return this.counters.get(this.makeKey(planFilePath, trigger)) ?? 0;
  }

  private makeKey(planFilePath: string, trigger: RecoveryTrigger): string {
    return `${planFilePath}::${trigger}`;
  }

  private isValidContext(ctx: RecoveryContext): boolean {
    if (!ctx) return false;
    if (typeof ctx.currentPlanFilePath !== "string" || ctx.currentPlanFilePath.length === 0) {
      return false;
    }
    return true;
  }

  private summarizeArgs(args: unknown): string {
    try {
      const s = typeof args === "string" ? args : JSON.stringify(args ?? "");
      return s.length > 120 ? s.slice(0, 120) + "..." : s;
    } catch {
      return String(args);
    }
  }
}

/** 全局共享实例 (内核挂载点共用) */
let _shared: DefaultRecoveryHook | null = null;
export function getSharedRecoveryHook(): DefaultRecoveryHook {
  if (!_shared) _shared = new DefaultRecoveryHook();
  return _shared;
}

/** 仅单测用 — 替换共享实例 */
export function _setSharedRecoveryHookForTest(hook: DefaultRecoveryHook | null): void {
  _shared = hook;
}
