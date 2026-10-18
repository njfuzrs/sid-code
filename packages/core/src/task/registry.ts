/**
 * Task 注册表
 * 全局 Task 状态管理，提供注册、更新、查询、驱逐等原子操作
 */

import {
  type TaskState,
  type TaskStatus,
  isTerminalStatus,
  isPanelTask,
  isPanelVisible,
  isAgentTask,
} from "./types.ts";
import { getTaskOutputTail, evictTaskOutput } from "./disk-output.ts";
import {
  emitTaskLifecycle,
  getCompletedMainTurns,
  onMainTurnCompleted,
  recordTaskOutputTombstone,
  type TaskEvictReason,
} from "./lifecycle.ts";
import { getLogger } from "../debug/logger.ts";

/** 全局任务存储 */
const tasks = new Map<string, TaskState>();

/** 任务变更监听器集合（M5: 事件驱动 TUI 刷新） */
type TaskChangeCallback = () => void;
const changeListeners = new Set<TaskChangeCallback>();

/** 注册任务变更监听器 */
export function onTaskChanged(callback: TaskChangeCallback): void {
  changeListeners.add(callback);
}

/** 取消注册任务变更监听器 */
export function offTaskChanged(callback: TaskChangeCallback): void {
  changeListeners.delete(callback);
}

/** 通知所有监听器任务已变更 */
function notifyTaskChanged(): void {
  for (const cb of changeListeners) {
    try {
      cb();
    } catch {
      /* 监听器异常不应影响任务系统 */
    }
  }
}

/** 注册新任务 */
export function registerTask(task: TaskState): void {
  const isNew = !tasks.has(task.id);
  tasks.set(task.id, task);
  // S16：生命周期事件在 registry 单点发，不在 shell / agent / workflow 的 9 个写点各发一遍
  if (isNew) emitTaskLifecycle(task, "started");
  if (isTerminalStatus(task.status)) scheduleSafetyValveWake();
  notifyTaskChanged();
}

/** 原子性更新任务状态 */
export function updateTask<T extends TaskState>(taskId: string, updater: (task: T) => T): void {
  const task = tasks.get(taskId) as T | undefined;
  if (!task) return;
  const updated = updater(task);
  if (updated !== task) {
    tasks.set(taskId, updated);
    if (!isTerminalStatus(task.status) && isTerminalStatus(updated.status)) {
      emitTaskLifecycle(updated, "completed", {
        exit_code: "exitCode" in updated ? (updated.exitCode as number | undefined) : undefined,
      });
    }
    if (isTerminalStatus(updated.status)) scheduleSafetyValveWake();
    notifyTaskChanged();
  }
}

/** 查询任务 */
export function getTask(taskId: string): TaskState | undefined {
  return tasks.get(taskId);
}

/** 获取所有运行中的任务 */
export function getRunningTasks(): TaskState[] {
  return [...tasks.values()].filter((t) => t.status === "running");
}

/** 获取所有任务 */
export function getAllTasks(): TaskState[] {
  return [...tasks.values()];
}

/** 面板驻留时长（对齐 CC `framework.ts:28` PANEL_GRACE_MS = 30_000）。
 *
 *  S3 之后它**只管面板显示**，不再是 `.output` 的存活判据：任务完成后至少在面板上留这么久，
 *  给用户回看。文件能不能删由「送达回合」决定（见 `isEvictable`）。
 *
 *  曾设为 60s，注释自称"比 CC 更保守"——代价是用户反复报「后台任务面板不立即消失」
 *  （同一现象三次复发），故回到 30s。 */
const EVICT_GRACE_MS = 30_000;

/** 被终止（killed）任务的面板驻留时长（对齐 CC `framework.ts:25` STOPPED_DISPLAY_MS = 3_000）。
 *
 *  kill 是**用户自己刚下的指令**，他已经知道结果，条目留 3s 确认"确实停了"即可；
 *  completed/failed 是任务自己到达的终态，用户可能没在看屏幕，需要更长窗口回看。 */
