/**
 * 远程策略 permissions 的进程内单例（M3）。
 *
 * 与 `policy-limits.ts` / `mode-policy.ts` 同模式：cli 在
 * `PolicyManager.load()` 成功后写入，`PermissionChecker.initRules()` 读出
 * 喂给 `RuleLoader.setPolicyRules`。独立文件是为了不让 checker 动态 import
 * `policy.ts` 造成环。
 *
 * 只存 permissions，不存整份 PolicySettings——limits / hooks / modes 已有各自单例。
 *
 * `applied` 与「有没有 permissions 对象」必须分开：远程 200 且 body 有效
 * （哪怕只有 `{source:"remote"}`）也要挡住 loadPolicyFile，否则本地 managed
 * 的 deny 会从 permissions 通道漏回来，first-source-wins 只对 limits/hooks 成立。
 */

import type { SettingsPermissions } from "../permission/types.ts";

let remoteApplied = false;
let remotePermissions: SettingsPermissions | undefined;

/**
 * cli 启动路径在 PolicyManager.load() 之后调用。
 * `applied=true` 表示远程赢了（含空 permissions）；`perms` 可 undefined。
 */
export function setRemotePolicyPermissions(
  perms: SettingsPermissions | undefined,
  applied = true,
): void {
  remoteApplied = applied;
  remotePermissions = perms;
}

export function getRemotePolicyPermissions(): SettingsPermissions | undefined {
  return remotePermissions;
}

/** 远程是否已经作为 first-source 生效（含空策略）。 */
export function isRemotePolicyApplied(): boolean {
  return remoteApplied;
}

/** 仅测试 */
export function __resetRemotePolicyPermissionsForTest(): void {
  remoteApplied = false;
  remotePermissions = undefined;
}
