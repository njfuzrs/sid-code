/**
 * Policy Limits 功能开关
 * 企业策略可禁用特定功能（MCP、子代理、自定义命令等）
 * 提供统一的 isPolicyAllowed(feature) 检查函数
 */

import { getLogger } from "../debug/logger.ts";

/** 可控制的功能列表 */
export type PolicyFeature =
  | "mcp" // MCP 服务器
  | "sub_agent" // 子代理
  | "custom_commands" // 自定义斜杠命令
  | "hooks" // Hook 系统
  | "bypass_permissions" // always-allow 模式
  | "auto_mode" // 自动模式（dontAsk）
  | "extensions" // 扩展/技能
  | "file_upload" // 文件上传
  | "network_access" // 网络访问
  | "sandbox_bypass"; // 绕过沙箱

/** 功能开关状态 */
export interface PolicyLimitsState {
  limits: Record<string, { allowed: boolean; reason?: string }>;
}

/** 全局策略限制实例（单例） */
let globalPolicyLimits: PolicyLimitsState = { limits: {} };

/** 设置全局策略限制（从 PolicyManager 加载后调用） */
export function setPolicyLimits(
  limits: Record<string, { allowed: boolean; reason?: string }>,
): void {
  globalPolicyLimits = { limits };
  const log = getLogger();
  const disabled = Object.entries(limits)
    .filter(([, v]) => !v.allowed)
    .map(([k]) => k);
  if (disabled.length > 0) {
    log.info("POLICY_LIMITS", `已禁用功能: ${disabled.join(", ")}`);
  }
}

/** 检查功能是否被策略允许 */
export function isPolicyAllowed(feature: PolicyFeature | string): boolean {
  const limit = globalPolicyLimits.limits[feature];
  if (!limit) return true; // 未配置 = 允许
  return limit.allowed;
}

/** 获取功能被禁用的原因 */
export function getPolicyDenialReason(feature: PolicyFeature | string): string | undefined {
  const limit = globalPolicyLimits.limits[feature];
  if (!limit || limit.allowed) return undefined;
  return limit.reason || `功能 "${feature}" 已被企业策略禁用`;
}

/** 获取所有被禁用的功能 */
export function getDisabledFeatures(): string[] {
  return Object.entries(globalPolicyLimits.limits)
    .filter(([, v]) => !v.allowed)
    .map(([k]) => k);
}

/** 重置策略限制（测试用） */
export function resetPolicyLimits(): void {
  globalPolicyLimits = { limits: {} };
}