const KILLED_DISPLAY_MS = 3_000;

/**
 * 完成通知**未送达**时的安全阀：任务完成后这么久仍未送达，照样驱逐（并写日志）。
 *
 * 送达不到的路径：主循环长时间不再转且空闲唤醒（#313）没接上；print 模式已退出。
 * 不设安全阀则 `.output` 无限堆积；去掉驱逐本身已在方案 §4 否决。
 * 10min 是占位值——应对照空闲唤醒的实际延迟再定，届时只改这一处。
 */
const UNDELIVERED_SAFETY_VALVE_MS = 10 * 60_000;

/** 按终态取面板驻留时长 */
function displayGraceFor(status: TaskStatus): number {
  return status === "killed" ? KILLED_DISPLAY_MS : EVICT_GRACE_MS;
}

/**
 * 从现在起算的续期截止时间（task_output 读取续期用）。
 *
 * 终态写入点**不再**调用它：S3 之前 9 个写点各自写死 `evictAfter`，判据散落、且计时起点是
 * 「入队」而不是「送达」。现在终态写点只记 `endTime`，驱逐判据统一在 `isEvictable` 里算。
 */
export function graceDeadlineFor(status: TaskStatus): number {
  return Date.now() + displayGraceFor(status);
}

/**
 * 驱逐判据（S3：按回合判定，不按毫秒）。`hasPendingEviction` 与安全阀定时器都走它，
 * 三处同口径——不同口径会让 1s 定时器对未送达任务空转整个安全阀时长。
 *
 * - 非终态 / 终态但完成信息还没有投递通道（`notified=false`）→ 不删；
 * - 已送达 → 送达之后主循环又**完整跑完至少一个回合**，且面板驻留期与 task_output 续期都已过；
 * - 未送达 → 完成后过了安全阀时长。
 */
/**
 * 「已送达，且送达之后主循环又完整跑完至少一个回合」——驱逐判据里**只看回合**的那一半。
 *
 * `evictDecision` 与 `hasPendingEviction` 都调它（L3）：此前后者手抄一份条件，只是同口径
 * 而非同源，改一处忘一处就会让 1s 定时器与真实驱逐判据分叉。
 */
function deliveredTurnPassed(task: TaskState): boolean {
  return (
    isTerminalStatus(task.status) &&
    task.notified &&
    task.notificationDeliveredTurn !== undefined &&
    getCompletedMainTurns() > task.notificationDeliveredTurn
  );
}

function evictDecision(task: TaskState, now: number): TaskEvictReason | null {
  if (!isTerminalStatus(task.status) || !task.notified) return null;
  const end = task.endTime ?? 0;
  if (task.notificationDeliveredTurn !== undefined) {
    if (!deliveredTurnPassed(task)) return null;
    const deadline = Math.max(end + displayGraceFor(task.status), task.evictAfter ?? 0);
    return deadline <= now ? "delivered_turn_passed" : null;
  }
  return end + UNDELIVERED_SAFETY_VALVE_MS <= now ? "safety_valve" : null;
}

/** 驱逐一条任务：登记墓碑（须在删文件之前）→ 落事件 → 删磁盘 `.output` 与 registry 条目 */
function evictOne(id: string, task: TaskState, reason: TaskEvictReason): void {
  recordTaskOutputTombstone(task, reason);
  emitTaskLifecycle(task, "evicted", { reason });
  if (reason === "safety_valve") {
    getLogger().warn(
      "TASK",
      `后台任务 ${id} 完成 ${Math.round((Date.now() - (task.endTime ?? 0)) / 1000)}s 仍未送达模型，按安全阀驱逐`,
    );
  }
  evictTaskOutput(id);
  tasks.delete(id);
}

/** 驱逐满足 `evictDecision` 的终态任务；删除发生时通知监听器刷新 TUI（否则面板不会重渲）。
 *
 *  曾有 `force` 参数（忽略缓冲期），生产代码零调用方，S3 一并删除——它恰好能绕过
 *  「送达之后至少一个回合」这道门，留着就是一个随手就能重演 S3 的开关。 */
