/**
 * 等待登记表（W1）：把「之后谁会叫醒空闲主循环」从隐含约定变成显式登记。
 *
 * ## 要解决的事故（20261108-112620-7dd98bf5 / 20261108-112039-9e3a681d）
 *
 * 模型排了 `schedule_wakeup`（25 分钟后）就去收尾，todo 闸门 T2 只认「运行中的后台任务」
 * （`hasAwaitedBackgroundTasks`），看不到调度器里的唤醒 → 判成「没有人会回来」→ `todo_gate_retry`
 * 把模型推回前台空转 ~100 次 `gh pr checks`。等 CI 真绿了，唤醒早已排在队列里，然后凭空冒出来。
 *
 * `background-await.ts` 的口径（「在跑」≠「值得等」，60s 静默的后台 shell 不算）是对的，
 * 它防的是常驻服务死等（20261103-130950-00ef059c）。缺的是**另一类等待**：显式声明了
 * 「最晚什么时候回报」的等待源——定时唤醒、带期限的后台命令、monitor。
 *
 * ## 概念
 *
 * - **等待源（WaitSource）**：一个「之后会把空闲主循环叫醒」的东西。
 * - **回报承诺（ReportPromise）**：它最晚什么时候、以什么方式叫醒主循环。
 *
 * 只有**带承诺**的等待源才能让 harness 放心地让模型收尾。没有承诺的（常驻服务、挂住的命令）
 * 不算等待，继续按 `background-await.ts` 的静默口径处理。
 *
 * ## 为什么不把 agent / 普通 shell 也登记一份
 *
 * agent / workflow / 普通 shell 的状态已经在 `task/registry.ts` 里，再登记一份就有两个事实源，
 * 迟早漂移（「两套尺子」同型）。所以它们**派生**：`listWaits()` 现读 registry，判据逐字复用
 * `isAwaitedBackgroundTask`。只有 registry 里没有的东西（期限、subjects、wakeup 调度任务）
 * 才真的存进本表。
 *
 * 这条是 `hasPromisedWait` 能成为 `hasAwaitedBackgroundTasks` **超集**的原因：
 * 派生分支逐字复用旧逻辑，新判据只多出显式声明的 `deadline` 源。没有新等待源的会话里，
 * 两个判据的结果完全相同（回归主断言 T-W2-1）。
 *
 * ## 期限用单调时钟
 *
 * 系统时钟回拨（NTP 校时、用户改表）不能让「还剩 5 分钟的等待」变成负数或几小时。
 * `deadlineAt` 只用于展示（`剩 Xm`），判定一律用 `performance.now()` 换算的 `deadlineMono`。
 * 机器休眠期间单调时钟也会前进，这是**期望**的：monitor / wait_until 等的是外部世界，
 * 休眠期间外部状态照常变化，醒来就该看到「期限已到」。
 */

import { performance } from "node:perf_hooks";
import { getTask, getRunningTasks, notifyTaskChanged, onTaskChanged } from "./registry.ts";
import { isAwaitedBackgroundTask, setDeadlineWaitPredicate } from "./background-await.ts";
import {
  isAgentTask,
  isPanelTask,
  isShellTask,
  isTerminalStatus,
  isWorkflowTask,
  type TaskState,
  type TaskStatus,
} from "./types.ts";
import { getScheduler } from "../cron/scheduler.ts";
import type { StatusQueryFamily } from "./status-query-commands.ts";
import { extractNaturalLanguageSubjects } from "./wait-subjects.ts";
import { emitScheduledTrace, SCHEDULED_INVALIDATED_EVENT_NAME } from "../cron/cron-telemetry.ts";
import { enqueueTaskNotification } from "./notification.ts";
import { getLogger } from "../debug/logger.ts";

/** 回报承诺：最晚何时、以何种方式把空闲主循环叫醒 */
export type ReportPromise =
  | { kind: "terminal" } // 子代理 / workflow：终态必通知
  | { kind: "deadline"; deadlineAt: number } // 到期必通知（monitor / wait_until / 唤醒）
  | { kind: "exit_or_quiescent" }; // 普通后台 shell：退出或静默补唤醒

export type WaitSourceKind = "agent" | "workflow" | "shell" | "monitor" | "wakeup";

export interface WaitSource {
  /** 任务 id（shell / monitor / agent）或调度任务 id（wakeup） */
  id: string;
  kind: WaitSourceKind;
  promise: ReportPromise;
  /** 进回执与 TUI 面板，如「PR #662 CI」 */
  description: string;
  registeredAt: number;
  /** 等待对象的签名（S2 用）：monitor 的命令归一化后的关键实体，如 "gh:pr:662" */
  subjects?: string[];
  /**
   * monitor 脚本里出现的**命令族**（D13 的字段级覆盖判定用）。
   *
   * 为什么 subjects 不够：`gh:pr:662` 是对象粒度，而 monitor 实际只报告脚本里
   * 那几类查询的字段。`gh pr checks 662` 的 monitor 看不到 `reviewDecision`，
   * 拿「覆盖了对象」当「覆盖了字段」会让模型在 monitor 期间一直看不到字段变化。
   *
   * 空数组 / undefined = 扫不出（脚本里是自定义命令）→ **视为不覆盖**，
   * 回到 120s 探测窗口。方向是宁可多放行几次，不可拦住一个没被覆盖的查询。
   */
  commandFamilies?: StatusQueryFamily[];
}

