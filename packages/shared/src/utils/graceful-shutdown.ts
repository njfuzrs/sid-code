// src/utils/graceful-shutdown.ts
// 优雅关闭——多阶段 + 硬超时 + failsafe
//
// 对应 spec 17 §3.4。
// 设计原则:丢失遥测可接受,进程挂起不可接受。
//   1. 终端模式同步清理(最高优先级,即使后续失败也能恢复终端)
//   2. 运行注册的清理函数(会话持久化、MCP 关闭等)
//   3. 停掉 Feature Flag 远程刷新定时器(避免关闭期间再外发)
//   4. 刷新遥测缓冲区(500ms 硬超时)
//   5. Failsafe 定时器(5s 强制退出,防止关闭流程本身挂起)

/** 遥测刷新硬超时 */
const TELEMETRY_FLUSH_TIMEOUT_MS = 500;
/** 整体 failsafe 超时 */
const FAILSAFE_TIMEOUT_MS = 5000;

type CleanupFn = () => void | Promise<void>;
const cleanupFns: CleanupFn[] = [];

/**
 * 关闭钩子的阶段。**顺序是语义敏感的，不要合并这两个阶段。**
 *
 * - `pre-flush`：停掉会「继续对外发起动作」的东西（定时器、远程刷新）。
 *   必须早于 flush —— 定时器一旦在关闭期间触发就会发起远程 fetch 并回写磁盘缓存，
 *   关闭中没有任何理由再拉一次远程配置。逐个 await，按注册顺序。
 * - `flush`：把缓冲区刷出去（遥测、analytics 后端）。全部并发跑，
 *   整组共用一个 500ms 硬超时 —— 设计原则是「丢失遥测可接受，进程挂起不可接受」。
 */
export type ShutdownPhase = "pre-flush" | "flush";

interface ShutdownHook {
  name: string;
  phase: ShutdownPhase;
  fn: () => void | Promise<void>;
}

/**
 * 已注册的关闭钩子。
 *
 * P2-2 分包：本文件属 shared（叶子工具层），**不能**直接 import telemetry / analytics
 * （那是 core，低层 import 高层就是环）。原先这里硬编码了「要关 telemetry、
 * 关 analytics backends、关 feature flags」，是典型的「低层知道高层」反模式。
 *
 * 改成注册制后各子系统自治：谁需要优雅关闭，谁在自己 init 时注册。
 * 收益不只是过门禁 —— 以前新增一个需要关闭的子系统必须回来改这个低层文件。
 */
const shutdownHooks: ShutdownHook[] = [];

/** 是否已开始关闭(防止重入) */
let shuttingDown = false;

/** 注册清理函数。关闭时按注册顺序执行。 */
export function registerCleanup(fn: CleanupFn): void {
  cleanupFns.push(fn);
}

/**
 * 注册一个关闭钩子（由各子系统在自己 init 时调用）。
 *
 * @param name  唯一标识。**按 name 去重**：同名重复注册只保留最后一个。
 *   这让 `initXxx()` 可以被多次调用（运行时 toggle、测试反复 init）而不堆积重复钩子。
 *   去重状态就存在本注册表里，所以 `__resetCleanupForTest()` 清空注册表时
 *   去重记忆也一起清掉 —— 子系统重新 init 就能重新注册，测试隔离才成立。
 * @param phase 见 {@link ShutdownPhase}。选错阶段会让「关闭中还在外发请求」重现。
 */
export function registerShutdownHook(
  name: string,
  phase: ShutdownPhase,
  fn: () => void | Promise<void>,
): void {
  const existing = shutdownHooks.findIndex((h) => h.name === name);
  if (existing >= 0) {
    shutdownHooks[existing] = { name, phase, fn };
    return;
  }
  shutdownHooks.push({ name, phase, fn });
}

/** 清空已注册清理函数与关闭钩子(仅测试用) */
export function __resetCleanupForTest(): void {
  cleanupFns.length = 0;
  shutdownHooks.length = 0;
  shuttingDown = false;
}

/** 已注册清理函数数量(测试用) */
export function getCleanupCount(): number {
  return cleanupFns.length;
}

/** 已注册关闭钩子名单(测试/调试用) */
export function getShutdownHookNames(): string[] {
  return shutdownHooks.map((h) => h.name);
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

  // 3. pre-flush 钩子：停掉会继续对外发起动作的东西（如 Feature Flag 远程刷新定时器）。
  //
  // 必须早于 flush：定时器一旦在关闭期间触发就会发起远程 fetch 并回写磁盘缓存,
  // 关闭期间没有任何理由再拉一次远程配置。
  // 逐个 await 且各自 try/catch —— 子系统未初始化或抛错都不阻塞关闭。
  for (const hook of shutdownHooks) {
    if (hook.phase !== "pre-flush") continue;
    try {
      await hook.fn();
    } catch {
      // 单个钩子失败不阻塞整体关闭
    }
  }

  // 4. flush 钩子：刷新各缓冲区（遥测 / analytics 后端）。
  //
  // 全部并发跑,**整组共用一个硬超时** —— 与改造前 `Promise.race([allSettled([a,b]), sleep])`
  // 的语义一致（不是每个钩子各给 500ms）。丢失遥测可接受,进程挂起不可接受。
  const flushHooks = shutdownHooks.filter((h) => h.phase === "flush");
  if (flushHooks.length > 0) {
    try {
      await Promise.race([
        Promise.allSettled(flushHooks.map((h) => Promise.resolve().then(h.fn))),
        sleep(TELEMETRY_FLUSH_TIMEOUT_MS),
      ]);
    } catch {
      // 遥测刷新失败可接受
    }
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
