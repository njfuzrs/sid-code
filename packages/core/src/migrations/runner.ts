/**
 * 数据迁移框架
 * 版本化迁移序列，幂等执行，自动升级
 *
 * 设计原则：
 * 1. 幂等——每个迁移可以安全重复执行
 * 2. 顺序执行——按版本号递增执行
 * 3. 失败不阻塞——迁移失败记一条启动告警（见 warnings.ts），不阻止启动
 * 4. 水位线不越过第一个失败的迁移：v1 失败、v2–v5 成功 ⇒ 水位线停在 0，
 *    修好后下次启动 v1 重跑（B35 / D128）。前提是每个迁移都幂等，这在第 1 条里已要求。
 * 5. 团队默认的增量补全不挂在水位线上，每次启动都跑（见 backfill-team-defaults.ts）
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { sidPaths } from "../config/paths.ts";
import { getLogger } from "../debug/logger.ts";
import { recordMigrationWarning } from "./warnings.ts";
import { backfillNewTemplateKeys } from "./backfill-team-defaults.ts";
import { migrate as backfillTeamDefaults } from "./backfill-team-defaults.ts";
import { migrate as relocateLossyProjectKey } from "./relocate-lossy-project-key.ts";
import { migrate as rewriteLegacyReleaseHost } from "./rewrite-legacy-release-host.ts";
import { migrate as moveStrayAppConfigKeys } from "./move-stray-app-config-keys.ts";

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
  {
    version: 3,
    name: "rewrite-legacy-release-host",
    migrate: rewriteLegacyReleaseHost,
  },
  {
    version: 4,
    name: "move-stray-app-config-keys",
    migrate: moveStrayAppConfigKeys,
  },
  {
    // v4 跑过的机器不会重跑。alternateBuffer 的代码默认从 true 改回 false 之后，
    // 它退出了可删清单，v4 当时按「值等于旧默认」删掉的 true 无法分辨是灌入还是
    // 用户开过全屏。v5 再跑一次同一清理：补掉 v4 之后仍残留的、值等于默认的键，
    // 同时不再碰 alternateBuffer。函数幂等，没有残留时是空操作。
    version: 5,
    name: "recheck-dumped-default-keys",
    migrate: moveStrayAppConfigKeys,
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

/**
 * 写入迁移版本号
 *
 * P1-4：整个函数体外层包 try/catch——迁移本就幂等，写版本号失败时降级为
 * debug 日志，不阻止启动。设计原则第 3 条「失败不阻塞」必须覆盖记录迁移
 * 结果这一步，而非只包 m.migrate() 那一行。
 */
function setStoredMigrationVersion(version: number): void {
  try {
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
  } catch (err) {
    // 写盘失败（EACCES / 磁盘满 / 只读挂载）→ 降级 debug，不抛
    // 迁移是幂等的，下次启动会重跑，不影响正确性
    getLogger().debug("MIGRATION", `写入迁移版本号失败（不阻塞启动）: ${err}`);
  }
}

/**
 * 执行所有待执行的迁移
 * 在启动流程中调用，失败不阻塞启动
 */
export function runMigrations(): void {
  const currentVersion = getStoredMigrationVersion();

  if (currentVersion < CURRENT_VERSION) {
    // 水位线推进到「第一个失败版本之前」。旧实现推到「最后成功的版本」：v1 失败、
    // v2–v5 成功 ⇒ 写成 5，v1 永远不再跑，修好 settings.json 也补不回来（D128）。
    let watermark = currentVersion;
    let blocked = false;

    for (const m of migrations) {
      if (m.version <= currentVersion) continue;

      try {
        m.migrate();
        if (!blocked) watermark = m.version;
      } catch (err) {
        reportFailure(`迁移 ${m.name} (v${m.version})`, err);
        blocked = true;
        // 继续执行后续迁移（互相独立，且都幂等，下次随失败那条一起重跑无害）
      }
    }

    if (watermark > currentVersion) setStoredMigrationVersion(watermark);
  }

  // 增量补全只在 v1 已完成后跑：v1 没成功时它下次会全量重跑，这里再记一份基线是多余的，
  // 还会让同一个损坏文件报两条告警。v1 本轮刚成功时已记下基线，这里哈希相同直接返回。
  if (getStoredMigrationVersion() < 1) return;
  try {
    backfillNewTemplateKeys();
  } catch (err) {
    reportFailure("团队默认配置补全", err);
  }
}

/**
 * 迁移失败：debug 日志 + 一条启动告警。
 * 只记 debug 等于没记——runMigrations 在 initLogger 之前调用，兜底 logger 吞掉 debug 级
 * （logger.ts 只有 ERROR/WARN 走 stderr）。也不直写 stderr：TUI 接管终端后裸输出会留游离行。
 * 告警由 loadConfig 并进启动诊断，横幅与 --print 都看得见（B35 / D128）。
 */
function reportFailure(what: string, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err);
  getLogger().debug("MIGRATION", `${what} 失败（不阻塞）: ${reason}`);
  recordMigrationWarning(
    "migrations",
    `${what} 失败，已跳过、未改动配置：${reason}\n修好后下次启动会自动重试。`,
  );
}

/** 获取当前迁移版本（供调试使用） */
export function getMigrationVersion(): number {
  return getStoredMigrationVersion();
}

/** 获取总迁移数（供调试使用） */
export function getTotalMigrations(): number {
  return CURRENT_VERSION;
}
