/**
 * 权限模式管理
 * 模式继承（plan 继承 bypass）、prePlanMode 记忆、模式切换循环
 */

/** 权限模式 */
export type PermissionMode =
  | "default"
  | "always-allow"
  | "deny-write"
  | "acceptEdits"
  | "plan"
  | "dontAsk"
  | "auto"
  | "dangerously-skip-permissions";

/** 权限模式上下文 */
export interface PermissionModeContext {
  mode: PermissionMode;
  /** 进入 plan 模式前的模式（退出时恢复） */
  prePlanMode?: PermissionMode;
  /** bypassPermissions 是否可用（企业策略可禁用） */
  isBypassAvailable: boolean;
}

/** plan 模式是否应继承 bypass 行为 */
export function shouldPlanInheritBypass(ctx: PermissionModeContext): boolean {
  return ctx.mode === "plan" && ctx.prePlanMode === "always-allow" && ctx.isBypassAvailable;
}

/** 获取下一个权限模式（循环切换，Shift+Tab） */
export function getNextPermissionMode(ctx: PermissionModeContext): PermissionMode {
  switch (ctx.mode) {
    case "default":
      return "acceptEdits";
    case "acceptEdits":
      return "plan";
    case "plan":
      return "auto";
    case "auto":
      if (ctx.isBypassAvailable) return "always-allow";
      return "default";
    case "always-allow":
      return "default";
    case "deny-write":
      return "default";
    case "dontAsk":
      return "default";
    default:
      return "default";
  }
}

/**
 * 键盘（Shift+Tab）循环要落到的下一个模式：在 getNextPermissionMode 之上跳过不可键盘进入的档。
 *
 * 为什么独立成函数：这段跳过逻辑此前内联在 app.ts 的 cyclePermissionMode 里，
 * 测试则**手抄了一份**——然后两边漂移了：测试那份同时跳 plan 和 auto（注释写
 * 「auto classifier 从未注入（死档）」），而 auto 早已接线，生产只跳 plan。
 * 于是测试断言「auto 永不出现在序列里」，生产实际会切进 auto，
 * 一份绿灯的测试在为一个不存在的行为背书，文档也照着测试写错了顺序。
 * 复刻生产逻辑的测试注定漂移，所以把它提出来，两边调同一个函数。
 *
 * @param isModeDisabled 企业策略门控（disabledModes / bypass killswitch）。
 *   由调用方注入而不是在这里 import，保持本模块是纯函数、可直接单测。
 */
export function getNextKeyboardPermissionMode(
  ctx: PermissionModeContext,
  isModeDisabled: (mode: PermissionMode) => boolean = () => false,
): PermissionMode {
  // plan 是独立状态机：键盘只改这个字符串会造出一个假的 plan 态
  // （真正的进出要走 /plan 与 exit_plan_mode）。所以只跳过它，不跳 auto。
  let next = getNextPermissionMode(ctx);
  // 最多绕一整圈（模式数上限）防死循环；全被禁时由调用方保持当前模式不变。
  for (let i = 0; i < 8 && (next === "plan" || isModeDisabled(next)); i++) {
    if (next === ctx.mode) break; // 绕回原点，无可切换的模式
    next = getNextPermissionMode({ ...ctx, mode: next });
  }
  return next;
}

/** 模式显示名称 */
export function getModeName(mode: PermissionMode): string {
  switch (mode) {
    case "default":
      return "Manual（手动）";
    case "always-allow":
      return "全部允许";
    case "deny-write":
      return "禁止写入";
    case "acceptEdits":
      return "自动接受编辑";
    case "plan":
      return "计划模式";
    case "dontAsk":
      return "静默拒绝";
    case "auto":
      return "自动模式";
    case "dangerously-skip-permissions":
      return "跳过权限(危险)";
    default:
      return mode;
  }
}
