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

import { readFileSync, existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { resolveEnvVars } from "../env-interpolation.ts";
import { markInternalWrite } from "./internal-writes.ts";
import {
  backupSettingsFile,
  listSettingsBackups,
  preserveCorruptedSettingsFile,
} from "./backup.ts";
import { writeAtomic } from "../app-config.ts";
import {
  SETTING_SOURCES,
  getLegacyLocalSettingsPath,
  realDir,
  getSettingsFilePath,
  type SettingSource,
} from "./constants.ts";
import { SettingsSchema, type SettingsJson } from "./types.ts";
import {
  formatZodErrors,
  filterInvalidPermissionRules,
  removeInvalidValues,
  type ValidationError,
} from "./validation.ts";

/** 单文件字段级修复的最大轮数（每轮摘掉当轮全部出错值后重新校验） */
const MAX_FIELD_REPAIR_ATTEMPTS = 10;
import { filterProjectSettings, isUntrustedSettingsFile } from "./security.ts";
import { listManagedSettingsDropIns } from "./constants.ts";
import { detectSensitiveData } from "../../permission/sensitive.ts";
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

/**
 * 注入 flagSettings（--settings CLI 参数）。注入后清空 L1 合并缓存以重新合并。
 *
 * flagSettings **不走 L2/L3 缓存**：getSettingsForSource 在缓存检查之前就直接返回这个
 * 模块变量。此前这里还顺手写了一条 L2 条目，但它永远不会被读到（D12），只会让读者
 * 以为 flagSettings 参与三级缓存、会被 resetSettingsCache 失效——实际两者都不成立，
 * 也不应成立（它是本进程显式注入的内存值，没有磁盘文件可以重读）。
 */
export function setFlagSettings(settings: SettingsJson | null): void {
  flagSettings = settings;
  setSessionCache(null);
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
export function setEnabledSettingSources(
  sources: ("user" | "project" | "local")[] | null | undefined,
): void {
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
export function getEnabledSettingSources(): readonly SettingSource[] {
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
      // 返回副本：调用方（policySettings 的 drop-in 合并）会原地 push，
      // 直接返回缓存数组会把 drop-in 的错误永久追加进主文件的 L3 条目。
      errors: [...cached.errors],
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

    // 预过滤无效权限规则（不让一条坏规则毒化整个文件）
    const ruleWarnings = filterInvalidPermissionRules(data, path);

    // Zod Schema 验证。失败时只摘掉出错的那几个值再校验（D10）：Zod 是整体校验语义，
    // 直接判失败会让一个无关字段的类型笔误（如 maxTokens 写成字符串）连带丢掉同文件里的
    // permissions.deny 等全部配置，且当时没有任何出口能看见这条错误。
    // 上限防的是病态 schema 反复报同一路径的死循环；removeInvalidValues 摘不动时也会停。
    let result = SettingsSchema().safeParse(data);
    const zodErrors: ValidationError[] = [];
    for (let attempt = 0; !result.success && attempt < MAX_FIELD_REPAIR_ATTEMPTS; attempt++) {
      const issues = result.error.issues;
      zodErrors.push(
        ...formatZodErrors(result.error, path).map((e) => ({
          ...e,
          message: `${e.message}（该值已忽略，其余配置照常生效）`,
        })),
      );
      if (!removeInvalidValues(data, issues)) break;
      result = SettingsSchema().safeParse(data);
    }

    if (!result.success) {
      // 走到这里说明错误无法局部摘除（如根本身不是对象）——这才是整份判失败的情形
      const errors = [...ruleWarnings, ...zodErrors, ...formatZodErrors(result.error, path)];
      setCachedParsedFile(path, { settings: null, errors });
      return { settings: null, errors: [...errors] };
    }

    const errors = [...ruleWarnings, ...zodErrors];
    setCachedParsedFile(path, { settings: result.data, errors });
    return { settings: clone(result.data), errors: [...errors] };
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

/** workspacePath 指向 cwd 以外的目录时为真——此时 L1/L2 缓存（按 cwd 建立）不适用 */
function isForeignWorkspace(workspacePath: string | undefined): boolean {
  if (workspacePath === undefined) return false;
  if (resolve(workspacePath) === resolve(process.cwd())) return false;
  // 字面不同再比 realpath：指向 cwd 的 symlink 不是「别的目录」，否则每次都绕过缓存读盘
  return realDir(workspacePath) !== realDir(process.cwd());
}

/**
 * 获取单个来源的 Settings（带 Level 2 缓存）。
 * projectSettings 会经过安全字段过滤。
 */
export function getSettingsForSource(
  source: SettingSource,
  workspacePath?: string,
): { settings: SettingsJson | null; errors: ValidationError[] } {
  // flagSettings 来自内存，不读文件，也不经 L2 缓存（见 setFlagSettings）
  if (source === "flagSettings") {
    return { settings: flagSettings, errors: [] };
  }

  // P8：L2 缓存键只有 source，不含 workspacePath。传了别的项目目录（worktree 传 gitRoot）
  // 还读写 L2，拿到的就是 cwd 那份、或把别处的设置塞进 cwd 的缓存。这种调用直接读盘。
  const foreign = isForeignWorkspace(workspacePath);
  const cachedSource = foreign ? undefined : getCachedSource(source);
  if (cachedSource !== undefined) {
    // L2 同时缓存 errors：此前只存 settings、命中时回 errors:[]，于是先被 getSettingsForSource
    // 填过 L2 的来源（loadConfigFile 就这么做）在 getSettings 合并时诊断恒为空——D10 的
    // 校验错误因此没有任何出口。
    return { settings: cachedSource.settings, errors: [...cachedSource.errors] };
  }

  const path = getSettingsFilePath(source, workspacePath);
  if (!path) {
    if (!foreign) setCachedSource(source, { settings: null, errors: [] });
    return { settings: null, errors: [] };
  }

  const parsedMain = parseSettingsFile(path);
  const errors = parsedMain.errors;
  let settings = parsedMain.settings;

  // P1b 兼容：local 基准迁到 git root 之后，启动目录里的旧 settings.local.json 仍合并读取，
  // 同 key 以 git root 那份为准（旧文件作基座、新文件叠加）。旧文件单独过一次不可信过滤，
  // 因为下面的过滤只按新路径判定是否被 git 追踪。
  if (source === "localSettings") {
    const legacyPath = getLegacyLocalSettingsPath(workspacePath ?? process.cwd());
    if (legacyPath && existsSync(legacyPath)) {
      const legacy = parseSettingsFile(legacyPath);
      errors.push(...legacy.errors);
      if (legacy.settings) {
        const legacySafe = isUntrustedSettingsFile(source, legacyPath)
          ? filterProjectSettings(legacy.settings)
          : legacy.settings;
        settings = settings
          ? mergeSettingsRead(legacySafe as Record<string, unknown>, settings)
          : legacySafe;
      }
    }
  }

  // B2：policySettings 额外合并 managed-settings.d/*.json。字母序后者覆盖前者，
  // 主文件（managed-settings.json）作为基座，drop-in 在其上叠加。
  let merged = settings;
  if (source === "policySettings") {
    for (const dropIn of listManagedSettingsDropIns()) {
      const parsed = parseSettingsFile(dropIn);
      errors.push(...parsed.errors);
      if (parsed.settings) {
        merged = mergeSettingsRead((merged ?? {}) as Record<string, unknown>, parsed.settings);
      }
    }
  }

  // 安全边界：不可信来源不能设置安全敏感字段。
  // 不只认 projectSettings：被 git 追踪的 settings.local.json 同样会跟着仓库 clone 下来（D1），
  // 且 localSettings 优先级比 projectSettings 还高，不过滤它等于把后门开在防护最弱、权力最大的一层。
  const untrusted = merged ? isUntrustedSettingsFile(source, path) : false;
  if (untrusted && source === "localSettings") {
    errors.push({
      file: path,
      path: "",
      message:
        "settings.local.json 已被 git 追踪（会随仓库分发），按不可信来源处理：安全敏感字段已忽略。" +
        "若确为本机私有配置，请执行 git rm --cached 取消追踪",
    });
  }
  const finalSettings = merged && untrusted ? filterProjectSettings(merged) : merged;

  if (!foreign) setCachedSource(source, { settings: finalSettings, errors: [...errors] });
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

  // ── 运行时护栏（SEC-AUDIT-2026-07-19 P2）─────────────────────────────────
  //
  // 上面那一大段"绝大多数场景应改用 patchSettingsFile"此前**只是注释**——
  // 纪律靠人读文档维持，一个没读过的调用方就能把 resolveEnvVars 展开后的明文密钥
  // 落盘，而且落盘后毫无痕迹（文件权限 0o600 只防其他用户，不防这次覆盖本身）。
  //
  // 现在把纪律变成运行时强制：检测入参里是否含**已展开的明文凭证**，命中即抛错。
  // fail-closed 的理由——写明文密钥是不可撤销的（文件一旦落盘，密钥就该视为已泄露，
  // 需要轮换）；相比之下抛错只是让调用方改用 patchSettingsFile，代价极小。
  //
  // 注意只拦"明文值"，不拦 `"${API_KEY}"` 占位符形态：后者正是我们希望的写法。
  {
    const serialized = JSON.stringify(settings);
    const hits = detectSensitiveData(serialized);
    if (hits.length > 0) {
      const kinds = [...new Set(hits.map((h) => h.type))].join(", ");
      throw new Error(
        `writeSettingsFile 拒绝写入：检测到 ${hits.length} 处明文凭证（${kinds}）。\n` +
          `这通常意味着入参来自 getSettingsForSource()——它经 resolveEnvVars 把 "\${VAR}" ` +
          `占位符展开成了明文，整体覆盖会把密钥落盘。\n` +
          `请改用 patchSettingsFile(source, field, value) 做外科式补丁（不经 Zod round-trip、` +
          `不展开占位符），或在写入前把凭证字段还原为 "\${VAR}" 形态。`,
      );
    }
  }

  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  backupSettingsFile(source, path);
  markInternalWrite(path); // 抑制自身写入触发的变更通知
  writeAtomic(path, JSON.stringify(settings, null, 2)); // D9：原子写

  // 失效缓存，下次读取重新读盘（必须 clear 删键，不能 setCachedSource(source,null)——
  // 后者会被 getCachedSource 当"已缓存且无设置"命中，导致同会话内后续 read-then-patch
  // 从空对象起步、覆盖掉本次补丁写入的字段）。
  clearCachedSource(source);
  setSessionCache(null);
}

/**
 * 损坏文件的报错文案：留档原文件，并给出可用的恢复路径（D9）。
 * 此前只有一句「解析失败」，用户手里没有任何备份可恢复。
 */
function corruptedSettingsMessage(
  action: string,
  source: SettingSource,
  path: string,
  err: unknown,
): string {
  const preserved = preserveCorruptedSettingsFile(source, path);
  const backups = listSettingsBackups(source, path);
  const lines = [`settings 文件解析失败，${action}: ${path}\n${err}`];
  if (preserved) lines.push(`损坏文件已留档: ${preserved}`);
  lines.push(
    backups.length > 0
      ? `最近一次可用备份: ${backups[0]}（共 ${backups.length} 份，复制回原路径即可恢复）`
      : "没有可用的写前备份，请手动修复该文件的 JSON 语法",
  );
  return lines.join("\n");
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
      throw new Error(corruptedSettingsMessage("已跳过补丁写入以免覆盖", source, path, err));
    }
  }

  if (value === undefined) delete raw[key];
  else raw[key] = value;

  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  backupSettingsFile(source, path);
  markInternalWrite(path); // 抑制自身写入触发的变更通知
  writeAtomic(path, JSON.stringify(raw, null, 2)); // D9：原子写

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
    throw new Error(corruptedSettingsMessage("已跳过默认配置补全以免覆盖", source, path, err));
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

  backupSettingsFile(source, path);
  markInternalWrite(path); // 抑制自身写入触发的变更通知
  writeAtomic(path, JSON.stringify(raw, null, 2)); // D9：原子写

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
  // P8：会话缓存是按 cwd 合并的那一份。旧实现有缓存就直接返回、参数被静默忽略，
  // worktree/config.ts、worktree/manager.ts 传 gitRoot 实际拿到的是 cwd 的设置。
  // 传了与 cwd 不同的目录就绕过两级缓存现读，也不回写（否则污染 cwd 那份）。
  if (isForeignWorkspace(workspacePath)) return loadSettingsFromDisk(workspacePath);

  const cached = getSessionCache();
  if (cached) return cached;

  const result = loadSettingsFromDisk(workspacePath);
  setSessionCache(result);
  return result;
}
