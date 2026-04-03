/**
 * 初始化序列（memoize 保护）
 * 收敛分散的初始化逻辑，严格保序依赖链，最大化并行
 *
 * 依赖链：
 *   loadConfig()                    ← 必须最先
 *     ├─→ setupGracefulShutdown()   ← 无依赖
 *     ├─→ prefetchGitStatus()       ← 异步 fire-and-forget
 *     └─→ initDebugLogger()         ← 依赖 config
 */

import { memoize } from "../utils/memoize.ts";
import { profileCheckpoint } from "../utils/startup-profiler.ts";

/**
 * 设置优雅退出处理
 * 确保进程退出时清理资源（stdin rawMode 恢复等）
 */
function setupGracefulShutdown(): void {
  // 确保异常退出时恢复终端状态
  const cleanup = () => {
    try {
      if (process.stdin.isTTY && process.stdin.isRaw) {
        process.stdin.setRawMode(false);
      }
    } catch {
      // 静默失败
    }
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
  process.on("uncaughtException", (err) => {
    cleanup();
    console.error("未捕获的异常:", err);
    process.exit(1);
  });
}

/**
 * memoize 保护的初始化函数
 * 无论被调用多少次，只执行一次
 */
export const init = memoize(async (): Promise<void> => {
  profileCheckpoint("init_sequence_start");

  // ① 优雅退出处理（无依赖，立即执行）
  setupGracefulShutdown();

  profileCheckpoint("init_sequence_end");
});
