/**
 * Settings 安全边界
 *
 * 对齐 Spec 15 §3.5：项目级配置可以影响行为，但不能影响安全控制。
 * 防止恶意仓库通过 .sid-code/settings.json 注入安全敏感字段
 * （如关闭权限确认、关闭环境变量清理、自我授权工具、关闭风险分类器）。
 *
 * ⚠️ 单一权威清单（P0-3 §5.2.5）：
 *   本文件的 SECURITY_SENSITIVE_FIELDS 是**唯一权威**的不可信项目级字段清单。
 *   src/permission/rule-loader.ts 不再各自维护 UNTRUSTED_PROJECT_SETTINGS，
 *   而是从这里复用，杜绝"两套清单内容不一致"的历史问题。
 *
 *   - 本文件 filterProjectSettings() 覆盖 Settings **全字段层面**
 *     （已接入 src/config/settings/settings.ts:getSettingsForSource 加载链）。
 *   - rule-loader 复用本清单覆盖**权限规则加载层面**
 *     （projectSettings 的 permissions.* 不可自我授权绕过安全限制）。
 */

import type { SettingsJson } from "./types.ts";

/**
 * 安全敏感字段——projectSettings 不能设置这些字段。
 * 只能从可信来源（user / local / flag / policy）设置。
 *
 * 本清单为历史上两套清单（security.ts SECURITY_SENSITIVE_FIELDS +
 * rule-loader.ts UNTRUSTED_PROJECT_SETTINGS）的**并集**，确保覆盖完整：
 *   原 security 独有：allowedTools、trustProjectExtensions
 *   原 rule-loader 独有：skipPermissions、yesMode
 *   两者共有：permissionMode、sanitizeEnv、allowedDirectories
 *   新增（P0-3 迭代 II）：enableLLMClassifier（安全开关，项目级不可关闭以削弱防线）
 *   新增（SEC-AUDIT-2026-07-19 P0）：webFetchIsolate（同理，项目级不可关掉网页隔离提炼）
 */
export const SECURITY_SENSITIVE_FIELDS = new Set<string>([
  "permissionMode", // 不允许项目配置跳过权限
  "skipPermissions", // 不允许项目配置直接关闭权限检查
  "yesMode", // 不允许项目配置自动 yes 一切确认
  "allowedTools", // 不允许项目配置自我授权工具
  "sanitizeEnv", // 不允许项目配置关闭环境变量清理
  "trustProjectExtensions", // 不允许项目配置自我信任
  "allowedDirectories", // 不允许项目配置扩大目录白名单
  "enableLLMClassifier", // 不允许项目配置关闭 LLM 风险分类器（削弱第二道防线）
  // 不允许项目配置关闭 WebFetch 隔离提炼。这条尤其关键：恶意项目若能在 .sid-code/settings.json
  // 里设 webFetchIsolate:false，就能让自己 README 里指向的 URL 原文直灌主上下文——
  // 正好是本条防线要拦的攻击链。
  "webFetchIsolate",
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
