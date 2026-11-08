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
import { getTask, getRunningTasks } from "./registry.ts";
import { isAwaitedBackgroundTask } from "./background-await.ts";
import { isAgentTask, isPanelTask, isShellTask, isWorkflowTask, type TaskState } from "./types.ts";
import { getScheduler } from "../cron/scheduler.ts";
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
  emitWaitTrace("WaitReleased", {
    id,
    kind: entry.src.kind,
    reason,
    held_ms: Math.max(0, Date.now() - entry.src.registeredAt),
  });
  return true;
}

/** 会话结束：全部释放（并发 `WaitReleased{reason:"session_end"}`，便于对账）。 */
export function releaseAllWaits(reason: WaitReleaseReason = "session_end"): number {
  const ids = [...explicitWaits.keys()];
  for (const id of ids) releaseWait(id, reason);
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
    if (entry.src.kind !== "wakeup" && !getTask(id)) releaseWait(id, "terminal");
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

/** 按等待对象签名找等待源（S2 / PR 3 的 monitor 用）。 */
export function findWaitBySubject(subject: string, now = Date.now()): WaitSource | undefined {
  return listWaits(now).find((w) => w.subjects?.includes(subject));
}

/** 显式登记项是否仍有效。 */
function isExplicitWaitValid(entry: WaitEntry, now: number): boolean {
  const { src } = entry;
  if (src.kind === "wakeup") {
    // 唤醒不在 task registry，在调度器：任务还在 + 没被替换（F2）
    const scheduler = getScheduler();
    if (!scheduler.getSessionTask(src.id)) return false;
    if (scheduler.isSuperseded(src.id)) return false;
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
 * 只对进程类（shell / monitor）做：唤醒的到期由调度器与注入路径负责，它 fire 后
 * 就从 `sessionTasks` 里消失，在这里判「过期」会把一次正常触发误报成承诺违背。
 */
function sweepExpiredWaits(): void {
  const nowMono = monoNow();
  for (const [id, entry] of [...explicitWaits]) {
    if (entry.src.kind === "wakeup") continue;
    if (entry.src.promise.kind !== "deadline" || entry.deadlineMono === undefined) continue;
    if (nowMono < entry.deadlineMono + DEADLINE_GRACE_MS) continue;

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
      `等待源 ${id}（${entry.src.description}）期限已过 ${DEADLINE_GRACE_MS / 1000}s 宽限仍未回报，判为承诺违背`,
    );
    const task = getTask(id);
    enqueueTaskNotification({
      taskId: id,
      toolUseId: task?.toolUseId,
      outputFile: task?.outputFile ?? "",
      status: "failed",
      summary: `等待「${entry.src.description}」的期限已过仍未收到任何回报（承诺被违背）。请确认它是否还在运行，必要时重新安排。`,
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
  const victims: string[] = [];
  for (const [id, entry] of [...explicitWaits]) {
    if (entry.src.kind !== "wakeup") continue;
    if (signal === "subject_terminal") {
      if (!opts.subject || !entry.src.subjects?.includes(opts.subject)) continue;
    }
    scheduler.removeTask(id);
    releaseWait(id, "invalidated");
    emitScheduledTrace(SCHEDULED_INVALIDATED_EVENT_NAME, { task_id: id, signal });
    victims.push(id);
  }
  for (const id of victims) {
    pendingNotices.push({ kind: "wakeup_invalidated", taskId: id, reason: opts.reasonText });
  }
  return victims;
}

/**
 * 从唤醒 prompt 里抽取**已知实体**作为 subjects（S2 用）。
 *
 * `schedule_wakeup` 不新增参数（让模型管理 key 的方案已被 #642 §6.1 否决）。抽不到就为空，
 * S2 不生效、退回 S1——**这是优化而不是依赖**：抽错了最坏是没撤销，回到现状。
 */
export function extractWaitSubjects(prompt: string): string[] {
  const out = new Set<string>();
  for (const m of prompt.matchAll(/\bPR\s*#?\s*(\d+)/gi)) out.add(`gh:pr:${m[1]}`);
  for (const m of prompt.matchAll(/\bpull\/(\d+)/gi)) out.add(`gh:pr:${m[1]}`);
  for (const m of prompt.matchAll(/\bruns?[/\s]\s*(\d{6,})/gi)) out.add(`gh:run:${m[1]}`);
  return [...out];
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

/** 测试复位 */
export function __resetWaitRegistryForTest(): void {
  explicitWaits.clear();
  invalidatedIds.clear();
  pendingNotices.length = 0;
  wakeupRegistrationEnabled = false;
  traceSink = null;
  monoNowImpl = () => performance.now();
}
