/**
 * AppConfig 子系统：内部应用状态
 *
 * 对齐 Spec 15 §5。与 Settings 系统分离——AppConfig 管理不需要多层合并、
 * 不需要企业管控、不需要项目级覆盖的内部状态（UI 偏好、启动计数、项目信任等）。
 *
 * 设计目标：
 * 1. 启动后每次读取都是纯内存操作（内存缓存 + write-through）
 * 2. 多进程并发写入安全（基于最新状态的 updater + Auth-Loss Guard）
 * 3. 数据不丢失（时间戳备份 + 损坏检测）
 *
 * 存储位置：~/.sid-code/app.json（mode 0o600）
 */

import {
  readFileSync,
  writeFileSync,
  watchFile,
  unwatchFile,
  statSync,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
  copyFileSync,
  renameSync,
} from "fs";
import { join } from "path";
import { getSidHome, sidPaths } from "./paths.ts";

/** 项目级配置（按项目路径索引） */
export interface ProjectConfig {
  /** 会话级工具授权列表 */
  allowedTools: string[];
  /** 信任对话框是否已接受 */
  hasTrustDialogAccepted?: boolean;
  /** 项目级 onboarding 是否完成 */
  hasCompletedProjectOnboarding?: boolean;
  /** MCP 服务器审批状态 */
  mcpServerApprovals?: Record<string, boolean>;
  /**
   * M4：CLAUDE.md 外部导入（项目根之外，含 ~/）是否已批准。
   * undefined = 尚未询问；true = 已批准（外部导入静默展开）；false = 已拒绝（外部导入跳过）。
   */
  claudeMdExternalImportsApproved?: boolean;
  /** M4：外部导入审批警告是否已展示过（避免重复弹窗）。 */
  claudeMdExternalImportsWarningShown?: boolean;
}

/** 全局应用配置 */
export interface AppConfig {
  // UI 偏好
  theme?: string;
  showLineNumbers: boolean;

  // 会话追踪
  numStartups: number;
  firstStartTime?: string;
  hasCompletedOnboarding?: boolean;

  // 提示渐进衰减（对标 cc：onboarding 提示按已显示次数衰减，看够了就不再打扰）
  // key = hint 标识（如 "shellMode" / "ctrlOExpand"），value = 已显示次数
  hints?: Record<string, number>;

  // update 后网关定价强制刷新水位线：记录「上次跑网关定价刷新时的二进制版本号」。
  // 新二进制首次启动发现此值 ≠ 当前版本（= 刚 update 过），就忽略 24h TTL 强制全端点刷新一次，
  // 确保 update 后立即拿到最新渠道价，而不必等 TTL 到期或用户手动 /model discover --pricing。
  lastPricingSyncVersion?: string;

  // 调试配置
  debug: boolean;
  debugLevel: string;
  debugLogFile: string;

  // 项目级状态（按路径索引）
  projects?: Record<string, ProjectConfig>;

  // Checkpoint 配置
  checkpoint?: {
    enabled?: boolean;
    maxCheckpointsPerFile?: number;
    maxTotalSizeMb?: number;
    maxAgeDays?: number;
    compressThresholdKb?: number;
    largeFileThresholdLines?: number;
    hugeFileThresholdLines?: number;
  };

  // 会话保留配置
  sessionRetention?: {
    enabled?: boolean;
    maxAge?: string;
    maxCount?: number;
    minRetention?: string;
  };

  // 轨迹采集配置
  trace?: {
    enabled?: boolean;
    outputDir?: string;
    maxSessionsRetained?: number;
    upload?: Record<string, unknown>;
  };

  // 遥测配置
  telemetry?: {
    enabled: boolean;
    exporters: Array<{ type: string; options?: Record<string, unknown> }>;
    batchSize?: number;
    flushIntervalMs?: number;
    maxQueueSize?: number;
  };
}

/** AppConfig 文件路径 */
export function getAppConfigPath(): string {
  return join(getSidHome(), "app.json");
}

/** 备份目录 */
function getBackupDir(): string {
  return join(getSidHome(), "backups");
}

const MAX_BACKUPS = 5;
const MIN_BACKUP_INTERVAL_S = 60;

/**
 * app.json 合法拥有的顶层键 = AppConfig 的全部字段。
 *
 * 这是「app.json 不存行为配置」的机械边界：loadNewFormatAsConfig 读 app.json 时
 * 丢弃清单外的键，迁移 v4 把清单外的存量键搬回 settings.json。
 * 新增 AppConfig 字段时必须同时加进这里——漏了的后果是该字段从 app.json 读不出来，
 * 而不是静默读到一份来源不明的值。
 */