/** 释放原因（闭集）：进 `WaitReleased` 事件，也是「为什么不再算了」的唯一口径 */
export type WaitReleaseReason =
  | "terminal" // 任务终态 / 唤醒已注入
  | "expired" // 期限过 + 宽限仍未回报（承诺被违背，非 0 即 bug）
  | "cancelled" // 用户 cron_delete
  | "superseded" // 被新的同 origin 唤醒替换
  | "invalidated" // S1 清单清零 / S2 被等对象已终态
  | "session_end";

/**
 * 期限宽限：`deadlineAt` 过后多久仍算「有效」。
 *
 * 覆盖「kill 后 `exit` 事件到达」的正常延迟（实测 shell kill → exit < 1s），30s 是 30 倍余量。
 * 为什么需要宽限：`deadline` 源的正常路径是「harness 自己的定时器 kill → 子进程 exit →
 * releaseWait(terminal)」，两步之间有几毫秒到几秒的窗口。窗口里判「无效」会让闸门
 * 在一个马上就要回报的源上放行，等于把承诺作废。
 */
export const DEADLINE_GRACE_MS = 30_000;

interface WaitEntry {
  src: WaitSource;
  /** 单调时钟下的期限（`monoNow()` 基准）；`src.promise.deadlineAt` 只用于展示 */
  deadlineMono?: number;
  /**
   * 唤醒已从调度器触发（fire）的单调时刻（D10）；未触发为 `undefined`。
   *
   * 为什么需要它：唤醒到点触发时调度器**同一次 `check()` 内**就把它从 `sessionTasks`
   * 删掉（`Scheduler.fireOnce`），而宿主此刻可能正忙，prompt 还在
   * `scheduledPromptQueue` 里排队等注入。这段窗口里「调度器里已经没有它」不等于
   * 「已经回报」——它恰恰是「马上就会被注入」的那个状态。旧判据只看调度器的账，
   * 把这一整段判成「没有等待源」，todo 闸门据此强推（重演 9e3a681d 的形态）。
   *
   * 同时它也是注入路径坏掉时的兜底基准：`firedMono + DEADLINE_GRACE_MS` 内既没
   * 被注入也没被丢弃，说明这条唤醒丢了，交给 `sweepExpiredWaits` 按违约处理。
   */
  firedMono?: number;
}

/** 显式登记表：只存 registry 里没有的东西（期限 / subjects / wakeup） */
const explicitWaits = new Map<string, WaitEntry>();

/**
 * 已失效的 id（S1/S2 撤销、承诺过期）。
 *
 * 为什么要单独记：唤醒被撤销时，它可能已经 fire 并进了宿主的 `scheduledPromptQueue`，
 * 这时调度器里已经没有这条任务（`listWaits` 判不出），只能靠这个集合在**注入前**拦一道
 * （§5.3.4 的 `dropped_invalidated`）。不删除记录：同一条可能在注入器抛错后被重新入队，
 * 下次 flush 还要再判一次。
 */
const invalidatedIds = new Set<string>();

/**
 * 终态 monitor 的 subjects 快照（D8/S2）：等通知**送达**之后再判要不要撤销唤醒。
 *
 * 为什么需要搬一份：subjects 只存在登记项里，而 `releaseWait` 会把它删掉。终态释放
 * （D4）发生在任务进终态那一刻，比「通知进模型上下文」早一段；到送达时就再也读不到
 * subjects 了。所以释放时把登记项自己的 subjects 搬到这张表——来源仍唯一（登记项），
 * 这里只是一次短命的中转，送达即删。
 *
 * 有界性：通知可能永远不送达（如 `task_output` 抢先认领结果、队列里的通知被撤回），
 * 残项由 `TERMINAL_SUBJECT_TTL_MS` 兜底清理，不在会话生命周期里累积。
 */
const terminalMonitorSubjects = new Map<string, { subjects: string[]; at: number }>();

/**
 * 终态 monitor 的 subject 快照保留多久（D8）。
 *
 * 正常路径是「任务终态 → 通知入队 → 下一个可注入点送达」，一个回合内；5 分钟是
 * 「通知被别的通道认领、永远不会走送达路径」时的兜底上限，不是等待语义的一部分。
 */
const TERMINAL_SUBJECT_TTL_MS = 5 * 60_000;

/**
 * 唤醒是否登记取决于「宿主有没有注入通道」。
 *
 * 无头（`-p` / SDK 单轮）下 `promptInjector` 不注册，`schedule_wakeup` 永远等不到触发——
 * 登记它只会让闸门为一个不会来的唤醒无限放行，进程挂到期限（§5.2.4）。
 * 由 cli 的 `setPromptInjector` 在通道就绪时打开；未打开 = 保持现状（不登记）。
 */
