/**
 * end_turn 后台任务单飞闸门（PR1 / 方案 §5.1 B1）
 *
 * ## 它防的是什么
 *
 * `end_turn` 是自然断点，`query/loop.ts` 在那里 fire-and-forget 地拉起两个 forked agent
 * （`updateSessionMemory` 与 `extractMemories`）。两者各自有**自己的**重入互斥
 * （`session-memory.ts` 的 `pending` / `extractor.ts` 的 `pending`），但那两把锁
 * **互不相干** —— 它们只防"同一个任务重入"，不防"两个不同任务并发"。
 *
 * 实测后果（会话 `20260821-140626-4fd1f34e`）：`TurnComplete(end_turn)` 之后系统又跑了
 * 44 秒、发出 7 次完整请求，每次输入约 10 万 token（fork 继承主对话全历史）。
 * 最大 in-flight = 2，与"两个 fork"完全对得上。用户为一个**已经答完**的任务
 * 多付了约 ¥2.3（占该会话账单 32%），而 TUI / 账本 / trace 里都看不到这笔钱。
 *
 * ## 为什么闸门放在这一层，而不是各自加锁
 *
 * 各自加锁是**已经做过**的事，而它恰恰是失效的那一层：两把独立的锁在语义上根本
 * 表达不出"后台任务全局最多跑一个"。所以闸门必须是**跨任务共享的单一队列**。
 *
 * ## 语义：串行 + 按 label 待补一笔（深度 1，不堆积）
 *
 * - 同一时刻只有一个后台任务在跑（`inFlight` 非空即不并发）。
 * - 来的任务与在跑的**同 label** → 直接丢弃：它自己已经在跑，下一个 end_turn 还会再来。
 * - 来的任务与在跑的**不同 label** → 记一笔待补（每个 label 至多一笔，新的覆盖旧的），
 *   当前任务结束时在 `finally` 里串行放行下一笔。
 * - 返回值 `true` = 当场启动，`false` = 没有当场启动（被丢弃或记为待补）。
 *
 * ⚠️ 为什么不是原来的「不同 label 也丢弃」（F3，2026-10-07）：唯一调用点
 * `query/loop.ts` 在**同一条同步路径上紧挨着**提交 `session-memory-update` 与
 * `memory-extract`，第一条刚把 `inFlight` 置上，第二条必然被拒 —— 「被拒的下一个
 * end_turn 还会再来」在这里不成立，记忆提取每次都排在后面、触发率恒为 0。
 * 待补深度按 label 封顶为 1，所以积压上限 = label 数（当前 2），
 * 不会退化成「攒一串十万 token 请求一次性烧掉」—— 那才是丢弃语义当初要防的东西。
 *
 * ## 刻意不做的事
 *
 * **不 await**。让主循环 `await` 这两个 fork 会把用户可感知的收尾延迟拉长到实测 44s
 * （方案 §5.1 B3 已否决：拿「更快」换「更准的账」是净退步）。闸门只管"不并发"，
 * 不管"什么时候跑完"。
 *
 * ⚠️ **已知残留（如实标注，见方案 §5.8）**：这仍是「作者要把新钩子接到闸门上」的形态。
 * 真正的结构性消除是把 end_turn 后台任务改成统一的任务队列（单一入口、串行、带预算），
 * 新钩子只能注册进队列、无法自己发请求。那个改造面显著更大，**本轮未包含** ——
 * 写在这里是为了不让下一个人误以为"后台并发"已经根治了。
 */

import { getLogger } from "../debug/logger.ts";
import { registerShutdownHook } from "@sid-code/shared/utils/graceful-shutdown.ts";

/**
 * 退出收尾等待上限。gracefulShutdown 的 failsafe 是 5s，留出余量给后面的 flush 钩子。
 */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 4_000;

/** 当前在跑的后台任务（null = 空闲）。模块级单例：闸门必须跨任务共享才有意义。 */
let inFlight: Promise<void> | null = null;
/** 当前在跑的任务标签（日志/诊断用） */
let inFlightLabel: string | null = null;
/** 被闸门拒掉的次数（度量用：闸门到底有没有在起作用） */
let rejectedCount = 0;
/** 真正放行的次数（含待补转放行） */
let admittedCount = 0;
/** 被记为待补的次数 */
let deferredCount = 0;
/**
 * 待补任务：label → task。Map 保持插入顺序，放行时先进先出。
 * 每个 label 至多一笔（覆盖写），所以积压上限 = label 数。
 */