export const APP_CONFIG_OWNED_KEYS: ReadonlySet<string> = new Set([
  "theme",
  "showLineNumbers",
  "numStartups",
  "firstStartTime",
  "hasCompletedOnboarding",
  "hints",
  "lastPricingSyncVersion",
  "debug",
  "debugLevel",
  "debugLogFile",
  "projects",
  "checkpoint",
  "sessionRetention",
  "trace",
  "telemetry",
]);

/** 默认 AppConfig */
export function createDefaultAppConfig(): AppConfig {
  return {
    showLineNumbers: true,
    numStartups: 0,
    debug: false,
    debugLevel: "INFO",
    // 走 sidPaths 派生，不写 "~/.sid-code/debug.log" 字面量：字面量的展开侧
    // （debug/logger.ts）用 homedir()，于是 SID_CONFIG_DIR 管不到日志落点。
    debugLogFile: sidPaths.debugLog(),
  };
}

// ───────────────────────────── 读取 ─────────────────────────────

/** 内存缓存 */
let appConfigCache: { config: AppConfig; mtime: number } | null = null;
let watcherStarted = false;
let lastBackupTime = 0;

/** 安全的 statSync */
function safeStatSync(path: string) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** 备份损坏的配置文件 */
function backupCorruptedFile(path: string): void {
  try {
    if (!existsSync(path)) return;
    const backupDir = getBackupDir();
    if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(path, join(backupDir, `app.json.corrupted.${timestamp}`));
  } catch {
    // 静默失败
  }
}

/**
 * 解析 app.json 文本。空文件 / 非对象（数组、null、数字）一律视为损坏并抛错——
 * 此前 `JSON.parse` 对它们的处理不一：空串抛错、`null` 被当成"无字段"静默回默认值。
 */
function parseAppConfigText(content: string): Record<string, unknown> {
  const parsed = JSON.parse(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SyntaxError("app.json 顶层不是对象");
  }
  return parsed as Record<string, unknown>;
}

/**
 * 从最近一份能解析的时间戳备份恢复（D8）。
 *
 * 冷进程读到损坏的 app.json 时，此前直接回默认值——而启动路径下一步就是
 * incrementStartupCount 把默认值写回去，`projects`（含各项目信任记录）与
 * `hasCompletedOnboarding` 永久丢失。Auth-Loss Guard 的 ground truth 是内存缓存，
 * 冷进程恰好没有，所以必须换一个 ground truth：磁盘上的备份。
 */
function recoverFromBackup(): AppConfig | null {
  try {
    const dir = getBackupDir();
    if (!existsSync(dir)) return null;
    const backups = readdirSync(dir)
      .filter((f) => f.startsWith("app.json.backup."))
      .sort()
      .reverse();
    for (const name of backups) {
      try {
        const parsed = parseAppConfigText(readFileSync(join(dir, name), "utf-8"));
        return mergeOwnedKeys(parsed);
      } catch {
        // 这份备份也坏了（旧版本可能备份过坏数据），试下一份
      }
    }
  } catch {
    // 备份目录不可读：当作无备份
  }
  return null;
}

/**
 * 读到损坏文件时的统一处理：保留损坏副本 → 尝试从备份恢复 → 实在没有才回默认值。
 * getAppConfig 与 saveAppConfig 两条路径共用，此前 saveAppConfig 那条连损坏副本都不留。
 */
function loadAfterCorruption(path: string): AppConfig {
  backupCorruptedFile(path);
  const recovered = recoverFromBackup();
  if (recovered) {
    console.error(`app.json 已损坏，已从最近一份备份恢复（损坏副本保存在 ${getBackupDir()}）`);
    return recovered;
  }
  return createDefaultAppConfig();
}

/** 从磁盘读取并合并默认值（内部） */
function readFromDisk(path: string): AppConfig {
  return mergeOwnedKeys(parseAppConfigText(readFileSync(path, "utf-8")));
}

function mergeOwnedKeys(parsed: Record<string, unknown>): AppConfig {
  // 同样只收清单内的键。saveAppConfig 以「读出的对象」为底做 {...config, 变更} 回写，
  // 不过滤的话，清单外的残留键会被每次启动计数 / hint 计数原样写回去，迁移白做。
  const owned: Record<string, unknown> = {};
  if (parsed && typeof parsed === "object") {
    for (const [key, value] of Object.entries(parsed)) {
      if (APP_CONFIG_OWNED_KEYS.has(key)) owned[key] = value;
    }
  }
  return { ...createDefaultAppConfig(), ...owned };
}

/**
 * 读取 AppConfig——唯一入口。
 * 启动后总是命中内存缓存（~0ms）。
 */
export function getAppConfig(): AppConfig {
  if (appConfigCache) {
    return appConfigCache.config;
  }

  const path = getAppConfigPath();
  let config: AppConfig;

  try {
    config = readFromDiskGuarded(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      config = createDefaultAppConfig();
    } else {
      // 文件损坏：保留损坏副本，优先从备份恢复（D8），不直接回默认值
      config = loadAfterCorruption(path);
    }
  }

  const stats = safeStatSync(path);
  appConfigCache = { config, mtime: stats?.mtimeMs ?? Date.now() };

  startAppConfigWatcher();
  return config;
}