let wakeupRegistrationEnabled = false;

/** trace 写入通道（由 App 注入，指向 `TraceCollector.recordCustomEvent`） */
export type WaitTraceSink = (event: string, data: Record<string, unknown>) => void;
let traceSink: WaitTraceSink | null = null;

/** 注入 trace 通道。传 `null` 关闭。 */
export function setWaitTraceSink(s: WaitTraceSink | null): void {
  traceSink = s;
}

/**
 * 等待源变更的**用户可见**通知（TUI 系统行）队列。
 *
 * 撤销发生在 `todo_write` 的工具执行链里，那里拿不到 queryLoop 的 `yield`；
 * 而这条提示**只给用户看、不进模型上下文**，所以不能走 `ctxMgr`。折中做法：
 * 先入队，由主循环在下一个可 yield 的点取走并以 `{kind:"system"}` 发出——
 * TUI 渲染成系统行，`ctxMgr` 里没有它（系统行本来就不进上下文）。
 */
export interface WaitNotice {
  kind: "wakeup_invalidated";
  taskId: string;
  reason: string;
  /**
   * 被撤唤醒的 prompt 预览（首行前 30 字，D9）。
   *
   * 只给用户看 id 认不出撤的是哪一条等待——「已取消定时唤醒 wk-3f2a」对用户是噪音，
   * 「（检查 PR #662 的 CI 是否绿了…）」才是他能对上号的那条。
   */
  promptPreview?: string;
}

const pendingNotices: WaitNotice[] = [];

/** 取走全部待展示的等待源通知（主循环每轮调用一次）。 */
export function drainWaitNotices(): WaitNotice[] {
  return pendingNotices.splice(0);
}
/** 测试辅助：清空待展示队列。 */
export function __clearWaitNoticesForTest(): void {
  pendingNotices.length = 0;
}

function emitWaitTrace(event: string, data: Record<string, unknown>): void {
  try {
    traceSink?.(event, data);
  } catch {
    /* 埋点失败静默，绝不影响等待语义 */
  }
}

// ── 单调时钟（可注入，T-W1-8/9 用） ──

let monoNowImpl: () => number = () => performance.now();

/**
 * 测试用：替换单调时钟。传 `null` 恢复 `performance.now()`。
 *
 * 生产代码**不要**调用。存在的唯一理由是可复现地测「时钟回拨不影响期限判定」——
 * 真实回拨系统时钟在单测里做不到。
 */
export function __setMonoClockForTest(fn: (() => number) | null): void {
  monoNowImpl = fn ?? (() => performance.now());
}

function monoNow(): number {
  return monoNowImpl();
}

// ── 登记 / 释放 ──

/**
 * 登记一个等待源。同 id 重复登记**覆盖**（不叠加），返回是否真的登记了。
 *
 * wakeup 在宿主没有注入通道时不登记（见 `wakeupRegistrationEnabled`）：否则无头会话会为
 * 一个永远不会来的唤醒挂到期限。
 */
export function registerWait(src: WaitSource): boolean {
  if (src.kind === "wakeup" && !wakeupRegistrationEnabled) {
    getLogger().warn(
      "TASK",
      `宿主没有 prompt 注入通道，唤醒 ${src.id} 不登记为等待源（无头模式下它永远不会触发）`,
    );
    return false;
  }
  const deadlineMono =
    src.promise.kind === "deadline"
      ? monoNow() + Math.max(0, src.promise.deadlineAt - Date.now())
      : undefined;
  explicitWaits.set(src.id, { src, deadlineMono });
  // 同 id 重新登记视为一份新承诺：旧的失效记录不能继续挡它（id 随机，理论上不会撞）
  invalidatedIds.delete(src.id);
  emitWaitTrace("WaitRegistered", {
    id: src.id,
    kind: src.kind,
    promise_kind: src.promise.kind,
    ...(src.promise.kind === "deadline" ? { deadline_ms: src.promise.deadlineAt } : {}),
    description: src.description,
    ...(src.subjects && src.subjects.length > 0 ? { subjects: src.subjects } : {}),
  });
  return true;
}

/** 释放一个等待源。没登记过是 no-op（幂等：终态 / 到期 / 撤销可能先后到达）。 */
export function releaseWait(id: string, reason: WaitReleaseReason): boolean {
  const entry = explicitWaits.get(id);
  if (!entry) return false;
  explicitWaits.delete(id);
  if (reason === "invalidated" || reason === "expired") invalidatedIds.add(id);
  // D8/S2：终态释放是 subjects 的**唯一**读取窗口（登记项马上就没了）。S2 要求
  // 「被等对象成功终态 **且通知已送达**」，而送达点在注入侧、比这里晚一段，
  // 所以把登记项自带的 subjects 搬到待送达快照，送达时再判
  // （见 `invalidateWakeupsForDeliveredTask`）。不另存第二份权威数据：
  // 这里只是同一次搬移，送达即删。
  if (reason === "terminal" && entry.src.kind === "monitor" && entry.src.subjects?.length) {
    terminalMonitorSubjects.set(id, { subjects: entry.src.subjects, at: Date.now() });
  }
  emitWaitTrace("WaitReleased", {
    id,
    kind: entry.src.kind,
    reason,
    held_ms: Math.max(0, Date.now() - entry.src.registeredAt),
  });
  return true;
}

