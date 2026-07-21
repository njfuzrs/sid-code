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
  clearCachedSource,
  getCachedParsedFile,
  setCachedParsedFile,
  clearCachedParsedFile,
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

/**
 * P1-6 --setting-sources：限定加载的磁盘来源子集（user/project/local）。
 * null = 不限制（默认加载全部）。非 null 时仅列出的磁盘来源生效。
 *
 * 注意：flagSettings（--settings 显式注入）与 policySettings（企业强制管控）**始终保留**——
 * 前者是用户本次命令显式给的、后者是不可绕过的管控，都不受 --setting-sources 限制。
 */
let enabledDiskSources: ReadonlySet<SettingSource> | null = null;

/**
 * 设置 --setting-sources 过滤（cli.ts 极早期调用，早于任何 getSettings）。
 * @param sources CC 风格来源名子集 user/project/local；空/undefined 清除限制。
 */
export function setEnabledSettingSources(sources: ("user" | "project" | "local")[] | null | undefined): void {
  if (!sources || sources.length === 0) {
    enabledDiskSources = null;
    setSessionCache(null);
    return;
  }
  const map: Record<"user" | "project" | "local", SettingSource> = {
    user: "userSettings",
    project: "projectSettings",
    local: "localSettings",
  };
  // 磁盘来源按子集过滤；内存/管控来源始终保留。
  const allowed = new Set<SettingSource>(sources.map((s) => map[s]));
  allowed.add("flagSettings");
  allowed.add("policySettings");
  enabledDiskSources = allowed;
  setSessionCache(null); // 过滤变更，清缓存重新合并
}

/** 当前生效的 SettingSource 列表（受 --setting-sources 过滤，见 setEnabledSettingSources） */
function getEnabledSettingSources(): readonly SettingSource[] {
  if (enabledDiskSources === null) return SETTING_SOURCES;
  return SETTING_SOURCES.filter((s) => enabledDiskSources!.has(s));
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
 * ⚠️ **危险 API——绝大多数场景应使用 patchSettingsFile() 替代。**
 *
 * 本函数接收完整 Settings 对象并整体覆盖文件。若入参来自
 * getSettingsForSource()（经 Zod safeParse 有损解析 + resolveEnvVars 明文展开），
 * 会产生两类严重副作用：
 *   1. Zod strip：嵌套 schema 未声明的字段被删除（如 api_key snake_case 写法）
 *   2. env 明文化：`"${API_KEY}"` 占位符被展开成明文密钥落盘
 *
 * 仅在以下罕见场景使用：
 *   - 首次创建文件（源为空，不存在 round-trip 问题）
 *   - 迁移脚本需要完整重写整个文件结构
 *
 * 对于修改单个或少数顶层字段，**必须**使用 patchSettingsFile()。
 *
 * @param source 目标来源（flagSettings 无文件，直接忽略）
 * @param settings 完整 Settings 内容（写入语义为整体替换文件）
 * @deprecated 优先使用 patchSettingsFile()，避免有损 round-trip。
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

  // 失效缓存，下次读取重新读盘（必须 clear 删键，不能 setCachedSource(source,null)——
  // 后者会被 getCachedSource 当"已缓存且无设置"命中，导致同会话内后续 read-then-patch
  // 从空对象起步、覆盖掉本次补丁写入的字段）。
  clearCachedSource(source);
  setSessionCache(null);
}

/**
 * 外科式补丁：只改文件里的单个顶层字段，其余原样保留。
 *
 * 与 writeSettingsFile 的关键区别：**不经过 Zod round-trip**。
 * writeSettingsFile 的入参通常来自 getSettingsForSource() → parseSettingsFile() →
 * SettingsSchema().safeParse()，而 ModelConfigSchema 无 .passthrough()，会 strip 掉
 * availableModels[] 里的 api_key/base_url（及其它 schema 未声明的嵌套字段），再整体覆盖
 * 写回就会永久丢失密钥——正是 `/effort -p` / `/think -p` 持久化后启动报“未设置
 * OPENAI_API_KEY”的根因。
 *
 * 另一重风险：parseSettingsFile 读取时会 resolveEnvVars 把 "${DEEPSEEK_API_KEY}" 展开成
 * 明文，若走 round-trip 写回会把明文密钥落盘。本函数直接读原始 JSON 文本、只改目标字段，
 * 从根上规避这两类问题。
 *
 * @param source 目标来源（仅文件型来源有效；flagSettings 等内存来源直接忽略）
 * @param key    要写入的顶层字段名
 * @param value  字段值；传 undefined 表示删除该字段（回退默认，如 effort → auto）
 */