/**
 * 后台文件监听——检测其他进程的写入。
 * 使用 fs.watchFile（轮询）而非 fs.watch：轮询在 NFS/CIFS 上更可靠，
 * 对于每秒最多读一次的配置文件开销可忽略。
 */
function startAppConfigWatcher(): void {
  if (watcherStarted) return;
  watcherStarted = true;

  const path = getAppConfigPath();
  watchFile(path, { interval: 1000, persistent: false }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    // 自己的写入（write-through 已更新缓存的 mtime）→ 跳过
    if (appConfigCache && curr.mtimeMs <= appConfigCache.mtime) return;

    try {
      const config = readFromDiskGuarded(path);
      appConfigCache = { config, mtime: curr.mtimeMs };
    } catch {
      // 读取失败（可能是部分写入），等下一次轮询
    }
  });
}

/** 停止文件监听（进程退出时调用） */
export function stopAppConfigWatcher(): void {
  if (!watcherStarted) return;
  unwatchFile(getAppConfigPath());
  watcherStarted = false;
}

// ───────────────────────────── 写入 ─────────────────────────────

/**
 * Auth-Loss Guard：从文件读到的配置缺少重要状态、但内存缓存有，
 * 说明文件可能被损坏（如被外部清空），拒绝写入以保护好数据。
 */
function wouldLoseImportantState(fresh: Partial<AppConfig>): boolean {
  const cached = appConfigCache?.config;
  if (!cached) return false;
  return losesStateComparedTo(cached, fresh);
}

/**
 * 截断成「恰好合法的 JSON」（如 `{}`、写到一半的对象）时 JSON.parse 成功，不会走损坏路径，
 * 缺的键被默认值静默填上（D8）。冷进程又没有内存缓存可比，所以拿最近一份有效备份当 ground truth：
 * 读到的内容比备份少了 onboarding / projects，就按损坏处理、从备份恢复。
 * 只在 fresh 本身缺这两项时才读备份，正常启动零额外 IO。
 */
function readFromDiskGuarded(path: string): AppConfig {
  const fresh = readFromDisk(path);
  const hasImportant =
    fresh.hasCompletedOnboarding === true ||
    (!!fresh.projects && Object.keys(fresh.projects).length > 0);
  if (hasImportant) return fresh;
  const backup = recoverFromBackup();
  if (backup && losesStateComparedTo(backup, fresh)) {
    const err = new SyntaxError("app.json 比最近备份缺少关键状态，疑似被截断") as Error & {
      code?: string;
    };
    err.code = "ETRUNCATED";
    throw err;
  }
  return fresh;
}

function losesStateComparedTo(cached: Partial<AppConfig>, fresh: Partial<AppConfig>): boolean {
  const lostOnboarding =
    cached.hasCompletedOnboarding === true && fresh.hasCompletedOnboarding !== true;

  const lostProjects =
    !!cached.projects &&
    Object.keys(cached.projects).length > 0 &&
    (!fresh.projects || Object.keys(fresh.projects).length === 0);

  return lostOnboarding || !!lostProjects;
}

/** 创建时间戳备份（保留最近 MAX_BACKUPS 个，最小间隔 MIN_BACKUP_INTERVAL_S 秒） */
function createTimestampBackup(sourcePath: string): void {
  const now = Date.now();
  if (now - lastBackupTime < MIN_BACKUP_INTERVAL_S * 1000) return;

  try {
    if (!existsSync(sourcePath)) return;
    // 只备份能解析的内容（D8）：此前在写入前无条件 copy，文件已损坏时备份的是
    // 0 字节文件，而它还会把仅存的好备份挤出 MAX_BACKUPS 窗口。
    try {
      parseAppConfigText(readFileSync(sourcePath, "utf-8"));
    } catch {
      return;
    }

    const backupDir = getBackupDir();
    if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(sourcePath, join(backupDir, `app.json.backup.${timestamp}`));
    lastBackupTime = now;

    // 清理旧备份
    const backups = readdirSync(backupDir)
      .filter((f) => f.startsWith("app.json.backup."))
      .sort()
      .reverse();
    for (const old of backups.slice(MAX_BACKUPS)) {
      unlinkSync(join(backupDir, old));
    }
  } catch {
    // 备份失败不影响主流程
  }
}

/**
 * 原子写：写同目录临时文件再 rename（D8）。
 *
 * writeFileSync 是 open(O_TRUNC) + write，中间态是 0 字节文件——多进程并发时另一个进程
 * 恰好读到它，就会走损坏路径。rename 在同一文件系统上是原子的，读方要么看到旧文件、
 * 要么看到新文件。临时文件名带 pid，防多进程互相覆盖对方的临时文件。
 */
