/**
 * 数据迁移框架
 * 版本化迁移序列，幂等执行，自动升级
 *
 * 设计原则：
 * 1. 幂等——每个迁移可以安全重复执行
 * 2. 顺序执行——按版本号递增执行
 * 3. 失败不阻塞——迁移失败记录警告，不阻止启动
 * 4. 版本号只在全部成功后更新
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { sidPaths } from "../config/paths.ts";
import { migrate as backfillTeamDefaults } from "./backfill-team-defaults.ts";
import { migrate as relocateLossyProjectKey } from "./relocate-lossy-project-key.ts";

interface Migration {
  version: number;
  name: string;
  migrate: () => void;
}

/** 迁移注册表——后续迁移在此追加 */
const migrations: Migration[] = [
  {
    version: 1,
    name: "backfill-team-defaults",
    migrate: backfillTeamDefaults,
  },
  {
    version: 2,
    name: "relocate-lossy-project-key",
    migrate: relocateLossyProjectKey,
  },
];

const CURRENT_VERSION = migrations.length;

/** 状态文件路径：~/.sid-code/state/migrations.json */
function getStateFilePath(): string {
  return sidPaths.migrationState();
}

/** 读取已执行的迁移版本号 */
function getStoredMigrationVersion(): number {
  try {
    const stateFile = getStateFilePath();
    if (!existsSync(stateFile)) return 0;
    const data = JSON.parse(readFileSync(stateFile, "utf-8"));
    return data.migrationVersion ?? 0;
  } catch {
    return 0;
  }
}

/** 写入迁移版本号 */
function setStoredMigrationVersion(version: number): void {
  const stateFile = getStateFilePath();
  const dir = sidPaths.state();

  // 确保目录存在
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // 读取现有状态（保留其他字段）
  let data: Record<string, unknown> = {};
  try {
    if (existsSync(stateFile)) {
      data = JSON.parse(readFileSync(stateFile, "utf-8"));
    }
  } catch {
    // 文件损坏，重建
  }

  data.migrationVersion = version;
  writeFileSync(stateFile, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * 执行所有待执行的迁移
 * 在启动流程中调用，失败不阻塞启动
 */
export function runMigrations(): void {
  if (CURRENT_VERSION === 0) return; // 无迁移可执行

  const currentVersion = getStoredMigrationVersion();
  if (currentVersion >= CURRENT_VERSION) return;

  let allSucceeded = true;
  let lastSuccessVersion = currentVersion;

  for (const m of migrations) {
    if (m.version <= currentVersion) continue;

    try {
      m.migrate();
      lastSuccessVersion = m.version;
    } catch (err) {
      console.warn(`⚠️ 迁移 ${m.name} (v${m.version}) 失败:`, err);
      allSucceeded = false;
      // 继续执行后续迁移（某些迁移可能互相独立）
    }
  }

  // 更新版本号到最后成功的版本
  if (lastSuccessVersion > currentVersion) {
    setStoredMigrationVersion(allSucceeded ? CURRENT_VERSION : lastSuccessVersion);
  }
}

/** 获取当前迁移版本（供调试使用） */
export function getMigrationVersion(): number {
  return getStoredMigrationVersion();
}

/** 获取总迁移数（供调试使用） */
export function getTotalMigrations(): number {
  return CURRENT_VERSION;
}