/**
 * 终态即释放（D4）：任务进终态的那一刻就释放对应的等待登记。
 *
 * 只在 `listWaits` 里判「任务还在不在 registry」不够：终态但**还没被驱逐**的任务
 * （驱逐要「已送达 + 过一个回合 + 30s」）会一直挂在登记表里，等到期限 + 宽限就被
 * `sweepExpiredWaits` 判成「承诺违背」，往队列里塞一条假 failed 通知把模型叫醒。
 * 也不该等「下次有人问」才释放：那样 `WaitReleased.held_ms` 记的是查询时刻，不是真实持有时长。
 *
 * 订阅 `onTaskChanged` 而不是在每个任务写点各调一次（registry / shell / monitor 有 9 处写点）：
 * 与 TUI 刷新、`background-wake` 共用同一个事实源，不会漏。
 *
 * **释放后必须补一次 `notifyTaskChanged()`**：`releaseWait` 本身不通知订阅方。本回调在
 * `updateTask` 的通知链里执行，`background-wake` 的那次重判看到的登记项还没释放
 * （`hasPromisedWait()` 仍为 true）；不补通知，无头等待循环要等下一次任务变更才重判，
 * 进程会多挂到那时。补一次让所有订阅方在「登记已释放」的最终状态上重算一遍。
 * 重入只有一层：内层再跑时已无待释放项，不再补通知。
 */
function releaseTerminalWaits(): void {
  let released = 0;
  for (const id of [...explicitWaits.keys()]) {
    const entry = explicitWaits.get(id);
    // 唤醒不在 task registry 里（它在调度器），不进这条链路
    if (!entry || entry.src.kind === "wakeup") continue;
    const task = getTask(id);
    if (task && isTerminalStatus(task.status) && releaseWait(id, "terminal")) released++;
  }
  if (released > 0) notifyTaskChanged();
}

onTaskChanged(releaseTerminalWaits);

// N4：`wait_until_seconds` 的后台 shell 有「到期必 kill + 通知」的期限承诺，
// 不需要「已静默、不会再自动回报」那条兜底唤醒——它俩同时出现就是自相矛盾，
// 模型只能自己前台去查（20261109-191904-962011a6 连查 32 次、8.45M 输入 token）。
//
// 用注入而不是让 background-await 直接 import 本模块：本模块已经反向依赖
// `isAwaitedBackgroundTask`（登记表的派生分支要逐字复用那个口径），直接 import 会成环。
setDeadlineWaitPredicate((taskId) => explicitWaits.get(taskId)?.src.promise.kind === "deadline");

/** 会话结束：全部释放（并发 `WaitReleased{reason:"session_end"}`，便于对账）。 */
export function releaseAllWaits(reason: WaitReleaseReason = "session_end"): number {
  const ids = [...explicitWaits.keys()];
  for (const id of ids) releaseWait(id, reason);
  // 待送达快照描述的是「这个会话里还有通知要送达」，会话结束就没人消费了
  terminalMonitorSubjects.clear();
  return ids.length;
}

/**
 * 这个 id 的等待是否已失效（S1/S2 撤销、承诺过期）。
 *
 * 只回答「撤销过吗」，不回答「现在还算不算有效」——后者是 `listWaits` 的事。
 * 用途是唤醒**注入前**的再确认：排队窗口里清单可能已经清零（§5.3.4）。
 */
export function isWaitInvalidated(id: string): boolean {
  return invalidatedIds.has(id);
}

/** 宿主是否具备 prompt 注入通道（决定 wakeup 要不要登记） */
export function setWakeupRegistrationEnabled(enabled: boolean): void {
  wakeupRegistrationEnabled = enabled;
}

/**
 * 当前宿主是否具备 prompt 注入通道（只读）。
 *
 * 反过来也是「宿主会不会等到等待源结束」的判据：没有注入通道（`-p` 单轮这类无头形态）
 * 就没有事件投递入口，进程只能等 monitor 跑完再退出（方案 §10.3）。
 * 只暴露读取，不新增全局状态——写入仍然只有 `setWakeupRegistrationEnabled` 一处。
 */
export function isWakeupRegistrationEnabled(): boolean {
  return wakeupRegistrationEnabled;
}

// ── 查询 ──