const pending = new Map<string, () => Promise<void>>();

/** 闸门统计快照（供测试与诊断读取） */
export interface BackgroundGateStats {
  admitted: number;
  rejected: number;
  /** 被记为待补的次数（之后可能放行，也可能在退出时被 drain 丢弃） */
  deferred: number;
  /** 当前挂着的待补 label */
  pendingLabels: string[];
  busy: boolean;
  busyLabel: string | null;
}

/**
 * 走闸门跑一个 end_turn 后台任务。
 *
 * @param label 任务标签（如 `session-memory-update` / `memory-extract`），仅用于日志与统计。
 * @param task  真正的任务体。异常一律被吞（后台任务失败不得影响主循环收尾）。
 * @returns `true` 表示已放行并启动，`false` 表示闸门忙、本次被丢弃。
 *
 * **不 await 内部任务**：本函数同步返回放行结果，任务在后台跑完自行释放闸门。
 */
export function runBackgroundTask(label: string, task: () => Promise<void>): boolean {
  if (inFlight) {
    if (label === inFlightLabel) {
      rejectedCount++;
      getLogger().debug("BG_GATE", `后台任务 ${label} 已在跑，本次丢弃`);
      return false;
    }
    deferredCount++;
    // 覆盖写而非追加：同 label 只留最新一笔，积压封顶。
    pending.delete(label);
    pending.set(label, task);
    getLogger().debug(
      "BG_GATE",
      `后台任务 ${label} 记为待补（${inFlightLabel} 仍在跑），前一个结束后串行放行`,
    );
    return false;
  }
  start(label, task);
  return true;
}

function start(label: string, task: () => Promise<void>): void {
  // F3：退出路径此前没有任何人 await 在跑的后台 fork（drainBackgroundTasks 生产零调用）。
  // 在首次放行时注册；按 name 去重，反复调用不堆积。
  registerShutdownHook("background-task-gate", "pre-flush", () =>
    drainBackgroundTasks(SHUTDOWN_DRAIN_TIMEOUT_MS),
  );
  admittedCount++;
  inFlightLabel = label;
  // 用一个已 settle 的 Promise 起链，保证 task() 的同步抛出也被收敛进链里
  // （否则同步抛出会绕过 .catch，闸门永远不释放 —— 那就从"防并发"变成"永久堵死"）。
  inFlight = Promise.resolve()
    .then(task)
    .catch((err) => {
      getLogger().debug(
        "BG_GATE",
        `后台任务 ${label} 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    })
    .finally(() => {
      inFlight = null;
      inFlightLabel = null;
      const next = pending.entries().next();
      if (!next.done) {
        const [nextLabel, nextTask] = next.value;
        pending.delete(nextLabel);
        start(nextLabel, nextTask);
      }
    });
}

/**
 * 会话收尾：丢弃全部待补任务，等待当前在跑的那一个结束（避免进程退出时截断写盘）。
 * 超时后直接返回（不抛）—— 后台任务不值得阻塞退出。
 *
 * 待补任务**不在退出时启动**：一个刚发出的十万 token 级 fork 在几秒内就会被进程退出
 * 掐断，只白烧钱、什么也写不进去。
 */
export async function drainBackgroundTasks(timeoutMs = 15_000): Promise<void> {
  pending.clear();
  const current = inFlight;
  if (!current) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([current, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 读闸门统计（测试与诊断用）。 */
export function getBackgroundGateStats(): BackgroundGateStats {
  return {
    admitted: admittedCount,
    rejected: rejectedCount,
    deferred: deferredCount,
    pendingLabels: [...pending.keys()],
    busy: inFlight !== null,
    busyLabel: inFlightLabel,
  };
}

/**
 * 重置闸门（**仅测试用**）。
 *
 * 生产路径绝不调用：闸门是进程级单例，重置等于把"当前有任务在跑"这个事实抹掉，
 * 下一次调用就会放行第二个任务 —— 正是闸门要防的东西。
 */
export function resetBackgroundTaskGate(): void {
  inFlight = null;
  inFlightLabel = null;
  rejectedCount = 0;
  admittedCount = 0;
  deferredCount = 0;
  pending.clear();
}
