/**
 * 「这次确认属于安全类」的唯一判定入口。
 *
 * 独立成一个小模块（而不是留在 checker.ts 里）是为了让 query 层也能用同一个口径：
 * `tool-executor` 要把这个标记透传给确认回调，B9 的「始终允许」据此只记整条精确规则、
 * 只在会话内（见 permission/bash-allow-rules.ts）。若从 checker.ts 导出，query 层会
 * 静态拉进整个权限判定模块，多一条无谓的模块依赖边。
 *
 * 覆盖三种 decisionReason：
 * - `dangerousCommand`：bash 危险模式（rm -rf / 强制推送等）
 * - `safetyCheck`：hooks / commands / settings 要求的确认
 * - `destructiveTool`：MCP Server 自报 destructiveHint
 *
 * yesMode、auto、hook allow 三处必须共用——复制粘贴会漏抄（P0-1 就是 auto 漏了这道）。
 */

import type { PermissionDecisionReason } from "./types.ts";

export function isSafetyConfirmation(reason: PermissionDecisionReason | undefined): boolean {
  const t = reason?.type;
  return t === "dangerousCommand" || t === "safetyCheck" || t === "destructiveTool";
}
