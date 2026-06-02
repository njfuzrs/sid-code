/**
 * 环境变量两阶段应用
 *
 * 对齐 Spec 15 §6。替代未被调用的旧 src/config/safe-env.ts。
 *
 * 安全模型：
 * - Phase 1（信任对话框之前）：仅应用可信来源的全部 env + 合并设置中的安全白名单变量
 * - Phase 2（信任对话框通过后）：应用合并设置的全部 env（含项目级所有变量）
 *
 * 防御目标：项目级 .sid-code/settings.json 中的 env 不能在用户信任前
 * 将 API 请求路由到攻击者服务器（如 ANTHROPIC_BASE_URL），也不能注入
 * 代码执行向量（如 LD_PRELOAD / NODE_OPTIONS）。
 */

import { getSettings, getSettingsForSource } from "./settings.ts";
import type { SettingSource } from "./constants.ts";
import { getLogger } from "../../debug/logger.ts";

/**
 * 可信的 Settings 来源——这些来源的 env 在 Phase 1 就可完整应用。
 * （用户自己 / CLI 显式传入 / 管理员控制）
 */
const TRUSTED_SETTING_SOURCES: SettingSource[] = [
  "userSettings",
  "flagSettings",
  "policySettings",
];

/**
 * 安全环境变量白名单——即使被恶意设置也不会导致凭证泄露、流量劫持或代码执行。
 * Phase 1 中，项目级配置只有这些变量会被应用。
 */
const SAFE_ENV_VARS = new Set<string>([
  // 编辑器
  "EDITOR",
  "VISUAL",
  // 语言/区域
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LANGUAGE",
  // 时区
  "TZ",
  // 终端颜色
  "NO_COLOR",
  "FORCE_COLOR",
  "TERM",
  "COLORTERM",
  // Git
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  // 调试
  "DEBUG",
  "NODE_DEBUG",
]);

/**
 * 受保护的系统环境变量——不允许被任何配置覆盖（含代码注入向量）。
 * 扩展自旧 safe-env.ts 的 11 个变量。
 */
const PROTECTED_ENV_VARS = new Set<string>([
  // 系统路径
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LOGNAME",
  // 动态链接器（代码注入向量）
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  // Node.js / Bun 运行时
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "BUN_INSTALL",
  "BUN_CONFIG_DIR",
  // 进程控制
  "TMPDIR",
  "XDG_RUNTIME_DIR",
]);

/** 检查环境变量是否受保护 */
export function isProtectedEnvVar(key: string): boolean {
  return PROTECTED_ENV_VARS.has(key);
}

/**
 * 过滤并应用环境变量。
 * @param allAllowed true=应用全部（受保护变量除外）；false=仅应用白名单变量
 */
function applyEnvFiltered(
  env: Record<string, string>,
  allAllowed: boolean,
): number {
  let applied = 0;
  for (const [key, value] of Object.entries(env)) {
    if (PROTECTED_ENV_VARS.has(key)) continue; // 受保护变量永不覆盖
    if (!allAllowed && !SAFE_ENV_VARS.has(key)) continue; // 非全量仅白名单
    process.env[key] = value;
    applied++;
  }
  return applied;
}

/**
 * Phase 1: 应用安全环境变量（信任对话框之前）。
 */
export function applySafeConfigEnvironmentVariables(workspacePath?: string): void {
  let total = 0;

  // 1. 可信来源的全部 env
  for (const source of TRUSTED_SETTING_SOURCES) {
    const { settings } = getSettingsForSource(source, workspacePath);
    if (settings?.env) {
      total += applyEnvFiltered(settings.env as Record<string, string>, true);
    }
  }

  // 2. 合并设置中的白名单变量（包括项目级的安全变量）
  const { settings: merged } = getSettings(workspacePath);
  if (merged.env) {
    total += applyEnvFiltered(merged.env as Record<string, string>, false);
  }

  if (total > 0) {
    getLogger().debug("ENV", `Phase 1: 应用 ${total} 个安全环境变量`);
  }
}

/**
 * Phase 2: 应用所有环境变量（信任对话框通过后）。
 */
export function applyAllConfigEnvironmentVariables(workspacePath?: string): void {
  const { settings: merged } = getSettings(workspacePath);
  if (merged.env) {
    const applied = applyEnvFiltered(merged.env as Record<string, string>, true);
    if (applied > 0) {
      getLogger().debug("ENV", `Phase 2: 应用 ${applied} 个环境变量`);
    }
  }
}