/**
 * 当前仍有效的等待源。
 *
 * 两个来源合并：
 * 1. **显式登记**（wakeup / wait_until shell / monitor）：任务仍在跑 + 期限未过（+ 承诺宽限）；
 * 2. **派生**（agent / workflow / 普通 shell）：现读 task registry，判据逐字复用
 *    `isAwaitedBackgroundTask`——普通后台 shell 的行为因此与改动前**逐字节一致**。
 *
 * 显式登记的 id 优先，派生时跳过（同一个 shell 不会既按 deadline 又按静默口径各算一次）。
 */
export function listWaits(now = Date.now()): WaitSource[] {
  // 承诺被违背的兜底（§5.2.3 第二层）：期限 + 宽限还没回报 → 判无效 + 叫醒主循环重判。
  // 放在查询入口而不是定时器里：主循环只要还在跑就一定会问「现在有等待源吗」，
  // 因此不需要为每个源各挂一个定时器，也不会有「没人查就永远不清理」的泄漏。
  sweepExpiredWaits();

  const out: WaitSource[] = [];
  const seen = new Set<string>();

  for (const [id, entry] of [...explicitWaits]) {
    if (isExplicitWaitValid(entry, now)) {
      out.push(entry.src);
      seen.add(id);
      continue;
    }
    // 进程类任务已经终态：正常回报（退出通知）已经发生过，补一条 WaitReleased{terminal}
    // 让事件对账完整。唤醒不走这里——它 fire 后也会从 sessionTasks 消失，但「fire 了还没注入」
    // 不等于「已回报」，那一段由注入路径释放（§5.3.4）。
    // 「终态但还没被驱逐」也算（D4）：`getTask` 只回答「在不在表里」，驱逐要等
    // 「已送达 + 过一个回合 + 30s」，这一段空窗正是 sweep 误判「承诺违背」的地方。
    if (entry.src.kind !== "wakeup") {
      const task = getTask(id);
      if (!task || isTerminalStatus(task.status)) releaseWait(id, "terminal");
    }
  }

  for (const task of getRunningTasks()) {
    if (seen.has(task.id)) continue;
    if (!isPanelTask(task)) continue;
    const derived = deriveWait(task, now);
    if (derived) out.push(derived);
  }
  return out;
}

/** 是否有带承诺的等待源——「有东西在等就别催 / 别退」类判断统一走这里（W2） */
export function hasPromisedWait(now = Date.now()): boolean {
  return listWaits(now).length > 0;
}

/**
 * 这个等待源是不是**模型自己显式声明**的等待（D12 的判据 1 口径）。
 *
 * 与 `hasPromisedWait` 的差别是本函数回答的问题更窄：那边问「有没有东西在等」
 * （todo 闸门 T2 要宽，任何等待都算），这边问「模型是否声明了在等**外部状态**」。
 *
 * 为什么必须分开：派生出来的子代理 / workflow / 普通后台 shell 承诺的是
 * 「**自己**结束时会回报」，不是「查询的那个**外部对象**状态变化时会回报」。
 * 拿 `hasPromisedWait` 当 P1 拦截的前提，会让模型起一个无关的 `bun test` 之后
 * 就再也查不到 PR 状态（D12 事故 R10）。
 *
 * 算「显式声明」的三类：monitor（盯对象）、唤醒（定时器）、`wait_until` 后台命令（期限）。
 */
export function isDeclaredExternalWait(src: WaitSource): boolean {
  if (src.kind === "monitor" || src.kind === "wakeup") return true;
  // 普通后台 shell 走派生分支，promise 是 exit_or_quiescent；
  // 只有显式带 wait_until_seconds 的才是 deadline（bash.ts 的 registerWaitUntil）
  return src.kind === "shell" && src.promise.kind === "deadline";
}

/** 有没有**模型显式声明**的等待源（D12 放宽不了、也收紧不得的那一条判据） */
export function hasDeclaredExternalWait(now = Date.now()): boolean {
  return listWaits(now).some(isDeclaredExternalWait);
}

/** 按等待对象签名找等待源（S2 / PR 3 的 monitor 用）。 */
export function findWaitBySubject(subject: string, now = Date.now()): WaitSource | undefined {
  return listWaits(now).find((w) => w.subjects?.includes(subject));
}

/** 显式登记项是否仍有效。 */
function isExplicitWaitValid(entry: WaitEntry, now: number): boolean {
  const { src } = entry;
  if (src.kind === "wakeup") {
    const scheduler = getScheduler();
    // 被更新的唤醒替换（F2）：无论是否已触发都不再算数
    if (scheduler.isSuperseded(src.id)) return false;
    // D10：已触发（fire）、但还没被注入或丢弃 —— 这仍是等待源。
    // 触发那一下调度器就把任务从 `sessionTasks` 删了，而宿主的注入走异步链
    // （忙时排在 `scheduledPromptQueue` 里）。旧判据只看调度器的账，把这一整段
    // 判成「没人会回来」，闸门据此强推（重演 9e3a681d）。
    // 释放交给注入路径（`injectScheduledPrompt` 的 releaseWait(terminal)），
    // 注入路径坏掉时由 `sweepExpiredWaits` 的宽限兜底。
    if (wakeupFiredMono(entry) !== undefined) return true;
    // 还没触发：任务必须还在调度器里（cron_delete 删掉后要立刻失效）
    if (!scheduler.getSessionTask(src.id)) return false;
  } else {
    // monitor / wait_until shell 都是 task registry 里的任务
    const task = getTask(src.id);
    if (!task || task.status !== "running") return false;
  }
  if (src.promise.kind === "terminal") return true;
  if (src.promise.kind === "deadline") {
    if (entry.deadlineMono === undefined) return false;
    return monoNow() < entry.deadlineMono + DEADLINE_GRACE_MS;
  }
  // exit_or_quiescent 的显式登记目前没有（普通 shell 走派生），保守放行
  return true;
}

