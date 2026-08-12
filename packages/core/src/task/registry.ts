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
  tasks.set(task.id, task);
  notifyTaskChanged();
}

/** 原子性更新任务状态 */
export function updateTask<T extends TaskState>(taskId: string, updater: (task: T) => T): void {
  const task = tasks.get(taskId) as T | undefined;
  if (!task) return;
  const updated = updater(task);
  if (updated !== task) {
    tasks.set(taskId, updated);
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

/** 驱逐缓冲期（对齐 CC `framework.ts:28` PANEL_GRACE_MS = 30_000）。
 *  任务完成后必须等待此时长才能被驱逐，给主循环模型留足通过 task_output 查询结果的窗口。
 *
 *  曾设为 60s，注释自称"比 CC 更保守"——但保守参数不是免费的，代价是用户反复报
 *  「后台任务面板不立即消失」（同一现象三次复发）。缓冲期本就有 task_output 的
 *  访问续期（`tool/task-output.ts` 的 LRU touch）兜底：模型真在轮询就会不断顺延，
 *  加倍基础窗口对"模型多轮决策"没有额外收益，只是让没人再看的条目多驻留 30s。 */
const EVICT_GRACE_MS = 30_000;

/** 被终止（killed）任务的驻留时长（对齐 CC `framework.ts:25` STOPPED_DISPLAY_MS = 3_000）。
 *
 *  为什么 killed 要单独一档、不跟 completed/failed 共用 30s：kill 是**用户自己刚下的指令**，
 *  他已经知道结果，条目留着只是确认"确实停了"，3s 足够；completed/failed 是任务自己到达的
 *  终态，用户可能没在看屏幕，需要更长窗口回看。`TaskRow` 早已给四种终态不同字形/配色
 *  （运行◐ / 完成● / 失败✘ / 终止⊘），驻留时长却一刀切 30s —— 视觉分级与生命周期分级
 *  不一致，这里补齐。 */
const KILLED_DISPLAY_MS = 3_000;

/**
 * 按终态选驱逐缓冲期：killed 用 3s，其余（completed/failed）用 30s。
 *
 * 所有设置 `evictAfter` 的终态写入点都该走这个函数，别在各自的 `updateTask` 里
 * 直接写 `Date.now() + EVICT_GRACE_MS`——那正是"字形上区分了四态、时长上没区分"的来源，
 * 且散落 8 处（agent / shell / workflow × complete/fail/kill），漏一处就是行为漂移。
 */
export function graceDeadlineFor(status: TaskStatus): number {
  return Date.now() + (status === "killed" ? KILLED_DISPLAY_MS : EVICT_GRACE_MS);
}

/** 驱逐已完成且已通知且缓冲期已过的任务。
 *  终止态（completed/failed/killed）任务一旦其完成通知已入队（notified=true）
 *  且缓冲期（evictAfter）已过，在面板上即属冗余——通知会经 dequeuePendingNotifications
 *  注入对话，任务条目应清除。三层门控对标 CC：① isTerminalStatus ② notified ③ evictAfter。
 *  删除发生时通知监听器刷新 TUI（否则面板不会重渲、仍显示已完成条目）。
 *
 *  @param force 忽略缓冲期（evictAfter）检查，只要求 ① isTerminalStatus ② notified。
 *    缓冲期的意义是"任务完成后留一个窗口，让主循环模型还能用 task_output 查结果"——
 *    但当主循环已经终止（end_turn 收尾）时不会再有下一轮查询，缓冲期失去意义。此时
 *    必须 force 驱逐，否则"最后完成、缓冲期还没到"的任务会因再无下一轮循环触发驱逐而
 *    永久残留在面板（现象：「后台任务 · N 已完成」不消失）。见 loop.ts 收尾块调用点。 */
export function evictTerminalTasks(force = false): void {
  const now = Date.now();
  let evicted = false;
  for (const [id, task] of tasks) {
    if (
      isTerminalStatus(task.status) &&
      task.notified &&
      (force || (task.evictAfter ?? 0) <= now) // 缓冲期检查：force 时跳过；未设置视为 0（兼容旧任务立即驱逐）
    ) {
      evictTaskOutput(id); // 连带清磁盘 .output 文件 + 内存 outputs 条目，避免孤儿泄露
      tasks.delete(id);
      evicted = true;
    }
  }
  if (evicted) notifyTaskChanged();
}

/** 获取驱逐缓冲期常量（供外部使用） */
export { EVICT_GRACE_MS, KILLED_DISPLAY_MS };

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
 * registry 里是否还有**等待驱逐**的终态任务（供 TUI 的 1s 驱逐 tick 判断是否要开定时器）。
 *
 * 为什么不能用「面板上有没有终态条目」来判断（这曾是个真实的资源泄漏）：
 * 被 Ctrl+X 划掉的任务立即离开面板，但**仍在 registry 里**等缓冲期到点回收。若定时器的
 * 开关条件读的是面板列表，划完最后一条 → 面板空 → 定时器停 → 这些任务的 registry 条目
 * 与磁盘 `.output` 文件再没人回收，直到会话结束。所以开关必须问 registry，不是问 UI。
 *
 * 同理也包含 dismissed 任务：它们照样要被 evictTerminalTasks 清掉，只是用户看不见了。
 */
export function hasPendingEviction(): boolean {
  for (const task of tasks.values()) {
    if (isTerminalStatus(task.status) && task.notified) return true;
  }
  return false;
}

/** 清理所有任务（会话结束时调用）。
 *  连带清 outputs 内存条目 + 磁盘 .output 文件，并通知监听器刷新面板——
 *  仅 tasks.clear() 会留下 outputs 孤儿（disk-output 的 Map 与磁盘文件不随之清理）。 */
export function clearAllTasks(): void {
  for (const id of tasks.keys()) {
    evictTaskOutput(id);
  }
  tasks.clear();
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
      evictTaskOutput(id);
      tasks.delete(id);
      cleared = true;
    }
  }
  if (cleared) notifyTaskChanged();
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
