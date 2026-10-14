// src/task/prevent-sleep.ts
// 任务保活：干活期间阻止系统空闲休眠（消除"休眠导致任务静默中断"的触发源）
//
// ── 为什么在 task/ 而不在 utils/（P2-2 分包，修法⑥）──────────────────────
// 它依赖 debug/logger.ts（core），而 utils/ 要成为 shared 包（纯叶子工具层，
// 不许依赖业务层）——留在 utils 就是 shared → core 越界。
// 判据不是"看起来像不像工具"，而是越界数：它是「任务执行期的保活能力」，
// 不是通用工具，归 core 更正确且改动量为零（纯 git mv）。
// 注意第二层 sleep-detect.ts 零导入，是真叶子，仍留在 utils/（将来的 shared）。
//
// ── 为什么需要（2026-08-01 真实事故）─────────────────────────────────────
// 轨迹 20260801-175042-699f69f8：任务执行到一半自己停了，TUI 上没有任何报错。
// 排查结论是 macOS 空闲休眠——进程被整体冻结，挂钟继续走，醒来瞬间所有积压定时器
// 一起补 fire。证据（时区已对齐：轨迹是 UTC，pmset 是 UTC+8）：
//
//   轨迹冻结窗口(UTC)          折算本地      pmset 记录
//   09:55:13 → 10:10:52(939s)  17:55→18:10  17:55:25 Sleep → 18:10:52 DarkWake
//   10:12:41 → 10:28:21(940s)  18:12→18:28  18:12:54 Sleep → 18:28:21 DarkWake
//   10:47:43 → 11:03:19(946s)  18:47→19:03  18:47:52 Sleep → 19:03:19 DarkWake
//
// 三次 WatchdogKill 与三次 DarkWake 落在同一秒；TimerDrift 实测 actual_ms=926241
// （预期 5000ms）。当晚 10 次休眠**全部是 Idle Sleep，零次 clamshell/lid**——
// 也就是说 `caffeinate -i` 本可以 100% 避免这次事故。
//
// ── 三层纵深里的第一层 ─────────────────────────────────────────────────
// 本模块是「让休眠不发生」。挡不住的情况（合盖、手动休眠、Linux/Windows 无对应
// 实现、caffeinate 不可用）由另两层兜底：
//   - 第二层 sleep-detect.ts：休眠真发生了，挂钟跳跃不计入重试预算/会话额度；
//   - 第三层 query/loop.ts 收尾分支：任何中断都必须给用户一句话，绝不静默。
// 单靠任何一层都有洞，所以三层都要在。
//
// ── 平台支持 ───────────────────────────────────────────────────────────
// macOS：caffeinate -i（系统自带，无需权限）。
// 其他平台：no-op。Linux 的 systemd-inhibit 需要 dbus/logind 且服务器场景通常
// 本就不休眠，Windows 的 SetThreadExecutionState 需要 FFI 调 Win32 API——两者
// 都是"引入依赖换取小众收益"，留作后续按需扩展（保持 no-op 不影响正确性，因为
// 第二/三层纵深与平台无关）。

import { registerCleanup } from "@sid-code/shared/utils/graceful-shutdown.ts";
import { getLogger } from "../debug/logger.ts";

/**
 * ── 为什么是 `-w <pid>` 而不是 `-t 300` + 定期重启（2026-10-14 事故）────────
 * 旧实现每 4 分钟「先杀旧 caffeinate、再起新的」，以 -t 300 自过期防孤儿。
 * 会话 20261014-110202-8c0ffb30：`pmset -g log` 当天 7 次
 * `caffeinate ClientDied … [System: No Assertions]` 后**整 31 秒**就 Idle Sleep，
 * 其中一次（12:59:50 → 13:00:21 睡 184s）让三个 explore 子代理全部失败。
 * 机理：用户空闲早已超过 `pmset sleep 1`，空闲计时器早就到期、只是被 assertion
 * 挡着；assertion 计数一旦归零 powerd 立即启动休眠流程，新 caffeinate 就算同一秒
 * 起来也挡不回来（12:55:50 那次新进程同秒起来，系统仍睡了 15s）。
 * 所以判据是「assertion 计数任何时刻都不为零」——只要还有「重启」这个动作就有窗口，
 * 缩短间隔 / 先起后杀的重叠方案都仍依赖会漂移的定时器（TimerDrift 实测 11.7s）。
 *
 * `caffeinate -w <pid>`：被等待的进程退出（含 SIGKILL）时 assertion 自动释放，
 * 原生解决了 -t 想解决的孤儿问题，于是重启机制本身就不需要了。
 */