/**
 * 这条唤醒「已触发」的单调时刻（D10）；没触发过返回 `undefined`。
 *
 * 只看 `registeredAt` 之后记录的那次触发：同 id 被复用（重新登记）时，调度器里留着
 * 的旧记录不能把一条**新**唤醒误判成「已经在等注入」。
 */
function wakeupFiredMono(entry: WaitEntry): number | undefined {
  if (entry.src.kind !== "wakeup") return undefined;
  const firedAt = getScheduler().getWakeupFiredAt(entry.src.id);
  if (firedAt === undefined || firedAt < entry.src.registeredAt) return undefined;
  return (entry.firedMono ??= monoFromWallClock(firedAt));
}

/**
 * 把调度器记的墙钟时刻（`Date.now()` 基准）换算到单调时钟（D10）。
 *
 * 判据统一用单调时钟是文件头的硬约定（系统校时不能把「还剩 5 分钟」变成负数或几小时）。
 * 墙钟回拨时差值钳成 0 = 视作「刚刚触发」，兜底窗口从最早时刻起算，不会提前误判违约。
 */
function monoFromWallClock(wallClockMs: number): number {
  return monoNow() - Math.max(0, Date.now() - wallClockMs);
}

/** 从 task registry 派生的等待源。没有承诺的任务返回 undefined（不算等待）。 */
function deriveWait(task: TaskState, now: number): WaitSource | undefined {
  if (task.status !== "running") return undefined;
  if (isAgentTask(task)) {
    return {
      id: task.id,
      kind: "agent",
      promise: { kind: "terminal" },
      description: task.description,
      registeredAt: task.startTime,
    };
  }
  if (isWorkflowTask(task)) {
    return {
      id: task.id,
      kind: "workflow",
      promise: { kind: "terminal" },
      description: task.description,
      registeredAt: task.startTime,
    };
  }
  if (isShellTask(task)) {
    // 逐字复用旧判据：静默的后台 shell（常驻服务）不算等待，20261103 事故的修复不能回退
    if (!isAwaitedBackgroundTask(task, now)) return undefined;
    return {
      id: task.id,
      kind: "shell",
      promise: { kind: "exit_or_quiescent" },
      description: task.description,
      registeredAt: task.startTime,
    };
  }
  return undefined;
}

/**
 * 承诺过期兜底：`deadline` 源过了期限 + 宽限仍没释放 → 判无效 + 发 failed 通知叫醒主循环。
 *
 * 正常路径下**零触发**（期限到了由 harness 自己的定时器 kill 并通知）。触发了就是 bug
 * （子进程被外部 SIGKILL 没触发 exit、调度器挂了），§9.8 的 `promise_violations` 单列。
 *
 * 唤醒分两种（D10）：
 * - **还没触发**：到期由调度器 fire 负责，在这里判「过期」会把一次正常触发误报成违约，跳过；
 * - **已触发、还没注入**：注入路径（`injectScheduledPrompt` 或注入前判过期丢弃）必须在
 *   `DEADLINE_GRACE_MS` 内把它消化掉。超了说明注入路径坏了（prompt 丢了 / 宿主卡死），
 *   不兜底会让无头 / stream-json 的等待循环永远等一个不会来的回报，进程不退出。
 */
