/**
 * 权限模式的企业策略管控（P2-2）
 *
 * 承载两类来自 managed settings 的模式约束，供 app / cli / cyclePermissionMode 统一消费：
 * - disabledModes：被禁用的权限模式列表（通用，禁用任意模式）
 * - bypassDisabled：bypass（always-allow / dangerously-skip-permissions）是否被 killswitch 禁用
 *
 * 单例模式（对齐 policy-limits.ts），由 cli 启动加载 policy 后 setModePolicy 注入，
 * 之后各处只读查询，无需层层透传 PolicyManager 实例。
 */

import { getLogger } from "../debug/logger.ts";

/** bypass 类模式（受 disableBypassPermissionsMode killswitch 管控） */
const BYPASS_MODES = new Set(["always-allow", "dangerously-skip-permissions"]);

interface ModePolicyState {
  /** 被企业策略禁用的模式集合 */
  disabledModes: Set<string>;
  /** bypass 是否被 killswitch 禁用 */
  bypassDisabled: boolean;
}

let state: ModePolicyState = {
  disabledModes: new Set(),
  bypassDisabled: false,
};

/**
 * 从加载后的 policy 注入模式管控（cli 启动时调用）。
 * @param disabledModes managed settings 的 disabledModes
 * @param disableBypass  managed settings 的 disableBypassPermissionsMode
 */
export function setModePolicy(disabledModes?: string[], disableBypass?: "disable" | "allow"): void {
  state = {
    disabledModes: new Set(disabledModes ?? []),
    bypassDisabled: disableBypass === "disable",
  };
  const log = getLogger();
  const disabled: string[] = [...state.disabledModes];
  if (state.bypassDisabled) disabled.push("bypass(always-allow/dangerously-skip-permissions)");
  if (disabled.length > 0) {
    log.info("MODE_POLICY", `企业策略禁用权限模式: ${disabled.join(", ")}`);
  }
}

/** 判断某模式是否被企业策略禁用（含 bypass killswitch 覆盖 bypass 类模式）。 */
export function isModeDisabledByPolicy(mode: string): boolean {
  if (state.bypassDisabled && BYPASS_MODES.has(mode)) return true;
  return state.disabledModes.has(mode);
}

/** bypass 是否被 killswitch 禁用（供 bypassAvailableAtLaunch 门控）。 */
export function isBypassDisabledByPolicy(): boolean {
  return state.bypassDisabled;
}

/**
 * 策略禁用 bypass 时，抹掉从配置（而非 CLI）渗入的 skip/bypass 态。
 *
 * 为什么抽成函数而不是留在 cli.ts 内联：这是「企业策略最终赢过任何配置来源」的唯一落点，
 * 散在启动流程里就只能靠跑整个 CLI 才验证得到。cli 与测试共用同一份实现，断言才有意义。
 *
 * 与 CLI 显式请求的区别由调用方负责：CLI 传了 bypass flag 时是 fail-fast 报错退出
 *（见 cli.ts 的 cliWantsBypass 分支），这里是「配置层面静默降级」——
 * 用户没主动要求，不该因为仓库里一份配置文件就起不来。
 */
export function downgradeBypassIfDisabledByPolicy(config: {
  permissionMode: string;
  skipPermissions?: boolean;
}): void {
  if (!state.bypassDisabled) return;
  if (config.skipPermissions) config.skipPermissions = false;
  if (BYPASS_MODES.has(config.permissionMode)) {
    config.permissionMode = "default";
  }
}

/** 测试用：重置状态。 */
export function __resetModePolicy(): void {
  state = { disabledModes: new Set(), bypassDisabled: false };
}
