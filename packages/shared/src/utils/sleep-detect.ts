// src/utils/sleep-detect.ts
// 休眠感知：把"系统睡了多久"从各类超时/预算判据里剔除
//
// ── 三层纵深里的第二层 ─────────────────────────────────────────────────
// 第一层 prevent-sleep.ts 让空闲休眠不发生，但它挡不住：合盖、手动休眠、电池
// 耗尽保护、非 macOS 平台、caffeinate 不可用。这些情况下休眠照样发生，本模块
// 负责"发生了也不冤枉任务"。
//
// ── 判据：挂钟跳跃 ──────────────────────────────────────────────────
// 进程被冻结期间 setInterval 不 tick，醒来时一次性补 fire。因此"上次 tick 到
// 这次 tick 的实际间隔"远超预期间隔，就是休眠（或进程被 SIGSTOP）的指纹。
// 轨迹 20260801-175042-699f69f8 实测：预期 5000ms，实际 926241ms。
//
// 为什么不用单调钟（performance.now / CLOCK_MONOTONIC）做判据：
// Darwin 上 mach_absolute_time 在休眠期是否推进与内核版本/电源状态相关，
// CLOCK_MONOTONIC 与 CLOCK_MONOTONIC_RAW 语义也不一致——"跨平台可证"这点上
// 挂钟差值比单调钟更靠得住（这也是 claude-code 三处 sleep 检测的共同做法：
// WebSocketTransport.ts:471 / bridgeMain.ts:1273 / replBridge.ts:2308）。
//
// ── 阈值为什么必须"显著大于"预期间隔 ─────────────────────────────────
// 正常调度抖动、GC、事件循环被同步任务短暂占满都会让 tick 迟到几十到几百毫秒。
// 阈值取太小会把正常抖动误判成休眠，进而无限重置重试预算——那比不检测更糟
// （任务永远不会因超时收尾）。claude-code 用「2× 最大退避上限」，理由同源：
// 阈值必须超过系统里最长的正常等待，否则正常等待就是误判源。
// 我们的 tick 是固定间隔，故用倍数 + 绝对下限双保险。

/**
 * 判定为休眠的最小倍数：实际间隔 > 预期 × 该倍数才算。
 * 取 10 倍——5s tick 需迟到 50s 以上，远超任何正常调度抖动，同时远小于
 * 最短一次真实休眠（实测 900s+），不会漏判。
 */
export const SLEEP_DETECT_RATIO = 10;

/**
 * 绝对下限：无论倍数如何，跳跃不足该值不算休眠。
 * 防止极小 tick 间隔（单测注入 50ms / 激进配置）下"50ms × 10 = 500ms"这种
 * 荒谬阈值把正常抖动判成休眠。30s 是安全线：小于它的停顿不可能是真实休眠。
 */
export const SLEEP_DETECT_FLOOR_MS = 30_000;

/**
 * 判断一次 tick 间隔是否指示系统休眠。
 *
 * @param actualMs   实测的两次 tick 间隔
 * @param expectedMs 预期的 tick 间隔
 * @returns true 表示这段间隔中系统大概率被挂起过
 */
export function isSleepGap(actualMs: number, expectedMs: number): boolean {
  if (!Number.isFinite(actualMs) || !Number.isFinite(expectedMs) || expectedMs <= 0) {
    return false;
  }
  return actualMs > Math.max(expectedMs * SLEEP_DETECT_RATIO, SLEEP_DETECT_FLOOR_MS);
}

/**
 * 从一次跳跃中提取"应当被剔除的休眠时长"。
 *
 * 剔除的是**跳跃超出预期的部分**，而非整个间隔——那一个正常 tick 周期本来就
 * 该算进业务耗时里，连它一起扣会让判据整体偏松。
 */
export function sleepGapMs(actualMs: number, expectedMs: number): number {
  if (!isSleepGap(actualMs, expectedMs)) return 0;
  return Math.max(0, actualMs - expectedMs);
}

/**
 * 会话级休眠累计器。
 *
 * 为什么需要"会话级"而不只是"单轮级"：会话硬顶（maxSessionDurationMs）原是一个裸
 * setTimeout，休眠时长照算。事故轨迹里三次休眠共吃掉约 47 分钟，用户"本轮连续执行"
 * 的额度被睡觉消耗光了——这与"扣除等待用户输入时长"（loop.ts 的
 * humanInputPauseAccumMs）是同一类问题、同一种修法：
 * **非业务时长不该计入业务预算**。
 *
 * 注（2026-08-04）：会话硬顶默认已改为 0（关闭），本累计器不再是它的必需配套；
 * 但仍被 loop.ts 的单轮硬顶 turn_hard / watchdog 消费（那两层始终开启），
 * 且会话硬顶显式重开时立即复用——不是死代码。
 *
 * 单例而非注入：休眠是进程级物理事件，任何一处观测到都对全局成立，各自维护
 * 反而会因"只有某个定时器在跑"而漏记。
 */
