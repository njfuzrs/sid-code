// src/utils/graceful-shutdown.ts
// 优雅关闭——多阶段 + 硬超时 + failsafe
//
// 对应 spec 17 §3.4。
// 设计原则:丢失遥测可接受,进程挂起不可接受。
//   1. 终端模式同步清理(最高优先级,即使后续失败也能恢复终端)
//   2. 运行注册的清理函数(会话持久化、MCP 关闭等)
//   3. 刷新遥测缓冲区(500ms 硬超时)
//   4. Failsafe 定时器(5s 强制退出,防止关闭流程本身挂起)

import { shutdownTelemetry } from "../telemetry/index.ts";
import { shutdownBackends } from "../analytics/sink.ts";

/** 遥测刷新硬超时 */
const TELEMETRY_FLUSH_TIMEOUT_MS = 500;
/** 整体 failsafe 超时 */
const FAILSAFE_TIMEOUT_MS = 5000;

type CleanupFn = () => void | Promise<void>;
const cleanupFns: CleanupFn[] = [];

/** 是否已开始关闭(防止重入) */
let shuttingDown = false;

/** 注册清理函数。关闭时按注册顺序执行。 */
export function registerCleanup(fn: CleanupFn): void {
  cleanupFns.push(fn);
}

/** 清空已注册清理函数(仅测试用) */
export function __resetCleanupForTest(): void {
  cleanupFns.length = 0;
  shuttingDown = false;
}

/** 已注册清理函数数量(测试用) */
export function getCleanupCount(): number {
  return cleanupFns.length;
}

/**
 * 执行关闭流程但不退出进程(供测试与"软关闭"复用)。
 * 返回 Promise,所有阶段完成(或超时)后 resolve。
 */
export async function runShutdownSequence(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  // 1. 同步清理终端模式(最高优先级)
  cleanupTerminalSync();

  // 2. 运行注册的清理函数
  for (const fn of cleanupFns) {
    try {
      await fn();
    } catch {
      // 清理失败不阻塞关闭
    }
  }

  // 3. 刷新遥测缓冲区(硬超时)
  try {
    await Promise.race([
      Promise.allSettled([shutdownTelemetry(), shutdownBackends()]),
      sleep(TELEMETRY_FLUSH_TIMEOUT_MS),
    ]);
  } catch {
    // 遥测刷新失败可接受
  }
}

/**
 * 优雅关闭并退出进程。
 * 永不返回(进程退出)。
 */
export async function gracefulShutdown(exitCode: number): Promise<never> {
  // 0. Failsafe 定时器——防止关闭流程本身挂起
  const failsafe = setTimeout(() => {
    process.exit(exitCode);
  }, FAILSAFE_TIMEOUT_MS);
  failsafe.unref();

  try {
    await runShutdownSequence();
  } finally {
    clearTimeout(failsafe);
    process.exit(exitCode);
  }
  // 不可达,仅为满足 never 返回类型
  throw new Error("unreachable");
}

/** 同步恢复终端状态(光标、raw mode) */
export function cleanupTerminalSync(): void {
  try {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode?.(false);
    }
  } catch {
    // ignore
  }
  try {
    // 显示光标
    if (process.stdout.isTTY) {
      process.stdout.write("\x1B[?25h");
    }
  } catch {
    // ignore
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
