/**
 * 安全环境变量分层
 * 区分「安全」和「完整」环境变量，防止恶意仓库通过项目级配置注入危险环境变量
 *
 * 阶段 1: init() 中——只应用全局/用户级的安全变量
 * 阶段 2: 信任对话框通过后——应用所有环境变量（包括项目级）
 */

/** 受保护的系统环境变量——不允许被任何配置覆盖 */
const PROTECTED_ENV_VARS = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "BUN_INSTALL",
]);

/**
 * 阶段 1: 应用安全环境变量（信任对话框之前）
 * 只应用来自 ~/.sid-code/config.yaml 的全局环境变量
 */
export function applySafeEnvironmentVariables(
  globalEnv: Record<string, string> | undefined,
): void {
  if (!globalEnv) return;

  for (const [key, value] of Object.entries(globalEnv)) {
    if (PROTECTED_ENV_VARS.has(key)) {
      continue; // 静默跳过受保护变量
    }
    process.env[key] = value;
  }
}

/**
 * 阶段 2: 应用项目级环境变量（信任确认后）
 * 应用来自项目级 .sid-code/config.yaml 的环境变量
 */
export function applyProjectEnvironmentVariables(
  projectEnv: Record<string, string> | undefined,
): void {
  if (!projectEnv) return;

  for (const [key, value] of Object.entries(projectEnv)) {
    if (PROTECTED_ENV_VARS.has(key)) {
      console.warn(
        `⚠️ 项目配置尝试覆盖受保护的环境变量: ${key}，已忽略`,
      );
      continue;
    }
    process.env[key] = value;
  }
}

/** 检查环境变量是否受保护 */
export function isProtectedEnvVar(key: string): boolean {
  return PROTECTED_ENV_VARS.has(key);
}
