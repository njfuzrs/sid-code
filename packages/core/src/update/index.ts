/**
 * 自动更新 — 编排入口
 *
 * `startAutoUpdateCheck()` 是同步函数，内部异步执行完整检查流程：
 * 1. 消费 pendingNotice（下次启动提示用）
 * 2. 检查 settings.autoUpdate 模式
 * 3. 节流判定（24h）
 * 4. fetch latest.txt
 * 5. 版本号比较（含 prerelease 检测）
 * 6. 根据模式执行（notify / auto）
 *
 * ⚠️ 必须用 `getRawVersion()`（裸 x.y.z），不是 `getVersion()`（带前后缀）
 */

import { getRawVersion } from "@sid-code/shared/version.ts";
import { getSettings } from "../config/settings/index.ts";
import { getLogger } from "../debug/logger.ts";
import { resolveAutoUpdateMode } from "./config.ts";
import { readUpdateState, patchUpdateState } from "./state.ts";
import { shouldCheck } from "./throttle.ts";
import { isValidVersion, compareVersions, isPrereleaseVersion } from "./versions.ts";
import { fetchLatestVersion } from "./checker.ts";
import { acquireLock } from "./lock.ts";
import { spawnBackgroundInstall } from "./installer.ts";
import { writePendingNotice } from "./notify.ts";

const log = () => getLogger();

const FAILURE_NOTIFICATION_THRESHOLD = 3;

export interface AutoUpdateDependencies {
  getCurrentVersion?: () => string;
  getSettings?: () => ReturnType<typeof getSettings>;
  fetchLatestVersion?: () => Promise<string | null>;
  readState?: typeof readUpdateState;
  patchState?: typeof patchUpdateState;
  shouldCheck?: typeof shouldCheck;
  acquireLock?: typeof acquireLock;
  spawnInstall?: typeof spawnBackgroundInstall;
  writeNotice?: typeof writePendingNotice;
}

const defaultDependencies: Required<AutoUpdateDependencies> = {
  getCurrentVersion: getRawVersion,
  getSettings: () => getSettings(),
  fetchLatestVersion,
  readState: readUpdateState,
  patchState: patchUpdateState,
  shouldCheck,
  acquireLock,
  spawnInstall: spawnBackgroundInstall,
  writeNotice: writePendingNotice,
};

/**
 * 启动自动更新检查（fire-and-forget，不阻塞启动）
 */
export function startAutoUpdateCheck(): void {
  void runAutoUpdateCheck();
}

/**
 * 执行一次自动更新检查。公开该边界供测试验证编排逻辑，生产入口仍是 fire-and-forget。
 */
export async function runAutoUpdateCheck(dependencies: AutoUpdateDependencies = {}): Promise<void> {
  const deps = { ...defaultDependencies, ...dependencies };
  try {
    await doCheck(deps);
  } catch (err) {
    log().error("AUTO_UPDATE", `检查流程异常: ${err}`);
  }
}

async function doCheck(deps: Required<AutoUpdateDependencies>): Promise<void> {
  // 1. 读取当前版本
  const currentVersion = deps.getCurrentVersion();

  // 2. 检测 prerelease / dev 版本
  if (isPrereleaseVersion(currentVersion)) {
    log().info("AUTO_UPDATE", `跳过 prerelease/dev 版本: ${currentVersion}`);
    return;
  }

  if (!isValidVersion(currentVersion)) {
    log().warn("AUTO_UPDATE", `当前版本号格式非法: ${currentVersion}`);
    return;
  }

  // 3. 读取 settings 和状态
  const settings = deps.getSettings().settings;
  const mode = resolveAutoUpdateMode(settings.autoUpdate);
  if (mode === "off") {
    log().info("AUTO_UPDATE", "自动更新已关闭（settings.autoUpdate=off）");
    return;
  }

  const state = deps.readState();

  // 4. 节流判定
  if (!deps.shouldCheck(state)) {
    log().info("AUTO_UPDATE", "距上次检查不足 24h，跳过");
    return;
  }

  // 5. 更新 lastCheckAt（即使后续失败也算检查过）
  deps.patchState({ lastCheckAt: new Date().toISOString() });

  // 6. 拉取 latest.txt
  const latestVersion = await deps.fetchLatestVersion();
  if (!latestVersion) {
    // 网络失败或格式非法，静默退出
    const nextFailures = state.consecutiveFailures + 1;
    deps.patchState({ consecutiveFailures: nextFailures });
    if (nextFailures >= FAILURE_NOTIFICATION_THRESHOLD) {
      log().warn("AUTO_UPDATE", `连续失败 ${nextFailures} 次，写入 pendingNotice(failed)`);
      deps.writeNotice({
        type: "failed",
        fromVersion: currentVersion,
        createdAt: new Date().toISOString(),
      });
      // 归零，避免反复打扰
      deps.patchState({ consecutiveFailures: 0 });
    }
    return;
  }

  // 7. 版本号比较
  const cmp = compareVersions(latestVersion, currentVersion);
  if (cmp <= 0) {
    // 线上版本 <= 当前版本（beta 用户或已是最新），不更新
    log().info(
      "AUTO_UPDATE",
      `线上 v${latestVersion} ${cmp === 0 ? "=" : "<"} 当前 v${currentVersion}，不更新`,
    );
    // 成功路径：重置失败计数
    deps.patchState({ consecutiveFailures: 0 });
    return;
  }

  // 8. 有新版本
  log().info("AUTO_UPDATE", `发现新版本 v${latestVersion}（当前 v${currentVersion}）`);

  if (mode === "notify") {
    // notify 模式：只提示，不下载
    deps.writeNotice({
      type: "available",
      fromVersion: currentVersion,
      toVersion: latestVersion,
      createdAt: new Date().toISOString(),
    });
    deps.patchState({ consecutiveFailures: 0 });
    return;
  }

  // 9. auto 模式：抢锁 + spawn 子进程
  const lock = deps.acquireLock();
  if (!lock) {
    log().info("AUTO_UPDATE", "锁已被其他实例持有，跳过");
    return;
  }

  try {
    deps.spawnInstall(latestVersion, currentVersion, lock.lockDir);
    deps.patchState({ consecutiveFailures: 0 });
  } catch (err) {
    log().error("AUTO_UPDATE", `spawn 子进程失败: ${err}`);
    lock.release(); // spawn 失败时主动释放锁（成功时子进程负责释放）
    const nextFailures = state.consecutiveFailures + 1;
    deps.patchState({ consecutiveFailures: nextFailures });
  }
}