export function evictTerminalTasks(): void {
  const now = Date.now();
  let evicted = false;
  for (const [id, task] of tasks) {
    const reason = evictDecision(task, now);
    if (reason) {
      evictOne(id, task, reason);
      evicted = true;
    }
  }
  if (evicted) notifyTaskChanged();
  scheduleSafetyValveWake();
}

/**
 * 标记这些任务的完成通知**已送达模型**（`injectPendingNotifications` 在通知进上下文时调用）。
 *
 * 只认 registry 里还在的**终态**任务；重复送达（同一 taskId 两条通知）保留第一次的回合，
 * 否则驱逐会被一条迟到的重复通知无限推后。
 *
 * B2：终态检查必须在这里做，不能只靠注释。shell 停滞检测会给**运行中**的任务入队一条
 * 「疑似在等输入」通知（带 taskId）。旧实现不看 status，这条通知一注入，运行中任务就记下
 * 送达回合；任务之后完成时送达回合早已过，面板驻留期一到就删 `.output`，而真正的完成
 * 通知还在队列里——S3 事故原样重演。调用侧也按通知自身的 status 过滤了一遍，两道都留。
 */
export function markNotificationsDelivered(taskIds: Iterable<string>): void {
  const turn = getCompletedMainTurns();
  let changed = false;
  for (const id of taskIds) {
    const task = tasks.get(id);
    if (!task || task.notificationDeliveredTurn !== undefined) continue;
    if (!isTerminalStatus(task.status)) continue;
    const updated = { ...task, notificationDeliveredTurn: turn };
    tasks.set(id, updated);
    emitTaskLifecycle(updated, "delivered");
    changed = true;
  }
  if (changed) notifyTaskChanged();
}

// 回合推进可能让「已送达」的任务变为可驱逐：刷新监听器，TUI 据此重新判定 1s 定时器开关。
onMainTurnCompleted(() => {
  for (const task of tasks.values()) {
    if (task.notificationDeliveredTurn !== undefined && isTerminalStatus(task.status)) {
      notifyTaskChanged();
      return;
    }
  }
});

/**
 * 安全阀唤醒：未送达任务的驱逐不能指望 TUI 的 1s 定时器（那会让定时器空转 10min），
 * 也不能指望主循环（安全阀要兜的恰恰是「主循环不转了」）。这里只挂一个 unref 定时器，
 * 定在最早的那个安全阀截止点，到点直接驱逐——print 模式下也成立。
 */
let safetyValveTimer: ReturnType<typeof setTimeout> | null = null;
let safetyValveAt = Infinity;

function scheduleSafetyValveWake(): void {
  let earliest = Infinity;
  for (const task of tasks.values()) {
    if (
      isTerminalStatus(task.status) &&
      task.notified &&
      task.notificationDeliveredTurn === undefined
    ) {
      earliest = Math.min(earliest, (task.endTime ?? 0) + UNDELIVERED_SAFETY_VALVE_MS);
    }
  }
  if (earliest === safetyValveAt) return;
  if (safetyValveTimer) clearTimeout(safetyValveTimer);
  safetyValveTimer = null;
  safetyValveAt = earliest;
  if (earliest === Infinity) return;
  const timer = setTimeout(
    () => {
      safetyValveTimer = null;
      safetyValveAt = Infinity;
      evictTerminalTasks();
    },
    Math.max(0, earliest - Date.now()),
  );
  (timer as { unref?: () => void }).unref?.();
  safetyValveTimer = timer;
}

/** 获取驱逐相关常量（供外部使用） */
export { EVICT_GRACE_MS, KILLED_DISPLAY_MS, UNDELIVERED_SAFETY_VALVE_MS };

