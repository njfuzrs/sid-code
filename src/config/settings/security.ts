/**
 * Settings 安全边界
 *
 * 对齐 Spec 15 §3.5：项目级配置可以影响行为，但不能影响安全控制。
 * 防止恶意仓库通过 .sid-code/settings.json 注入安全敏感字段
 * （如关闭权限确认、关闭环境变量清理）。
 *
 * 与 src/permission/rule-loader.ts 的 UNTRUSTED_PROJECT_SETTINGS 语义一致——
 * 这里覆盖 Settings 全字段层面，rule-loader 覆盖权限规则层面。
 */

import type { SettingsJson } from "./types.ts";

/**
 * 安全敏感字段——projectSettings 不能设置这些字段。
 * 只能从可信来源（user / local / flag / policy）设置。
 */
export const SECURITY_SENSITIVE_FIELDS = new Set<string>([
  "permissionMode", // 不允许项目配置跳过权限
  "allowedTools", // 不允许项目配置自我授权工具
  "sanitizeEnv", // 不允许项目配置关闭环境变量清理
  "trustProjectExtensions", // 不允许项目配置自我信任
  "allowedDirectories", // 不允许项目配置扩大目录白名单
]);

/**
 * 过滤项目级配置中的安全敏感字段。
 * 返回新对象，不修改入参。
 */
export function filterProjectSettings(settings: SettingsJson): SettingsJson {
  const filtered: Record<string, unknown> = { ...settings };
  for (const field of SECURITY_SENSITIVE_FIELDS) {
    if (field in filtered) {
      delete filtered[field];
    }
  }
  return filtered as SettingsJson;
}