function sweepExpiredWaits(): void {
  const nowMono = monoNow();
  // 终态 monitor 的 subject 快照有界：通知可能永远不走送达路径（被 task_output 抢先
  // 认领会撤回队列里的通知），这些残项不能被无限保留。清在这里而不是定时器里，
  // 与承诺过期兜底同源：主循环只要还在问「有等待源吗」就会顺手清理。
  const wallNow = Date.now();
  for (const [id, snap] of [...terminalMonitorSubjects]) {
    if (wallNow - snap.at >= TERMINAL_SUBJECT_TTL_MS) terminalMonitorSubjects.delete(id);
  }
  for (const [id, entry] of [...explicitWaits]) {
    let expiredAtMono: number;
    if (entry.src.kind === "wakeup") {
      // 已被撤销（S1/S2）或被新唤醒替换（F2）：注入路径本就不该再注入它，
      // 释放由各自路径负责。走到这里说明有漏网（如丢弃分支提前 return 没释放），
      // 补一次释放即可——**不能**判违约，那不是「注入路径坏了」，是「本来就不该注入」。
      if (invalidatedIds.has(id)) {
        releaseWait(id, "invalidated");
        continue;
      }
      if (getScheduler().isSuperseded(id)) {
        releaseWait(id, "superseded");
        continue;
      }
      const firedMono = wakeupFiredMono(entry);
      // 未触发：不是本函数的管辖范围（见上方注释）
      if (firedMono === undefined) continue;
      expiredAtMono = firedMono;
    } else {
      if (entry.src.promise.kind !== "deadline" || entry.deadlineMono === undefined) continue;
      expiredAtMono = entry.deadlineMono;
    }
    if (nowMono < expiredAtMono + DEADLINE_GRACE_MS) continue;

    // 期限虽已过，但任务早就进了终态（退出通知已送达）——这是正常回报，不是承诺违背。
    // 必须先判这一条：驱逐要「已送达 + 过一个回合 + 30s」，经常晚于「期限 + 宽限」，
    // 否则正常结束的源会被本函数抢先判违约，往队列里塞一条假 failed 通知（D4）。
    // 唤醒不在 task registry，`getTask` 恒为 undefined，不影响这条判定。
    const task = getTask(id);
    if (task && isTerminalStatus(task.status)) {
      releaseWait(id, "terminal");
      continue;
    }

    explicitWaits.delete(id);
    invalidatedIds.add(id);
    emitWaitTrace("WaitReleased", {
      id,
      kind: entry.src.kind,
      reason: "expired",
      late: true,
      held_ms: Math.max(0, Date.now() - entry.src.registeredAt),
    });
    getLogger().warn(
      "TASK",
      entry.src.kind === "wakeup"
        ? `唤醒 ${id}（${entry.src.description}）已触发但 ${DEADLINE_GRACE_MS / 1000}s 内没有被注入或丢弃，判为注入路径失效`
        : `等待源 ${id}（${entry.src.description}）期限已过 ${DEADLINE_GRACE_MS / 1000}s 宽限仍未回报，判为承诺违背`,
    );
    enqueueTaskNotification({
      taskId: id,
      toolUseId: task?.toolUseId,
      outputFile: task?.outputFile ?? "",
      status: "failed",
      summary:
        entry.src.kind === "wakeup"
          ? `定时唤醒「${entry.src.description}」已触发但没能送达主循环（注入路径失效）。请按它原本要检查的状态自行确认一次。`
          : `等待「${entry.src.description}」的期限已过仍未收到任何回报（承诺被违背）。请确认它是否还在运行，必要时重新安排。`,
    });
  }
}

// ── 失效（W3 的 S1 / S2） ──

/**
 * 撤销本会话挂着的 schedule_wakeup 唤醒。
 *
 * 只用 harness **确定知道**的事实，不猜「目标达成」（#642 §6.3 的否决理由仍然成立）：
 * - `todo_cleared`（S1）：模型自己写的清单清零了；
 * - `subject_terminal`（S2）：被等的对象已经以成功终态结束并通知过。
 *
 * 撤销动作三件：调度器删任务 + 释放登记 + 发 `ScheduledInvalidated` 事件；
 * 再经 `noticeSink` 让用户看到一行系统提示（**不进模型上下文**）。
 *
 * @returns 被撤销的任务 id（没有匹配时为空数组）
 */
export function invalidateWakeups(
  signal: "todo_cleared" | "subject_terminal",
  opts: { subject?: string; reasonText: string },
): string[] {
  const scheduler = getScheduler();
  const victims: Array<{ id: string; promptPreview?: string }> = [];
  for (const [id, entry] of [...explicitWaits]) {
    if (entry.src.kind !== "wakeup") continue;
    if (signal === "subject_terminal") {
      if (!opts.subject || !entry.src.subjects?.includes(opts.subject)) continue;
    }
    scheduler.removeTask(id);
    // releaseWait 之后登记项就没了，预览必须在释放前取（D9）
    const promptPreview = previewOf(entry.src.description);
    releaseWait(id, "invalidated");
    emitScheduledTrace(SCHEDULED_INVALIDATED_EVENT_NAME, { task_id: id, signal });
    victims.push({ id, promptPreview });
  }
  for (const v of victims) {
    pendingNotices.push({
      kind: "wakeup_invalidated",
      taskId: v.id,
      reason: opts.reasonText,
      ...(v.promptPreview ? { promptPreview: v.promptPreview } : {}),
    });
  }
  return victims.map((v) => v.id);
}

/** 提示文案里的 prompt 预览：登记时已截到首行 60 字，这里再收到 30（D9 的「前 30 字」）。 */
function previewOf(description: string): string | undefined {
  const line = description.trim();
  if (!line) return undefined;
  return line.length > 30 ? `${line.slice(0, 30)}…` : line;
}

