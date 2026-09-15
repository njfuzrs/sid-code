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

/**
 * 启动自动更新检查（fire-and-forget，不阻塞启动）
 *
 * 该函数同步返回，内部所有操作异步执行。任何异常都被捕获并记录到日志，
 * 不会上抛到主流程。
 */
export function startAutoUpdateCheck(): void {
  // 整个流程包在 async IIFE 里，确保任何异常都被捕获
  void (async () => {
    try {
      await doCheck();
    } catch (err) {
      log().error("AUTO_UPDATE", `检查流程异常: ${err}`);
    }
  })();
}

async function doCheck(): Promise<void> {
  // 1. 读取当前版本
  const currentVersion = getRawVersion();

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
  const settings = getSettings().merged;
  const mode = resolveAutoUpdateMode(settings.autoUpdate);
  if (mode === "off") {
    log().info("AUTO_UPDATE", "自动更新已关闭（settings.autoUpdate=off）");
    return;
  }

  const state = readUpdateState();

  // 4. 节流判定
  if (!shouldCheck(state)) {
    log().info("AUTO_UPDATE", "距上次检查不足 24h，跳过");
    return;
  }

  // 5. 更新 lastCheckAt（即使后续失败也算检查过）
  patchUpdateState({ lastCheckAt: new Date().toISOString() });

  // 6. 拉取 latest.txt
  const latestVersion = await fetchLatestVersion();
  if (!latestVersion) {
    // 网络失败或格式非法，静默退出
    const nextFailures = state.consecutiveFailures + 1;
    patchUpdateState({ consecutiveFailures: nextFailures });
    if (nextFailures >= FAILURE_NOTIFICATION_THRESHOLD) {
      log().warn("AUTO_UPDATE", `连续失败 ${nextFailures} 次，写入 pendingNotice(failed)`);
      writePendingNotice({
        type: "failed",
        fromVersion: currentVersion,
        createdAt: new Date().toISOString(),
      });
      // 归零，避免反复打扰
      patchUpdateState({ consecutiveFailures: 0 });
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
    patchUpdateState({ consecutiveFailures: 0 });
    return;
  }

  // 8. 有新版本
  log().info("AUTO_UPDATE", `发现新版本 v${latestVersion}（当前 v${currentVersion}）`);

  if (mode === "notify") {
    // notify 模式：只提示，不下载
    writePendingNotice({
      type: "available",
      fromVersion: currentVersion,
      toVersion: latestVersion,
      createdAt: new Date().toISOString(),
    });
    patchUpdateState({ consecutiveFailures: 0 });
    return;
  }

  // 9. auto 模式：抢锁 + spawn 子进程
  const lock = acquireLock();
  if (!lock) {
    log().info("AUTO_UPDATE", "锁已被其他实例持有，跳过");
    return;
  }

  try {
    spawnBackgroundInstall(latestVersion, currentVersion, lock.lockDir);
    patchUpdateState({ consecutiveFailures: 0 });
  } catch (err) {
    log().error("AUTO_UPDATE", `spawn 子进程失败: ${err}`);
    lock.release(); // spawn 失败时主动释放锁（成功时子进程负责释放）
    const nextFailures = state.consecutiveFailures + 1;
    patchUpdateState({ consecutiveFailures: nextFailures });
  }
}
