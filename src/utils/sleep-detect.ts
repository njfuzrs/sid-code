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
 * 为什么需要"会话级"而不只是"单轮级"：会话硬顶（maxSessionDurationMs，默认
 * 60min）是一个裸 setTimeout，休眠时长照算。事故轨迹里三次休眠共吃掉约 47
 * 分钟，用户"本轮连续执行"的额度被睡觉消耗光了——这与"扣除等待用户输入时长"
 * （loop.ts 的 humanInputPauseAccumMs）是同一类问题、同一种修法：
 * **非业务时长不该计入业务预算**。
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
