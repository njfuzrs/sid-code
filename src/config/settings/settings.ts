/**
 * Settings 系统核心：加载、合并、读取
 *
 * 对齐 Spec 15 §3.4 / §4.1 / §7.2。
 *
 * 读取路径（三级缓存）：
 *   getSettings() → Level 1 命中？ → loadSettingsFromDisk()
 *     → getSettingsForSource() → Level 2 命中？ → parseSettingsFile()
 *       → Level 3 命中？（clone 后返回） → 磁盘读取 + Zod 验证
 *
 * 非破坏式设计：新格式（settings.json）为空时，回退到旧格式 config.yaml，
 * 保证现有用户在迁移前零感知。旧 config.yaml 始终保留为兼容层。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { join } from "path";
import { parse as parseYAML } from "yaml";
import { getLogger } from "../../debug/logger.ts";
import { getSidHome } from "../paths.ts";
import { markInternalWrite } from "./internal-writes.ts";
import {
  SETTING_SOURCES,
  getSettingsFilePath,
  type SettingSource,
} from "./constants.ts";
import { SettingsSchema, type SettingsJson } from "./types.ts";
import {
  formatZodErrors,
  filterInvalidPermissionRules,
  type ValidationError,
} from "./validation.ts";
import { filterProjectSettings } from "./security.ts";
import { mergeSettingsRead } from "./merge.ts";
import {
  getSessionCache,
  setSessionCache,
  getCachedSource,
  setCachedSource,
  getCachedParsedFile,
  setCachedParsedFile,
  type MergedSettings,
} from "./cache.ts";

/** 带错误信息的 Settings */
export interface SettingsWithErrors {
  settings: SettingsJson;
  errors: ValidationError[];
}

/**
 * flagSettings 内存来源（来自 --settings CLI 参数）。
 * 由 cli.ts 在解析参数后通过 setFlagSettings() 注入。
 */
let flagSettings: SettingsJson | null = null;

/** 注入 flagSettings（--settings CLI 参数）。注入后清空缓存以重新合并。 */
export function setFlagSettings(settings: SettingsJson | null): void {
  flagSettings = settings;
  setSessionCache(null);
  setCachedSource("flagSettings", settings);
}

/** 当前生效的 SettingSource 列表（预留 SDK 模式禁用某些来源的扩展点） */
function getEnabledSettingSources(): readonly SettingSource[] {
  return SETTING_SOURCES;
}

/** 安全的 structuredClone（Bun/Node ≥17 全局可用，降级到 JSON 克隆） */
function clone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

/**
 * 解析单个来源的 Settings 文件（带 Level 3 缓存 + clone 保护）。
 */
function parseSettingsFile(path: string): {
  settings: SettingsJson | null;
  errors: ValidationError[];
} {
  // Level 3 缓存命中 → clone 后返回（防止 mergeSettingsRead 污染缓存）
  const cached = getCachedParsedFile(path);
  if (cached) {
    return {
      settings: cached.settings ? clone(cached.settings) : null,
      errors: cached.errors,
    };
  }

  if (!existsSync(path)) {
    setCachedParsedFile(path, { settings: null, errors: [] });
    return { settings: null, errors: [] };
  }

  try {
    const content = readFileSync(path, "utf-8");
    const data = JSON.parse(content);

    // 预过滤无效权限规则（不让一条坏规则毒化整个文件）
    const ruleWarnings = filterInvalidPermissionRules(data, path);

    // Zod Schema 验证
    const result = SettingsSchema().safeParse(data);

    if (!result.success) {
      const zodErrors = formatZodErrors(result.error, path);
      const errors = [...ruleWarnings, ...zodErrors];
      setCachedParsedFile(path, { settings: null, errors });
      return { settings: null, errors };
    }

    setCachedParsedFile(path, { settings: result.data, errors: ruleWarnings });
    return { settings: clone(result.data), errors: ruleWarnings };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return { settings: null, errors: [] };
    }
    return {
      settings: null,
      errors: [{ path: "", file: path, message: `文件解析失败: ${err}` }],
    };
  }
}

/**
 * 获取单个来源的 Settings（带 Level 2 缓存）。
 * projectSettings 会经过安全字段过滤。
 */
export function getSettingsForSource(
  source: SettingSource,
  workspacePath?: string,
): { settings: SettingsJson | null; errors: ValidationError[] } {
  // flagSettings 来自内存，不读文件
  if (source === "flagSettings") {
    return { settings: flagSettings, errors: [] };
  }

  const cachedSource = getCachedSource(source);
  if (cachedSource !== undefined) {
    return { settings: cachedSource, errors: [] };
  }

  const path = getSettingsFilePath(source, workspacePath);
  if (!path) {
    setCachedSource(source, null);
    return { settings: null, errors: [] };
  }

  const { settings, errors } = parseSettingsFile(path);

  // 安全边界：项目级配置不能设置安全敏感字段
  const finalSettings =
    settings && source === "projectSettings"
      ? filterProjectSettings(settings)
      : settings;

  setCachedSource(source, finalSettings);
  return { settings: finalSettings, errors };
}

