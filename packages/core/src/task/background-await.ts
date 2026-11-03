/**
 * 「在跑」≠「值得等」：后台任务的等待口径 + 空闲主循环的唤醒保证。
 *
 * ## 要解决的事故（20261103-130950-00ef059c）
 *
 * 模型 `run_in_background` 起了一个常驻假服务器（`bun run fake-glm-server.ts`），e2e 跑完后
 * 一句「现在核对写入磁盘的违例记录。」就 end_turn，清单还剩 2 项。todo 闸门 T2 看到「有运行中
 * 后台任务」→ 放行、不续跑，理由是「后台任务完成时通知会把循环叫醒」。可 shell 任务只在
 * **退出 / 被 kill / 卡在交互提示**时才入队通知，常驻服务三者都不沾——永远不会有那条通知，
 * 会话看着像已完成，面板上一直转着「1 运行中」。
 *
 * 所有「有后台任务就别催 / 别退」的判断（T2、promise-nudge、停滞阶梯、headless 等待）共享同一个
 * 隐含前提：**它会回报**。子代理 / workflow 天然满足（终态必入队通知）；后台 shell 不满足。
 *
 * ## 两条机制，缺一不可
 *
 * 1. **等待口径**（`isAwaitedBackgroundTask`）：后台 shell 连续 `SHELL_QUIESCENT_MS` 没有新输出，
 *    记为「静默」，不再算作「值得等的结果」。常驻服务、挂住的命令都落在这里；harness 无法替它们
 *    承诺「会回报」，所以不能拿它们豁免收尾闸门、也不能让 headless 为它们无限期挂着。
 * 2. **唤醒保证**（`endMainLoopTurn` + `takeQuiescentWake`）：主循环收尾时，把当时**仍值得等**的
 *    shell 任务登记下来；之后其中任一个转入静默，由 shell 看门狗投一条 running 通知，把空闲的
 *    主循环叫醒重判。于是「因为后台任务而放行」之后，**一定**会有下一次唤醒：要么任务退出
 *    （既有通知），要么它静默（本模块）。只登记收尾那一刻在等的任务：主循环忙时就已静默的，
 *    收尾判定已经按「不值得等」处理过，再唤醒一次是噪声。
 *
 * 为什么不按命令文本识别「常驻服务」（`bun run server` / `npm run dev`…）：词表永远列不全，
 * 漏一个就是同一个死等；而「长时间无输出」是可观测的行为事实，与命令怎么写无关。
 *
 * 代价（更准 ↔ 更省）：静默但最终会退出的长命令（不打日志的构建、`sleep 600 && …`）会多一次
 * 唤醒轮；它退出时照常有完成通知。
 */

import { getRunningTasks } from "./registry.ts";
import { isPanelTask, isShellTask, type TaskState } from "./types.ts";

/**
 * 后台 shell 连续多久没有新输出算「静默」。
 *
 * 取 60s：比 shell 停滞检测的 45s（`STALL_THRESHOLD_MS`，「卡在交互提示」）略长——那条判据管
 * 「在等用户输入」，这条管「不会自己回报」，后者误判的代价是多一轮模型调用，宁可晚一点。
 */
export const SHELL_QUIESCENT_MS = 60_000;

interface ShellActivity {
  lastSize: number;
  lastGrowth: number;
}

/** 每个后台 shell 任务最近一次输出增长的时刻（由 shell 看门狗每 5s 喂一次） */
const shellActivity = new Map<string, ShellActivity>();

/** 主循环收尾时仍值得等、尚未发过静默唤醒的 shell 任务 */
const pendingWakeIds = new Set<string>();

/** 正在运行的主循环数（queryLoop 入口 +1、finally −1；正常只有 0/1） */
let activeMainLoops = 0;

/** 登记一个刚起跑的 shell 任务（起跑即算一次「有动静」，新任务不会立刻被判静默） */
export function trackShellActivity(taskId: string, initialSize = 0, now = Date.now()): void {
  shellActivity.set(taskId, { lastSize: initialSize, lastGrowth: now });
}

