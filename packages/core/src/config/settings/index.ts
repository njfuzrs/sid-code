/**
 * Settings 子系统统一导出
 *
 * 上层模块通过本 barrel 引用 Settings 系统，避免深路径导入。
 */

export {
  SETTING_SOURCES,
  getSettingsFilePath,
  getSettingsFilePaths,
  type SettingSource,
} from "./constants.ts";

export { SettingsSchema, lazySchema, type SettingsJson } from "./types.ts";

export {
  type ValidationError,
  formatZodErrors,
  filterInvalidPermissionRules,
} from "./validation.ts";

export { mergeSettingsRead, mergeSettingsWrite } from "./merge.ts";

export { SECURITY_SENSITIVE_FIELDS, filterProjectSettings } from "./security.ts";

export { resetSettingsCache } from "./cache.ts";

export {
  getSettings,
  getSettingsForSource,
  loadSettingsFromDisk,
  setFlagSettings,
  setEnabledSettingSources,
  writeSettingsFile,
  patchSettingsFile,
  mergeMissingTopLevelKeys,
  type SettingsWithErrors,
} from "./settings.ts";

export {
  settingsChanged,
  initializeChangeDetector,
  cleanup as cleanupChangeDetector,
} from "./change-detector.ts";

export { markInternalWrite, consumeInternalWrite } from "./internal-writes.ts";

export {
  applySafeConfigEnvironmentVariables,
  applyAllConfigEnvironmentVariables,
  isProtectedEnvVar,
} from "./managed-env.ts";