/**
 * 手动把一条**终态**任务从面板划掉（Ctrl+X），面板立即不再显示它。
 *
 * 对标 cc `stopOrDismissAgent`（`state/teammateViewHelpers.ts:116`）的 dismiss 分支。
 *
 * 三条设计约束：
 * 1. **只对终态任务生效**。运行中任务的 Ctrl+X 语义是"终止"（由调用方 App.tsx 分派到
 *    kill，与 cc 的 context-sensitive x 一致），不是"划掉"——把还在跑的任务从面板划掉
 *    会造成"任务不见了却还在烧 token"的黑盒，比不消失更糟。
 * 2. **不立刻删任务**，只置 `dismissed` 让面板不显示。任务本体与磁盘输出留给正常驱逐路径
 *    （`evictTerminalTasks`）按缓冲期回收——用户划掉的是"屏幕上这一行"，不是
 *    "task_output 还能不能查到它"。主循环模型可能正要读这个 taskId 的结果。
 * 3. **幂等**：已 dismissed 再调用不重复 notify（`updateTask` 靠引用相等短路）。
 *
 * @returns 是否真的划掉了（非终态 / 任务不存在 / 已划掉 → false，调用方可据此决定是否提示）
 */
export function dismissTask(taskId: string): boolean {
  const task = tasks.get(taskId);
  if (!task) return false;
  if (!isTerminalStatus(task.status)) return false;
  if (task.dismissed) return false;
  updateTask(taskId, (t) => ({ ...t, dismissed: true }));
  return true;
}

/**
 * 把当前面板上**所有终态任务**一次划掉，返回划掉的条数。
 *
 * 这是 Ctrl+X 无选中态时的批量出口：本项目的面板是**只读列表**（没有 cc 那套
 * 面板内光标 / `viewingAgentTaskId` 选中态），逐条 dismiss 无从指定"哪一条"。
 * 语义上等价于"这些我都看过了，清掉"——因此只清终态、绝不碰 running（约束 1 同款）。
 */
export function dismissTerminalTasks(): number {
  let n = 0;
  for (const [id, task] of tasks) {
    if (isTerminalStatus(task.status) && !task.dismissed && isPanelTask(task)) {
      updateTask(id, (t) => ({ ...t, dismissed: true }));
      n++;
    }
  }
  return n;
}

/** 面板当前是否有可划掉的终态条目（供 Ctrl+X 判断是否 no-op、放行给输入框）。
 *  与 dismissTerminalTasks 同口径，否则会出现"提示划掉了 N 条、实际 0 条"的不一致。 */
export function hasDismissableTasks(): boolean {
  for (const task of tasks.values()) {
    if (isTerminalStatus(task.status) && !task.dismissed && isPanelTask(task)) return true;
  }
  return false;
}

/** 面板可见任务（经 isPanelVisible：后台任务 && 未被用户划掉）。TUI state-bridge 的唯一入口。 */
export function getPanelVisibleTasks(): TaskState[] {
  return [...tasks.values()].filter(isPanelVisible);
}

/**
 * registry 里是否有**只差墙钟时间**就能驱逐的任务（供 TUI 的 1s 驱逐 tick 判断是否要开定时器）。
 *
 * 与 `evictDecision` 同口径（S3）：只有「已送达且送达回合已过」的任务才只差时间——剩下的
 * 至多是面板驻留期 / task_output 续期。还没过送达回合的任务等的是回合推进，回合推进时
 * registry 会通知监听器、让本函数被重新问一次；未送达的任务由安全阀定时器兜底。两者都不需要
 * 1s 定时器空转。
 *
 * 为什么问 registry 而不是问面板列表（这曾是个真实的资源泄漏）：被 Ctrl+X 划掉的任务立即离开
 * 面板，但**仍在 registry 里**等回收。按面板判断 → 划完最后一条定时器就停 → registry 条目与
 * 磁盘 `.output` 再没人回收。所以 dismissed 任务同样计入。
 */
export function hasPendingEviction(): boolean {
  for (const task of tasks.values()) {
    if (deliveredTurnPassed(task)) return true;
  }
  return false;
}