/** 意外退出后的重拉上限：窗口内最多重拉次数，超过就放弃（防死循环）。 */
export const RESPAWN_WINDOW_MS = 60 * 1000;
export const RESPAWN_MAX_IN_WINDOW = 3;

type CaffeinateProc = {
  kill: (sig?: number | NodeJS.Signals) => void;
  exited: Promise<unknown>;
  unref?: () => void;
};
type Spawner = (argv: string[]) => CaffeinateProc;

const defaultSpawner: Spawner = (argv) =>
  Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
let spawner: Spawner = defaultSpawner;
/** 测试注入点：未注入时 isSupported() 仍按真实平台判定。 */
let forceSupportedForTest = false;
/** 最近的意外重拉时间戳（滑动窗口计数用）。 */
let respawnTimes: number[] = [];

/** 构造 caffeinate 参数（导出给测试钉住 argv 形态）。 */
export function buildCaffeinateArgv(pid: number = process.pid): string[] {
  // -i：只阻止 idle sleep（合盖仍会睡，-s/-d 越权，见 spawnCaffeinate 注释）。
  // -w：随本进程退出自动释放；刻意**不带 -t**，否则又回到"到期即零 assertion"。
  return ["caffeinate", "-i", "-w", String(pid)];
}

let caffeinateProc: CaffeinateProc | null = null;
/**
 * 引用计数：允许多处并发工作（主循环 + 后台任务 + 子 agent）共享同一个 assertion，
 * 最后一个结束才真正放开休眠。用计数而非布尔，避免"A 还在跑，B 结束时把 A 的
 * 保活也一起关掉"。
 */
let refCount = 0;
let cleanupRegistered = false;

/** 仅 macOS 生效；其他平台全部 no-op。 */
function isSupported(): boolean {
  return forceSupportedForTest || process.platform === "darwin";
}

/**
 * 开始阻止空闲休眠（引用计数 +1）。
 * 幂等：重复调用只增加计数，不会起多个 caffeinate 进程。
 */
export function startPreventSleep(): void {
  refCount += 1;
  if (refCount !== 1) return; // 已有人在保活，复用同一个 assertion
  spawnCaffeinate();
}

/**
 * 结束阻止空闲休眠（引用计数 -1，减到 0 才真正放开）。
 * 计数不会被减成负数——防止"多调一次 stop"把后续 start 的语义搞坏。
 */
export function stopPreventSleep(): void {
  if (refCount > 0) refCount -= 1;
  if (refCount > 0) return;
  killCaffeinate();
}

/**
 * 无条件放开（退出清理专用）：不管计数多少一律收干净。
 * 进程退出时"还有人在保活"是常态（正常退出也可能 refCount>0），此处必须无条件。
 */
export function forceStopPreventSleep(): void {
  refCount = 0;
  killCaffeinate();
}

/** 当前引用计数（测试与 /doctor 自检用） */
export function getPreventSleepRefCount(): number {
  return refCount;
}

/** 当前是否确实持有 caffeinate 进程（测试与 /doctor 自检用） */
export function isPreventSleepActive(): boolean {
  return caffeinateProc !== null;
}

/** 重置全部内部状态（仅测试用，避免用例间互相污染） */
export function __resetPreventSleepForTest(): void {
  refCount = 0;
  killCaffeinate();
  cleanupRegistered = false;
  spawner = defaultSpawner;
  forceSupportedForTest = false;
  respawnTimes = [];
}

