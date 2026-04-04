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
  return (
    ctx.mode === "plan" &&
    ctx.prePlanMode === "always-allow" &&
    ctx.isBypassAvailable
  );
}

/** 获取下一个权限模式（循环切换，Shift+Tab） */
export function getNextPermissionMode(ctx: PermissionModeContext): PermissionMode {
  switch (ctx.mode) {
    case "default":
      return "acceptEdits";
    case "acceptEdits":
      return "plan";
    case "plan":
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

/** 模式显示名称 */
export function getModeName(mode: PermissionMode): string {
  switch (mode) {
    case "default": return "默认";
    case "always-allow": return "全部允许";
    case "deny-write": return "禁止写入";
    case "acceptEdits": return "自动接受编辑";
    case "plan": return "计划模式";
    case "dontAsk": return "静默拒绝";
    case "dangerously-skip-permissions": return "跳过权限(危险)";
    default: return mode;
  }
}