class SleepLedger {
  private totalMs = 0;
  private events = 0;
  private lastAtMs: number | null = null;

  /**
   * 记录一次观测到的休眠。返回本次计入的时长（0 表示未达阈值、未计入）。
   * 由各定时器的 drift 检测处调用，天然去重：同一段休眠只会被最先醒来的那个
   * tick 记一次，其余 tick 的间隔已经恢复正常。
   */
  record(actualMs: number, expectedMs: number): number {
    const gap = sleepGapMs(actualMs, expectedMs);
    if (gap <= 0) return 0;
    this.totalMs += gap;
    this.events += 1;
    this.lastAtMs = Date.now();
    return gap;
  }

  /** 本会话累计休眠时长（毫秒） */
  getTotalMs(): number {
    return this.totalMs;
  }

  /** 本会话观测到的休眠次数 */
  getEventCount(): number {
    return this.events;
  }

  /** 最近一次休眠被记录的时刻（挂钟毫秒），从未发生则为 null */
  getLastAtMs(): number | null {
    return this.lastAtMs;
  }

  /** 是否发生过休眠（用于决定要不要向用户解释中断原因） */
  hasSlept(): boolean {
    return this.events > 0;
  }

  /** 重置（仅测试用） */
  reset(): void {
    this.totalMs = 0;
    this.events = 0;
    this.lastAtMs = null;
  }
}

const ledger = new SleepLedger();

/** 全局休眠账本（进程级单例，理由见 SleepLedger 类注释） */
export function getSleepLedger(): SleepLedger {
  return ledger;
}

/** 重置全局账本（仅测试用） */
export function __resetSleepLedgerForTest(): void {
  ledger.reset();
  __stopSleepObserverForTest();
}

// ─── 休眠观测器（P0-6：让流式路径也能拿到休眠账本） ───

/**
 * 观测器 tick 间隔。与 loop.ts 的 watchdog 同量级（5s）：
 * 判据 `isSleepGap(actual, 5000)` = 迟到超过 max(50s, 30s) 才算休眠，
 * 因此它能识别的最短休眠约 50s —— 远小于实测最短真实休眠（900s+），
 * 也远大于任何正常调度抖动。
 */
const SLEEP_OBSERVER_INTERVAL_MS = 5_000;

let observerTimer: ReturnType<typeof setInterval> | null = null;
let observerRefs = 0;
let observerLastTickAt = 0;

/**
 * 启动进程级休眠观测器（引用计数），返回 release 函数。
 *
 * ## 为什么流式路径需要它（2026-08-18，P0-6）
 *
 * 休眠扣减此前是 `query/loop.ts` 的局部能力：只有它的 `setInterval` 在每 tick
 * 比对挂钟、把跳跃记进账本。流式各层（`fallback.ts` 的流超时、`stream-lifecycle`
 * 三层、`openai.ts` parseSSE 的字节级检查）用的都是**一次性 setTimeout**，
 * 既不观测休眠、也无处可查 —— 于是同一时刻两套判据结论相反：轨迹实证一次
 * `sleep_ms ≈ 281s` 的休眠让 fallback 杀掉了一条**真实无进展仅 3.4 秒**的健康流，
 * 而同一时刻 loop 的 watchdog（扣了休眠）判定正常。
 *
 * 为什么不让各层自己用比率判据自测：一次性定时器的 expected 就是它自己的阈值
 * （如 300s），`isSleepGap(actual, 300_000)` 要求迟到超过 3000s 才命中 ——
 * 对 281s 的休眠**恒为 false**。判据必须来自一个 tick 间隔足够短的观测者，
 * 这正是本观测器存在的理由（也是它必须独立于任何一层阈值的理由）。
 *
 * 引用计数而非每层各起一个：休眠是进程级物理事件，一个观测者足够，
 * 且账本 `record()` 天然去重（同一段休眠只被最先醒来的 tick 记一次）。
 */