export function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* 清理失败不掩盖原错误 */
    }
    throw err;
  }
}

/**
 * 保存 AppConfig。
 * updater 函数模式——基于最新磁盘状态做更新，避免覆盖其他进程的写入。
 */
export function saveAppConfig(updater: (current: AppConfig) => AppConfig): void {
  const path = getAppConfigPath();

  try {
    // 1. 重新读取当前配置（确保基于最新状态）
    let current: AppConfig;
    try {
      current = readFromDiskGuarded(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        current = appConfigCache?.config ?? createDefaultAppConfig();
      } else {
        // 磁盘文件损坏：内存缓存是好数据就以它为底；没有缓存（冷进程）走备份恢复（D8）
        current = appConfigCache?.config ?? loadAfterCorruption(path);
      }
    }

    // 2. Auth-Loss Guard
    if (wouldLoseImportantState(current)) {
      return;
    }

    // 3. 应用 updater
    const updated = updater(current);
    if (updated === current) return; // 无变更

    // 4. 时间戳备份
    createTimestampBackup(path);

    // 5. 写入文件（mode 0o600）
    const dir = getSidHome();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeAtomic(path, JSON.stringify(updated, null, 2));

    // 6. Write-through：立即更新内存缓存
    const stats = safeStatSync(path);
    appConfigCache = { config: updated, mtime: stats?.mtimeMs ?? Date.now() };
  } catch (err) {
    console.error(`AppConfig 写入失败: ${err}`);
  }
}

/** 重置内存缓存（仅供测试隔离使用） */
export function resetAppConfigCache(): void {
  appConfigCache = null;
  lastBackupTime = 0;
}

// ───────────────────────── 便捷读写 API ─────────────────────────

/** 获取项目级配置 */
export function getProjectConfig(projectPath?: string): ProjectConfig {
  const path = projectPath ?? process.cwd();
  const config = getAppConfig();
  return config.projects?.[path] ?? { allowedTools: [] };
}

/** 更新项目级配置 */
export function updateProjectConfig(
  projectPath: string,
  updater: (current: ProjectConfig) => ProjectConfig,
): void {
  saveAppConfig((config) => {
    const projects = { ...config.projects };
    const current = projects[projectPath] ?? { allowedTools: [] };
    projects[projectPath] = updater(current);
    return { ...config, projects };
  });
}

/** 递增启动次数，记录首次启动时间 */
export function incrementStartupCount(): void {
  saveAppConfig((config) => ({
    ...config,
    numStartups: (config.numStartups ?? 0) + 1,
    firstStartTime: config.firstStartTime ?? new Date().toISOString(),
  }));
}

/** 标记信任对话框已接受 */
export function markTrustDialogAccepted(projectPath: string): void {
  updateProjectConfig(projectPath, (current) => ({
    ...current,
    hasTrustDialogAccepted: true,
  }));
}

/** 检查项目是否已信任 */
export function isProjectTrusted(projectPath?: string): boolean {
  return getProjectConfig(projectPath).hasTrustDialogAccepted === true;
}

/**
 * M4：读取 CLAUDE.md 外部导入批准态。
 * 返回 undefined 表示尚未询问，true/false 表示已批准/已拒绝。
 */
export function getClaudeMdExternalImportsApproved(projectPath?: string): boolean | undefined {
  return getProjectConfig(projectPath).claudeMdExternalImportsApproved;
}

/** M4：持久化 CLAUDE.md 外部导入批准态（同时标记警告已展示）。 */
export function setClaudeMdExternalImportsApproved(projectPath: string, approved: boolean): void {
  updateProjectConfig(projectPath, (current) => ({
    ...current,
    claudeMdExternalImportsApproved: approved,
    claudeMdExternalImportsWarningShown: true,
  }));
}

// ───────────────────────── 提示渐进衰减 ─────────────────────────

/**
 * 获取某个 hint 的已显示次数（不存在记为 0）。
 * 用于「显示 N 次后不再打扰」的 onboarding 提示衰减。
 */
export function getHintShownCount(hintKey: string): number {
  return getAppConfig().hints?.[hintKey] ?? 0;
}

/** 判断某个 hint 是否仍应显示（已显示次数 < 上限）。 */
export function shouldShowHint(hintKey: string, maxShows: number): boolean {
  return getHintShownCount(hintKey) < maxShows;
}

/** 递增某个 hint 的已显示次数（write-through 持久化）。 */
export function markHintShown(hintKey: string): void {
  saveAppConfig((config) => {
    const hints = { ...config.hints };
    hints[hintKey] = (hints[hintKey] ?? 0) + 1;
    return { ...config, hints };
  });
}