/** 喂一次输出字节数。字节数是单调的，增长即「有动静」（同 stall 检测的 F4 口径） */
export function recordShellOutputSize(taskId: string, size: number, now = Date.now()): void {
  const a = shellActivity.get(taskId);
  if (!a) {
    shellActivity.set(taskId, { lastSize: size, lastGrowth: now });
    return;
  }
  if (size > a.lastSize) {
    a.lastSize = size;
    a.lastGrowth = now;
  }
}

/** 任务终态后清掉跟踪（看门狗收尾时调用） */
export function forgetShellActivity(taskId: string): void {
  shellActivity.delete(taskId);
  pendingWakeIds.delete(taskId);
}

/** 该 shell 任务已连续静默多久（未跟踪的返回 0 = 视为刚有动静，不误判） */
export function shellSilentForMs(taskId: string, now = Date.now()): number {
  const a = shellActivity.get(taskId);
  return a ? Math.max(0, now - a.lastGrowth) : 0;
}

/**
 * 这个任务是否「值得等」：运行中的后台任务里，排除已静默的 shell。
 * 子代理 / workflow 一律值得等——它们的终态必然入队通知（agent-task / workflow-task）。
 */
export function isAwaitedBackgroundTask(task: TaskState, now = Date.now()): boolean {
  if (task.status !== "running" || !isPanelTask(task)) return false;
  if (isShellTask(task)) return shellSilentForMs(task.id, now) < SHELL_QUIESCENT_MS;
  return true;
}

/** 是否有值得等的后台任务——「有后台任务就别催 / 别退」类判断统一走这里 */
export function hasAwaitedBackgroundTasks(now = Date.now()): boolean {
  return getRunningTasks().some((t) => isAwaitedBackgroundTask(t, now));
}

/** queryLoop 入口调用：主循环开始干活，此前登记的待唤醒清单作废（新的一轮会自己看到任务状态） */
export function beginMainLoopTurn(): void {
  activeMainLoops++;
  pendingWakeIds.clear();
}

/**
 * queryLoop 收尾（finally）调用：主循环即将空闲，登记此刻仍值得等的后台 shell。
 * 之后它们转入静默时由 `takeQuiescentWake` 放出唤醒。
 */
export function endMainLoopTurn(now = Date.now()): void {
  activeMainLoops = Math.max(0, activeMainLoops - 1);
  if (activeMainLoops > 0) return;
  pendingWakeIds.clear();
  for (const t of getRunningTasks()) {
    if (isShellTask(t) && isAwaitedBackgroundTask(t, now)) pendingWakeIds.add(t.id);
  }
}

/**
 * shell 看门狗每次 tick 调用：主循环空闲、该任务在收尾时被登记为「在等」、且现在已静默
 * → 返回 true（并消费登记，同一次等待只唤醒一次）。
 */
export function takeQuiescentWake(taskId: string, now = Date.now()): boolean {
  if (activeMainLoops > 0 || !pendingWakeIds.has(taskId)) return false;
  if (shellSilentForMs(taskId, now) < SHELL_QUIESCENT_MS) return false;
  pendingWakeIds.delete(taskId);
  return true;
}

/** 静默唤醒通知的摘要（进 <task-notification> 的 summary，模型据此决定下一步） */
export function describeQuiescentWake(display: string, silentMs: number): string {
  const secs = Math.round(silentMs / 1000);
  return (
    `命令 "${display.slice(0, 60)}" 仍在运行，但已 ${secs}s 没有新输出，不会再自动回报。` +
    `若它是你启动的常驻服务（服务器 / watch），请继续推进剩余工作，用完后用 task_stop 停掉；` +
    `若你确实在等它的结果，说明在等什么——它退出时仍会通知你。`
  );
}

/** 测试复位 */
export function __resetBackgroundAwaitForTest(): void {
  shellActivity.clear();
  pendingWakeIds.clear();
  activeMainLoops = 0;
}
