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
} from "fs";
import { join } from "path";
import { getSidHome } from "./paths.ts";

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

/** 默认 AppConfig */
export function createDefaultAppConfig(): AppConfig {
  return {
    showLineNumbers: true,
    numStartups: 0,
    debug: false,
    debugLevel: "INFO",
    debugLogFile: "~/.sid-code/debug.log",
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

/** 从磁盘读取并合并默认值（内部） */
function readFromDisk(path: string): AppConfig {
  const content = readFileSync(path, "utf-8");
  const parsed = JSON.parse(content);
  return { ...createDefaultAppConfig(), ...parsed };
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
    config = readFromDisk(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      config = createDefaultAppConfig();
    } else {
      // 文件损坏：备份损坏文件，返回默认值
      backupCorruptedFile(path);
      config = createDefaultAppConfig();
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
      const config = readFromDisk(path);
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
 * 保存 AppConfig。
 * updater 函数模式——基于最新磁盘状态做更新，避免覆盖其他进程的写入。
 */
export function saveAppConfig(updater: (current: AppConfig) => AppConfig): void {
  const path = getAppConfigPath();

  try {
    // 1. 重新读取当前配置（确保基于最新状态）
    let current: AppConfig;
    try {
      current = readFromDisk(path);
    } catch {
      current = appConfigCache?.config ?? createDefaultAppConfig();
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
    writeFileSync(path, JSON.stringify(updated, null, 2), { mode: 0o600 });

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