/**
 * 写入单个来源的 Settings 文件（write-through + 内部写入抑制 + 0o600）。
 *
 * 在写文件前调用 markInternalWrite()，使变更检测器跳过本次（自身）写入的通知；
 * 写入后清空会话/单来源缓存，下次 getSettings() 重新合并。
 *
 * @param source 目标来源（flagSettings 无文件，直接忽略）
 * @param settings 完整 Settings 内容（写入语义为整体替换文件）
 */
export function writeSettingsFile(
  source: SettingSource,
  settings: SettingsJson,
  workspacePath?: string,
): void {
  const path = getSettingsFilePath(source, workspacePath);
  if (!path) return; // flagSettings 等内存来源无文件

  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  markInternalWrite(path); // 抑制自身写入触发的变更通知
  writeFileSync(path, JSON.stringify(settings, null, 2), { mode: 0o600 });

  // 失效缓存，下次读取重新合并
  setCachedSource(source, null);
  setSessionCache(null);
}

/**
 * 核心加载函数：从所有来源加载、验证、合并（读取语义：数组拼接去重）。
 * 不读缓存——总是重新合并（缓存逻辑在 getSettings 层）。
 */
export function loadSettingsFromDisk(workspacePath?: string): MergedSettings {
  let merged: SettingsJson = {};
  const allErrors: ValidationError[] = [];

  for (const source of getEnabledSettingSources()) {
    const { settings, errors } = getSettingsForSource(source, workspacePath);
    allErrors.push(...errors);
    if (settings) {
      merged = mergeSettingsRead(merged, settings);
    }
  }

  return { settings: merged, errors: allErrors };
}

/** 判断合并结果是否为空（用于决定是否回退旧格式） */
function isEmptySettings(settings: SettingsJson): boolean {
  return Object.keys(settings).length === 0;
}

/**
 * 获取最终生效的 Settings（带 Level 1 会话缓存 + 旧格式回退）。
 *
 * 这是上层模块读取行为配置的统一入口。
 */
export function getSettings(workspacePath?: string): SettingsWithErrors {
  const cached = getSessionCache();
  if (cached) return cached;

  const result = loadSettingsFromDisk(workspacePath);

  // 新格式为空且旧格式存在 → 回退到旧格式 config.yaml
  if (isEmptySettings(result.settings)) {
    const legacy = loadLegacyConfigAsSettings();
    if (legacy && !isEmptySettings(legacy.settings)) {
      setSessionCache(legacy);
      return legacy;
    }
  }

  setSessionCache(result);
  return result;
}

/**
 * 从旧格式 config.yaml 提取 Settings 相关字段（向后兼容）。
 * 复用 config.ts 暴露的 normalizeConfigKeys 逻辑。
 */
function loadLegacyConfigAsSettings(): MergedSettings | null {
  const configPath = join(getSidHome(), "config.yaml");
  if (!existsSync(configPath)) return null;

  try {
    const content = readFileSync(configPath, "utf-8");
    const raw = parseYAML(content);
    if (!raw || typeof raw !== "object") return null;

    const settings = extractSettingsFields(raw);
    return { settings, errors: [] };
  } catch (err) {
    getLogger().warn("SETTINGS", `回退读取旧格式 config.yaml 失败: ${err}`);
    return null;
  }
}

/** 旧 config.yaml 中归属 Settings 的字段（snake_case 与 camelCase 都接受） */
const LEGACY_SETTINGS_KEYS: Record<string, keyof SettingsJson> = {
  provider: "provider",
  model: "model",
  fallback_model: "fallbackModel",
  fallbackModel: "fallbackModel",
  anthropic_key: "anthropicKey",
  anthropicKey: "anthropicKey",
  openai_api_key: "openaiKey",
  openaiKey: "openaiKey",
  base_url: "baseURL",
  baseURL: "baseURL",
  max_tokens: "maxTokens",
  maxTokens: "maxTokens",
  available_models: "availableModels",
  availableModels: "availableModels",
  permission_mode: "permissionMode",
  permissionMode: "permissionMode",
  allowed_tools: "allowedTools",
  allowedTools: "allowedTools",
  disallowed_tools: "disallowedTools",
  disallowedTools: "disallowedTools",
  hooks: "hooks",
  mcp_servers: "mcpServers",
  mcpServers: "mcpServers",
  sub_agent_models: "subAgentModels",
  subAgentModels: "subAgentModels",
  cost_limit: "costLimit",
  costLimit: "costLimit",
  quota: "quota",
  search: "search",
  disabled_skills: "disabledSkills",
  disabledSkills: "disabledSkills",
  sanitize_env: "sanitizeEnv",
  sanitizeEnv: "sanitizeEnv",
  trust_project_extensions: "trustProjectExtensions",
  trustProjectExtensions: "trustProjectExtensions",
  jit_context: "jitContext",
  jitContext: "jitContext",
  allowed_directories: "allowedDirectories",
  allowedDirectories: "allowedDirectories",
  blocked_directories: "blockedDirectories",
  blockedDirectories: "blockedDirectories",
  env: "env",
};

/** 从原始 YAML 对象提取 Settings 字段（仅做 key 映射，不做深度归一化） */
function extractSettingsFields(raw: Record<string, unknown>): SettingsJson {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const mapped = LEGACY_SETTINGS_KEYS[key];
    if (mapped && value !== undefined) {
      out[mapped] = value;
    }
  }
  return out as SettingsJson;
}