export function startSleepObserver(): () => void {
  observerRefs += 1;
  if (observerTimer === null) {
    observerLastTickAt = Date.now();
    observerTimer = setInterval(() => {
      const now = Date.now();
      const actual = now - observerLastTickAt;
      observerLastTickAt = now;
      ledger.record(actual, SLEEP_OBSERVER_INTERVAL_MS);
    }, SLEEP_OBSERVER_INTERVAL_MS);
    // unref：本观测器纯观测、不保护任何动作，绝不该因为它而阻止进程退出。
    // 与 loop.ts 那个「宁可持有事件循环也要保证 fire」的看门狗不同——那层是防线，
    // 这层只是仪器；仪器漏采一次的代价是「这次休眠没扣到」，而各层定时器回调里
    // 还有一次挂钟复核兜底（见 createSleepAwareDeadline）。
    (observerTimer as unknown as { unref?: () => void }).unref?.();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    observerRefs -= 1;
    if (observerRefs <= 0) {
      observerRefs = 0;
      if (observerTimer !== null) {
        clearInterval(observerTimer);
        observerTimer = null;
      }
    }
  };
}

/** 停止观测器并清零引用计数（仅测试用） */
export function __stopSleepObserverForTest(): void {
  observerRefs = 0;
  if (observerTimer !== null) {
    clearInterval(observerTimer);
    observerTimer = null;
  }
}

/** 观测器当前是否在跑（供测试与自检断言） */
export function isSleepObserverRunning(): boolean {
  return observerTimer !== null;
}

// ─── 休眠感知的到期判据 ───

export interface SleepAwareDeadline {
  /**
   * 距**真正**到期还剩多少毫秒。0 表示该开枪，>0 表示定时器是被休眠"补发"的，
   * 应当按这个剩余量重排而不是开枪。
   */
  remainingMs(): number;
  /** 本窗口已剔除的休眠时长（毫秒），供日志/埋点说明"为什么没开枪" */
  sleepMs(): number;
  /** 重排窗口起点（内容进展到达、续命时调用） */
  restart(): void;
  /** 窗口起点（挂钟毫秒） */
  startedAt(): number;
}

/**
 * 创建一个休眠感知的到期判据：`effectiveElapsed = 挂钟差值 − 本窗口内的休眠时长`。
 *
 * 用法（与"一次性 setTimeout + 回调复核"配套，**不改成轮询**以保留既有定时精度）：
 * ```ts
 * const dl = createSleepAwareDeadline(timeoutMs);
 * const arm = (ms: number) => setTimeout(() => {
 *   const remaining = dl.remainingMs();
 *   if (remaining > 0) { arm(remaining); return; }  // 休眠补发的一枪 → 重排
 *   fire();
 * }, ms);
 * arm(timeoutMs);
 * ```
 *
 * ⚠️ `setTimeout` 在休眠后是**唤醒即补发**：定时器 fire 了**不等于**真的过了那么久。
 * 这是本判据存在的全部理由 —— 回调里必须重新核对挂钟差值，不满足则重排定时器
 * 而非开枪（`query/loop.ts` 用周期 tick + 每 tick 核对，同一范式的另一种写法）。
 */
export function createSleepAwareDeadline(timeoutMs: number): SleepAwareDeadline {
  let armedAt = Date.now();
  let ledgerAtArm = ledger.getTotalMs();
  return {
    remainingMs(): number {
      const actual = Date.now() - armedAt;
      const slept = Math.max(0, ledger.getTotalMs() - ledgerAtArm);
      const effective = actual - slept;
      return Math.max(0, timeoutMs - effective);
    },
    sleepMs(): number {
      return Math.max(0, ledger.getTotalMs() - ledgerAtArm);
    },
    restart(): void {
      armedAt = Date.now();
      ledgerAtArm = ledger.getTotalMs();
    },
    startedAt(): number {
      return armedAt;
    },
  };
}

/**
 * 生成给用户看的休眠说明（无休眠则返回 null）。
 *
 * 为什么要专门给一句人话：休眠导致的超时在用户眼里长得和网络故障一模一样
 * （"请求超时"），而两者的应对完全不同——网络问题该查网络，休眠只需要知道
 * "机器睡了、这不是 bug"。不解释清楚，用户就会去排查一个不存在的网络故障。
 */
export function describeSleep(): string | null {
  if (!ledger.hasSlept()) return null;
  const min = Math.round(ledger.getTotalMs() / 60_000);
  const dur = min >= 1 ? `${min} 分钟` : `${Math.round(ledger.getTotalMs() / 1000)} 秒`;
  return `期间检测到系统休眠共约 ${dur}（${ledger.getEventCount()} 次），休眠时长已从超时判据中剔除`;
}
