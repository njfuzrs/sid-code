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
 * 唯一真相源为 settings.json，旧格式 config.yaml 已废弃，不再回退读取。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { getLogger } from "../../debug/logger.ts";
import { resolveEnvVars } from "../env-interpolation.ts";
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

/** 已告警过的文件路径，避免每次读取都刷屏（同一进程内仅告警一次） */
const plaintextWarned = new Set<string>();

/**
 * 检测配置中的明文 API key（sk- 开头）并告警，引导用户迁移到 env 占位符。
 *
 * 安全设计：仅记录字段位置（如 availableModels[0].apiKey），绝不打印 key 值本身。
 * env resolver 已先行展开 "${VAR}"，因此残留的 sk- 明文必定是硬编码而非占位符。
 */
function warnPlaintextApiKeys(data: unknown, path: string): void {
  if (plaintextWarned.has(path)) return;

  const hits: string[] = [];
  const isPlaintextKey = (v: unknown): boolean =>
    typeof v === "string" && /^sk-[A-Za-z0-9]/.test(v);

  const root = data as Record<string, unknown> | null;
  if (!root || typeof root !== "object") return;

  // 顶层密钥字段
  for (const field of ["anthropicKey", "openaiKey"]) {
    if (isPlaintextKey(root[field])) hits.push(field);
  }
  // availableModels[].apiKey
  if (Array.isArray(root.availableModels)) {
    root.availableModels.forEach((m: any, i: number) => {
      if (m && isPlaintextKey(m.apiKey)) hits.push(`availableModels[${i}].apiKey`);
    });
  }
  // search.* 密钥
  const search = root.search as Record<string, unknown> | undefined;
  if (search && typeof search === "object") {
    for (const field of ["braveApiKey", "tavilyApiKey"]) {
      if (isPlaintextKey(search[field])) hits.push(`search.${field}`);
    }
  }

  if (hits.length > 0) {
    plaintextWarned.add(path);
    getLogger().warn(
      "SETTINGS",
      `检测到 ${path} 含明文 API key（${hits.join(", ")}）。` +
        `建议改用 env 占位符（如 "\${DEEPSEEK_API_KEY}"）并在 shell 或 settings.json 的 env 段注入，` +
        `避免密钥随配置泄露。`,
    );
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
    const raw = JSON.parse(content);

    // env 占位符展开：把 "${VAR}" / "$VAR" 替换为 process.env 对应值。
    // 在 Zod 验证前执行，使 api_key 等敏感字段可写成 "${DEEPSEEK_API_KEY}"，
    // 密钥与配置结构分离（对标 claude-code env 注入）。
    const data = resolveEnvVars(raw);

    // 检测明文 API key（sk- 开头），告警引导用户迁移到 env 占位符
    warnPlaintextApiKeys(data, path);

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

/**
 * 获取最终生效的 Settings（带 Level 1 会话缓存）。
 *
 * 这是上层模块读取行为配置的统一入口。唯一真相源为 settings.json。
 */
export function getSettings(workspacePath?: string): SettingsWithErrors {
  const cached = getSessionCache();
  if (cached) return cached;

  const result = loadSettingsFromDisk(workspacePath);
  setSessionCache(result);
  return result;
}