/** 测试注入假 spawner（同时强制视为受支持平台，Linux CI 上也能验 argv）。 */
export function __setCaffeinateSpawnerForTest(fn: Spawner): void {
  spawner = fn;
  forceSupportedForTest = true;
}

/**
 * caffeinate 意外退出（被外部杀 / 崩溃）且仍有人在保活 → 立即重拉。
 * 滑动窗口限次：caffeinate 若持续起不来（例如被 MDM 策略杀），无限重拉就是死循环。
 */
function onUnexpectedExit(): void {
  if (refCount <= 0) return;
  const now = Date.now();
  respawnTimes = respawnTimes.filter((t) => now - t < RESPAWN_WINDOW_MS);
  if (respawnTimes.length >= RESPAWN_MAX_IN_WINDOW) {
    getLogger().warn?.(
      "PREVENT_SLEEP",
      `caffeinate ${RESPAWN_WINDOW_MS / 1000}s 内意外退出超过 ${RESPAWN_MAX_IN_WINDOW} 次，放弃保活（休眠检测层仍兜底）`,
    );
    return;
  }
  respawnTimes.push(now);
  spawnCaffeinate();
}

function spawnCaffeinate(): void {
  if (!isSupported() || caffeinateProc !== null) return;

  // 首次真正启动时注册退出清理（避免非 macOS 平台白注册一个空钩子）。
  //
  // 为什么同时挂 process 级钩子而不只依赖 registerCleanup：registerCleanup 只在
  // 走 gracefulShutdown 的路径上执行，而进程还有"直接 process.exit / 未捕获异常 /
  // 测试进程跑完自然退出"等多条不经过它的出口。caffeinate 是**外部进程**，漏杀
  // 就会把用户的 Mac 一直钉醒——这类资源必须挂到最兜底的出口上。
  // （-w 的随主进程释放是最后一道保险，但不能拿它当正常回收手段。）
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    registerCleanup(() => forceStopPreventSleep());
    process.once("exit", () => forceStopPreventSleep());
  }

  try {
    // -i：只阻止 **idle sleep**，显示器仍可休眠、合盖仍会睡。
    //     刻意不用 -s（阻止一切系统休眠）——那会连合盖都不让睡，是对用户机器的
    //     越权；而事故 100% 是 Idle Sleep，-i 已经足够。
    // -w：见文件头「为什么是 -w」。
    const proc = spawner(buildCaffeinateArgv());
    caffeinateProc = proc;
    proc.unref?.();
    // 进程自己退出时清空句柄，否则 spawnCaffeinate 的 `!== null` 守卫会永久挡住重拉。
    // killCaffeinate 会先把 caffeinateProc 置 null，所以「=== proc」只在**意外**退出时成立。
    const onExit = () => {
      if (caffeinateProc !== proc) return;
      caffeinateProc = null;
      onUnexpectedExit();
    };
    void proc.exited.then(onExit, onExit);
    getLogger().debug?.("PREVENT_SLEEP", "已启动 caffeinate -i -w，任务期间阻止空闲休眠");
  } catch {
    // caffeinate 不存在 / spawn 失败 → 静默降级。
    // 保活是增强而非正确性依赖：拿不到 assertion 时仍有第二/三层纵深兜底，
    // 绝不能因为挡不住休眠就让任务起不来。
    caffeinateProc = null;
  }
}

function killCaffeinate(): void {
  if (caffeinateProc === null) return;
  const proc = caffeinateProc;
  caffeinateProc = null; // 先清引用再杀，避免 exited 回调与此处重复处理
  try {
    // SIGKILL 而非 SIGTERM：caffeinate 是无状态的纯 assertion 持有者，没有需要
    // 优雅收尾的东西，SIGTERM 只会带来"可能延迟生效"的不确定性。
    proc.kill(9);
  } catch {
    // 已经退出了，无所谓
  }
}
