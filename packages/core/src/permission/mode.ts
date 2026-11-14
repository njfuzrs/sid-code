/**
 * 权限模式管理
 * 模式切换循环（Shift+Tab）与企业策略跳档
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

/**
 * 权限模式切换的来源（固定枚举，不含任何自由文本）。
 *
 * B11：轨迹里原先只有 `SessionStart.data.permission_mode` 一个起点值和每条
 * `PermissionDecision.data.mode` 的即时值，中间**没有任何事件**。于是「SessionStart 是
 * default、后续决策全是 acceptEdits」这种最常见的形态，只能靠人回忆「好像按过 Shift+Tab」
 * 来解释 —— 而进出 plan、企业策略强制回拨、CLAUDE.md 指定模式同样会改它。
 *
 * 各自的取值场景：
 *  - `keyboard`：Shift+Tab 键盘循环
 *  - `plan_enter` / `plan_exit`：进出 Plan Mode（`/plan`、enter_plan_mode / exit_plan_mode）
 *  - `claude_md`：CLAUDE.md 的权限段指定
 *  - `policy`：企业策略禁用了当前模式，强制拨回 default
 *  - `command`：斜杠命令等其他显式入口（预留给后续接线）
 */
export type PermissionModeChangeSource =
  | "keyboard"
  | "plan_enter"
  | "plan_exit"
  | "claude_md"
  | "policy"
  | "command";

/**
 * 轨迹事件名：权限模式切换。
 *
 * 唯一的 producer 是 `cli/src/app.ts` 的 `setPermissionMode()`（静态门禁守着
 * 「`config.permissionMode =` 只能出现在那个函数里」，见
 * `tests/app/permission-mode-chokepoint.test.ts`）。字段口径 `{ from, to, source }`，
 * 全部是固定枚举，可安全进本地轨迹。
 */
export const PERMISSION_MODE_CHANGED_EVENT_NAME = "PermissionModeChanged";

/**
 * PermissionMode 的运行时清单。需要「判断一个字符串是不是合法模式」的地方从这里取，不要手抄。
 * 缺陷 13：session-recovery 的白名单是照着 Claude Code 的枚举抄的，漏了 4 个真模式、多了一个
 * 本仓不存在的 `bypassPermissions`，枚举变了也没有任何东西会红。
 * 下面的 `_ExhaustiveModes` 让「类型里加了模式、这里没加」变成类型错误（typecheck:gate 拦）。
 */
export const PERMISSION_MODE_VALUES = [
  "default",
  "always-allow",
  "deny-write",
  "acceptEdits",
  "plan",
  "dontAsk",
  "auto",
  "dangerously-skip-permissions",
] as const satisfies readonly PermissionMode[];

type _ExhaustiveModes =
  Exclude<PermissionMode, (typeof PERMISSION_MODE_VALUES)[number]> extends never ? true : never;
const _exhaustiveModes: _ExhaustiveModes = true;
void _exhaustiveModes;

/** 权限模式上下文 */
export interface PermissionModeContext {
  mode: PermissionMode;
  /** bypassPermissions 是否可用（企业策略可禁用） */
  isBypassAvailable: boolean;
}

// P2-2：此处曾有 shouldPlanInheritBypass（plan 继承 always-allow），全仓零调用，
// 且 checker 里另有一份输入恒为空的手写副本。两份一并删除，理由见 checker.checkPlanMode 注释。

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