export function patchSettingsFile(
  source: SettingSource,
  key: string,
  value: unknown,
  workspacePath?: string,
): void {
  const path = getSettingsFilePath(source, workspacePath);
  if (!path) return; // flagSettings 等内存来源无文件

  // 读原始 JSON 文本（不展开 env 占位符、不做 Zod 校验），保留用户所有原始字段。
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, "utf-8"));
    } catch (err) {
      // 文件损坏时不要静默覆盖用户配置——直接抛出，让上层决定是否吞掉。
      throw new Error(`settings 文件解析失败，已跳过补丁写入以免覆盖: ${err}`);
    }
  }

  if (value === undefined) delete raw[key];
  else raw[key] = value;

  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  markInternalWrite(path); // 抑制自身写入触发的变更通知
  writeFileSync(path, JSON.stringify(raw, null, 2), { mode: 0o600 });

  // 失效缓存，下次读取重新读盘（必须 clear 删键，不能 setCachedSource(source,null)——
  // 后者会被 getCachedSource 当"已缓存且无设置"命中，导致同会话内后续 read-then-patch
  // 从空对象起步、覆盖掉本次补丁写入的字段）。
  clearCachedParsedFile(path);
  clearCachedSource(source);
  setSessionCache(null);
}

/**
 * 浅合并：只把 defaults 里「用户尚未拥有的顶层键」补进 settings 文件，其余原样保留。
 *
 * 用于 `sid-code update` 后首次启动的团队默认配置补全（见
 * src/migrations/backfill-team-defaults.ts）。与 patchSettingsFile 共享同一套安全写入
 * 语义——直接读原始 JSON 文本（不展开 env 占位符、不过 Zod round-trip），因此不会把
 * ${API_KEY} 展开成明文落盘、也不会 strip 掉 availableModels[].api_key 这类嵌套字段。
 *
 * "缺失"的判定只看顶层 key 是否 `in` 用户对象：用户把某数组显式设成 `[]`、某对象设成
 * `{}` 都算「用户已表态」，一律不覆盖。这保证：用户主动删掉某个键后，本函数确实会再补
 * 回来——但真正的「只补一次」幂等由上层迁移水位线（migrations.json 的 migrationVersion）
 * 保证，本函数只负责单次浅合并的正确性。
 *
 * @param source        目标来源（仅文件型来源有效；内存来源直接忽略）
 * @param defaults      完整默认配置对象（团队模板）
 * @param workspacePath 工作区路径（项目级来源用；userSettings 忽略）
 * @returns 实际补入的顶层键名数组（空数组表示无缺失、未写文件）
 */
export function mergeMissingTopLevelKeys(
  source: SettingSource,
  defaults: Record<string, unknown>,
  workspacePath?: string,
): string[] {
  const path = getSettingsFilePath(source, workspacePath);
  if (!path) return []; // flagSettings 等内存来源无文件

  // 文件不存在 = 首次安装场景（install.sh 已负责整份拷贝团队默认配置），不在此创建，避免
  // 与安装脚本职责重叠、也避免在无配置机器上凭空生成半份配置。
  if (!existsSync(path)) return [];

  // 读原始 JSON 文本（不展开 env 占位符、不做 Zod 校验），保留用户所有原始字段。
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    // 文件损坏时不要静默覆盖用户配置——直接抛出，让上层（迁移 runner）记录警告并跳过。
    throw new Error(`settings 文件解析失败，已跳过默认配置补全以免覆盖: ${err}`);
  }

  const added: string[] = [];
  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in raw)) {
      raw[key] = value;
      added.push(key);
    }
  }

  if (added.length === 0) return []; // 无缺失，不写文件

  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  markInternalWrite(path); // 抑制自身写入触发的变更通知
  writeFileSync(path, JSON.stringify(raw, null, 2), { mode: 0o600 });

  // 失效缓存，下次读取重新读盘（必须 clear 删键，不能 setCachedSource(source,null)——
  // 后者会被 getCachedSource 当"已缓存且无设置"命中，导致同会话内后续 read-then-patch
  // 从空对象起步、覆盖掉本次补丁写入的字段）。
  clearCachedParsedFile(path);
  clearCachedSource(source);
  setSessionCache(null);

  return added;
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