/** 清理所有任务（会话结束时调用）。
 *  连带清 outputs 内存条目 + 磁盘 .output 文件，并通知监听器刷新面板——
 *  仅 tasks.clear() 会留下 outputs 孤儿（disk-output 的 Map 与磁盘文件不随之清理）。 */
export function clearAllTasks(): void {
  for (const [id, task] of tasks) {
    if (isTerminalStatus(task.status)) {
      // L2：删文件之前留墓碑，之后再读 `.output` 拿到的是「被清理」而不是泛化的「不存在」
      recordTaskOutputTombstone(task, "cleared");
      emitTaskLifecycle(task, "evicted", { reason: "cleared" });
    }
    evictTaskOutput(id);
  }
  tasks.clear();
  scheduleSafetyValveWake();
  notifyTaskChanged();
}

/** 清理非运行态任务（/clear 时调用）。
 *  /clear 重置的是「当前会话上下文」，不应杀掉用户正在跑的后台 agent；
 *  但已完成/失败/被杀的旧任务条目若不清，会残留在面板上（getConversationClearedPatch
 *  只清 UI 快照 tasks:[]，registry Map 不清 → 下次 notifyTaskChanged 旧条目复活）。
 *  故只驱逐终止态任务（不论是否 notified），保留 running。 */
export function clearInactiveTasks(): void {
  let cleared = false;
  for (const [id, task] of tasks) {
    if (isTerminalStatus(task.status)) {
      recordTaskOutputTombstone(task, "cleared"); // L2：同 clearAllTasks，须在删文件之前
      emitTaskLifecycle(task, "evicted", { reason: "cleared" });
      evictTaskOutput(id);
      tasks.delete(id);
      cleared = true;
    }
  }
  if (cleared) {
    scheduleSafetyValveWake();
    notifyTaskChanged();
  }
}

/** 生成任务状态附件（注入系统提示词，包含运行中 Agent 的增量输出）。
 *
 *  经 isPanelTask 单一闸门（见 types.ts）：只报**后台**任务。前台子代理也在 registry
 *  （taskId / 磁盘输出 / task_output 依赖它），但它是模型当前这一轮自己发起的同步工具调用，
 *  结果会作为 tool_result 回到上下文——再以 `<task-statuses>` 报一遍，模型会误以为
 *  "另有一个后台任务在跑"，进而去 task_output 轮询一个根本不需要轮询的任务。 */
export async function generateTaskStatusAttachment(): Promise<string | null> {
  const running = getRunningTasks().filter(isPanelTask);
  if (running.length === 0) return null;

  const lines = ["<task-statuses>"];
  for (const task of running) {
    lines.push(`  <task id="${task.id}" type="${task.type}" status="${task.status}">`);
    lines.push(`    <description>${task.description}</description>`);
    if (isAgentTask(task) && task.progress) {
      const p = task.progress;
      lines.push(`    <progress tools="${p.toolUseCount}" tokens="${p.tokenCount}">`);
      if (p.lastActivity) {
        lines.push(
          `      <last-activity>${p.lastActivity.toolName}: ${p.lastActivity.activityDescription || ""}</last-activity>`,
        );
      }
      lines.push(`    </progress>`);

      // 进度摘要（M5 opt-in）
      if (task.progressSummary) {
        lines.push(`    <progress-summary>${task.progressSummary}</progress-summary>`);
      }

      // 增量输出：获取最近输出片段（最多 500 字符）
      try {
        const tail = await getTaskOutputTail(task.id, 500);
        if (tail) {
          const trimmed = tail.slice(-500).replace(/<\/?[^>]+(>|$)/g, ""); // 防 XML 注入
          lines.push(`    <recent-output>${trimmed}</recent-output>`);
        }
      } catch {
        // 输出文件可能还不存在，忽略
      }
    }
    lines.push(`  </task>`);
  }
  lines.push("</task-statuses>");
  return lines.join("\n");
}