/**
 * 一条终态通知**已送达模型**：若它对应的 monitor 是成功终态（exit 0），
 * 按登记项带过来的 subjects 撤销本会话挂着的唤醒（S2）。
 *
 * 为什么由送达侧驱动，而不是在 `releaseWait(terminal)` 里直接撤销：S2 的判据是
 * 「被等对象已成功终态 **且通知已投递**」（方案 §6 第 ⑩ 行）。通知还没进上下文就撤销，
 * 等于在模型没看到结果时拿走它的兜底唤醒——一旦投递链路出问题（D2/D3 的形态），
 * 模型既不知道结果、也不会再被叫醒，这正是 #642 否决自动撤销时担心的那种静默中断。
 *
 * 为什么 subjects 要经快照：见 `terminalMonitorSubjects` 的注释（登记项在终态释放时消失）。
 *
 * @returns 被撤销的唤醒 id（failed / killed / 无 subject 快照均为空）
 */
export function invalidateWakeupsForDeliveredTask(taskId: string, status: TaskStatus): string[] {
  const snapshot = terminalMonitorSubjects.get(taskId);
  // 不是 monitor、或 subjects 为空：这条通知与 S2 无关
  if (!snapshot) return [];
  // 非终态通知**不消费快照**：monitor 的每条事件都是 `running`，它与终态通知会进同一批
  // （实测：`[{taskId, status:"running"}, {taskId, status:"completed"}]`）。先到的事件
  // 如果把快照吃掉，紧跟的终态通知就判不出 S2 —— 这个顺序缺陷实测让 R6 一直绿不了。
  if (!isTerminalStatus(status)) return [];
  // 一次送达只判一次：无论结果如何都删快照，重复调用是 no-op
  terminalMonitorSubjects.delete(taskId);
  // killed（到期 / task_stop）与 failed 不是「对象已成功终态」，不撤销
  if (status !== "completed") return [];
  const victims: string[] = [];
  for (const subject of snapshot.subjects) {
    victims.push(
      ...invalidateWakeups("subject_terminal", {
        subject,
        reasonText: `监控 ${taskId} 已完成（${subject}）`,
      }),
    );
  }
  return victims;
}

/**
 * 从唤醒 prompt 里抽取**已知实体**作为 subjects（S2 用）。
 *
 * `schedule_wakeup` 不新增参数（让模型管理 key 的方案已被 #642 §6.1 否决）。抽不到就为空，
 * S2 不生效、退回 S1——**这是优化而不是依赖**：抽错了最坏是没撤销，回到现状。
 *
 * R1 起规则本体搬到 `wait-subjects.ts`（三个入口共用一份），这里保留同名导出：
 * 唤醒只给自然语言（prompt），命令类规则对它无意义，调窄口径的入口就不会误抽。
 */
export function extractWaitSubjects(prompt: string): string[] {
  return extractNaturalLanguageSubjects(prompt);
}

/** 等待源的展示标签（回执 / 面板 / reminder 共用同一文案，避免三处漂移）。 */
export function describeWaitSource(src: WaitSource): string {
  const label = {
    agent: "子代理",
    workflow: "workflow",
    shell: "后台命令",
    monitor: "监控",
    wakeup: "定时唤醒",
  }[src.kind];
  return `${label} ${src.id}（${src.description}）`;
}

/**
 * 压缩摘要里的一行「当前等待」（T-W1-7）。
 *
 * 为什么要它：压缩会把对话换成摘要，模型从此看不到「我在等 monitor m7 盯 PR #662」。
 * 登记表在进程内、不受压缩影响（`listWaits()` 照常返回），但**模型的认知**受影响：
 * 压缩后它可能重复起一个盯同一对象的 monitor，或在 `task_stop` 前不知道自己还在等什么。
 * 所以压缩摘要生成时把当前等待源写进摘要正文——一次性的，不是每轮前缀，无缓存副作用。
 *
 * 标签复用 `describeWaitSource`（面板 / reminder / 回执三处共用的那一个），
 * 这里只补「最晚什么时候回报」的后半句，不新增第四份标签文案。
 *
 * @returns 一行文本；没有等待源时返回 `null`，调用方据此不输出这一行
 */
export function describeCurrentWaits(now = Date.now()): string | null {
  const waits = listWaits(now);
  if (waits.length === 0) return null;
  return `当前等待：${waits.map((w) => `${describeWaitSource(w)}${promiseTail(w)}`).join("；")}`;
}

/** 承诺的「什么时候回报」后缀（压缩摘要用；措辞与 todo-reminder 的等待行同形） */
function promiseTail(w: WaitSource): string {
  if (w.promise.kind === "deadline") {
    const d = new Date(w.promise.deadlineAt);
    const clock = [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map((n) => String(n).padStart(2, "0"))
      .join(":");
    return `，最晚 ${clock}`;
  }
  if (w.promise.kind === "terminal") return "，结束即通知";
  return "，退出或转入静默时通知";
}

/** 测试复位 */
export function __resetWaitRegistryForTest(): void {
  explicitWaits.clear();
  invalidatedIds.clear();
  pendingNotices.length = 0;
  terminalMonitorSubjects.clear();
  wakeupRegistrationEnabled = false;
  traceSink = null;
  monoNowImpl = () => performance.now();
}
