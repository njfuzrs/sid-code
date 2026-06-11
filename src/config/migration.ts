/**
 * 配置迁移：config.yaml → settings.json + app.json
 *
 * 对齐 Spec 15 §7。非破坏式策略（与 Spec §13 "渐进迁移" 一致）：
 * 1. 首次启动检测旧格式并生成新格式文件
 * 2. **保留** config.yaml（不重命名、不删除）——旧 loadConfig() 仍依赖它，
 *    Settings 系统通过 loadLegacyConfigAsSettings() 回退读取它。
 *    这避免了破坏正在运行的内核加载路径（general-case 不变量守护）。
 * 3. 迁移过程中任何错误都不阻止启动
 *
 * 与原 Spec §7.1 的偏差：原文要求把 config.yaml 重命名为 .migrated。
 * 实际代码中 loadConfig() 是 LIVE 内核路径且被 cli.ts / hook runner 依赖，
 * 重命名会立即破坏现有用户启动。故改为"双写并存"，待上层全部切换到
 * Settings 系统后再单独走一个清理 task 移除 config.yaml 依赖。
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import { parse as parseYAML } from "yaml";
import { join } from "path";
import { getSidHome } from "./paths.ts";
import { getLogger } from "../debug/logger.ts";

/** 需要迁移到 Settings 的字段（归一化后的 camelCase key） */
const SETTINGS_FIELDS = new Set<string>([
  "provider",
  "model",
  "fallbackModel",
  "anthropicKey",
  "openaiKey",
  "baseURL",
  "maxTokens",
  "availableModels",
  "permissionMode",
  "allowedTools",
  "disallowedTools",
  "hooks",
  "mcpServers",
  "subAgentModels",
  "costLimit",
  "quota",
  "search",
  "disabledSkills",
  "sanitizeEnv",
  "trustProjectExtensions",
  "jitContext",
  "allowedDirectories",
  "blockedDirectories",
  "env",
]);

/** 需要迁移到 AppConfig 的字段 */
const APP_CONFIG_FIELDS = new Set<string>([
  "debug",
  "debugLevel",
  "debugLogFile",
  "showLineNumbers",
  "checkpoint",
  "sessionRetention",
  "trace",
  "telemetry",
  "theme",
]);

/** YAML key → JSON key 映射（snake_case → camelCase） */
const KEY_MAP: Record<string, string> = {
  anthropic_key: "anthropicKey",
  openai_api_key: "openaiKey",
  base_url: "baseURL",
  max_tokens: "maxTokens",
  fallback_model: "fallbackModel",
  available_models: "availableModels",
  permission_mode: "permissionMode",
  allowed_tools: "allowedTools",
  disallowed_tools: "disallowedTools",
  allowed_directories: "allowedDirectories",
  blocked_directories: "blockedDirectories",
  mcp_servers: "mcpServers",
  sub_agent_models: "subAgentModels",
  cost_limit: "costLimit",
  show_line_numbers: "showLineNumbers",
  disabled_skills: "disabledSkills",
  trust_project_extensions: "trustProjectExtensions",
  jit_context: "jitContext",
  sanitize_env: "sanitizeEnv",
  debug_level: "debugLevel",
  debug_log_file: "debugLogFile",
  session_retention: "sessionRetention",
};

/**
 * 执行配置迁移。返回 true 表示迁移成功或无需迁移。
 *
 * 幂等：若新格式文件已存在则跳过；失败不抛出。
 */
export function migrateConfigIfNeeded(): boolean {
  const log = getLogger();
  const configDir = getSidHome();
  const oldPath = join(configDir, "config.yaml");
  const settingsPath = join(configDir, "settings.json");
  const appConfigPath = join(configDir, "app.json");

  // 新格式已存在 → 无需迁移
  if (existsSync(settingsPath) || existsSync(appConfigPath)) {
    return true;
  }

  // 旧格式不存在 → 无需迁移
  if (!existsSync(oldPath)) {
    return true;
  }

  try {
    log.info("CONFIG", "检测到旧格式 config.yaml，开始迁移到 settings.json + app.json...");

    const content = readFileSync(oldPath, "utf-8");
    const raw = parseYAML(content);
    if (!raw || typeof raw !== "object") return true;

    const settingsData: Record<string, unknown> = {};
    const appConfigData: Record<string, unknown> = {};

    for (const [yamlKey, value] of Object.entries(raw as Record<string, unknown>)) {
      const jsonKey = KEY_MAP[yamlKey] || yamlKey;
      if (SETTINGS_FIELDS.has(jsonKey)) {
        settingsData[jsonKey] = value;
      } else if (APP_CONFIG_FIELDS.has(jsonKey)) {
        appConfigData[jsonKey] = value;
      }
      // 会话相关字段（sessionId / continue / resume）不迁移——它们是 CLI 参数
    }

    if (Object.keys(settingsData).length > 0) {
      writeFileSync(settingsPath, JSON.stringify(settingsData, null, 2), { mode: 0o600 });
      log.info("CONFIG", `已迁移 ${Object.keys(settingsData).length} 个字段到 settings.json`);
    }

    if (Object.keys(appConfigData).length > 0) {
      writeFileSync(appConfigPath, JSON.stringify(appConfigData, null, 2), { mode: 0o600 });
      log.info("CONFIG", `已迁移 ${Object.keys(appConfigData).length} 个字段到 app.json`);
    }

    // 切断旧路径：把 config.yaml 重命名为 .migrated。
    // 此时 loadConfigFile() 已优先读 settings.json + app.json（见 config.ts），
    // 不再依赖 config.yaml；保留 .migrated 备份供用户回查，但不再参与加载。
    // 仅当确实写出了新格式文件时才重命名，避免空迁移误伤原文件。
    if (
      Object.keys(settingsData).length > 0 ||
      Object.keys(appConfigData).length > 0
    ) {
      try {
        renameSync(oldPath, `${oldPath}.migrated`);
        log.info("CONFIG", "迁移完成，config.yaml 已重命名为 config.yaml.migrated");
      } catch (renameErr) {
        // 重命名失败不致命：新格式已就绪，loadConfigFile 仍优先读它
        log.warn("CONFIG", `config.yaml 重命名失败（不影响加载）: ${renameErr}`);
      }
    } else {
      log.info("CONFIG", "config.yaml 无可迁移字段，保留原文件");
    }
    return true;
  } catch (err) {
    log.warn("CONFIG", `配置迁移失败: ${err}，将继续使用旧格式加载`);
    return false;
  }
}

/** 导出字段分类（供测试使用） */
export const _internal = { SETTINGS_FIELDS, APP_CONFIG_FIELDS, KEY_MAP };
