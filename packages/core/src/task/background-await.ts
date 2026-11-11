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
 *
 * ## 第三件事：自己会回报的任务不叠静默唤醒（N4，事故 20261109-191904-962011a6）
 *
 * 上面两条机制口径必须一致，否则会自己打自己：`isAwaitedBackgroundTask` 把「输出憋到退出」
 * 和「声明了 `wait_until_seconds`」判成**值得等**（它们退出 / 到期时必有通知），于是
 * `endMainLoopTurn` 把它们登记进 `pendingWakeIds`；60s 后 `takeQuiescentWake` 又只看静默时长，
 * 放出一条「已静默、不会再自动回报」的通知。模型收到这句话只能自己前台去查——那次会话连查
 * 32 次、8.45M 输入 token。
 *
 * 所以「值得等」的两类在唤醒器里也要短路（`reportsOnItsOwn`）：它们有确定回报，不需要静默兜底。
 * 常驻服务（静默且永不退出）不在此列，仍走静默唤醒——20261103 事故的修复不能回退。
 */

import { getRunningTasks, getTask } from "./registry.ts";
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

/**
 * 「该 shell 任务有显式期限承诺」（`wait_until_seconds` 那种）的判定。
 *
 * 由 `wait-registry.ts` 在加载时注入，而不是本模块直接 import 它：那边已经反向依赖本模块的
 * `isAwaitedBackgroundTask`（登记表要逐字复用「值得等」的口径），直接 import 会成环。
 *
 * 默认恒 false = 「没有登记表信息」，退回改动前的纯静默口径。这个默认值**不能**换成 true：
 * 那等于把所有静默 shell 都当成有期限承诺，20261103 事故（常驻服务死等）会复发。
 */
let hasDeadlineWait: (taskId: string) => boolean = () => false;

/** 注入「该 id 是否有 deadline 期限承诺」的判定（生产由 wait-registry 调用；传 null 复位） */
export function setDeadlineWaitPredicate(fn: ((taskId: string) => boolean) | null): void {
  hasDeadlineWait = fn ?? (() => false);
}

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

/** 读完上游全部输入才吐结果的命令：放在管道末尾时，整条命令退出前不会有任何输出 */
const BUFFER_UNTIL_EOF_COMMANDS = new Set(["tail", "sort", "wc", "tac"]);

/**
 * 命令的输出是否**按结构**必然憋到退出才出现（`bun test 2>&1 | tail -60` 这类）。
 *
 * 事故 20261106-101611-d0a96bc1：后台全量测试 `… | tail -60` 跑了 7 分钟，前 60s 后就被
 * 静默口径判成「不会回报」——于是 todo 闸门 T2 不再放行、强推模型续跑（02:49:30
 * `running_background_tasks=false` → `todo_gate_retry`），模型无事可做，6 分钟里 71 次
 * `bg_task_list`，最后自己 `task_stop` 杀掉了测试。这类命令静默是**预期**的，它退出时照常
 * 有完成通知，不是常驻服务。
 *
 * 与文件头「不按命令文本识别常驻服务」不冲突：那里拒绝的是**猜**「哪些命令不会退出」（词表
 * 列不全）；这里识别的是 shell 语义上确定的事实——末段是读到 EOF 才输出的命令。漏判的后果
 * 只是退回静默口径（今天的行为），不会多出新的死等。
 * `tail -f/-F/--follow` 是流式的，不在此列。
 */
export function outputBufferedUntilExit(command: string): boolean {
  // 只看最后一段管道；`||` 先替换掉，免得被当成管道切开
  const segments = command.replace(/\|\|/g, "\u0000").split("|");
  if (segments.length < 2) return false;
  const last = segments[segments.length - 1]!.split(/[;&\u0000]/)[0]!.trim();
  const words = last.split(/\s+/).filter(Boolean);
  const name = words[0]?.split("/").pop();
  if (!name || !BUFFER_UNTIL_EOF_COMMANDS.has(name)) return false;
  if (
    name === "tail" &&
    words.some((w) => /^-[^-]*[fF]/.test(w) || w === "--follow" || w.startsWith("--follow="))
  ) {
    return false;
  }
  return true;
}

/**
 * 这个任务是否「值得等」：运行中的后台任务里，排除已静默的 shell。
 * 子代理 / workflow 一律值得等——它们的终态必然入队通知（agent-task / workflow-task）。
 * 输出按结构憋到退出的 shell（见 `outputBufferedUntilExit`）不受静默口径影响。
 */
export function isAwaitedBackgroundTask(task: TaskState, now = Date.now()): boolean {
  if (task.status !== "running" || !isPanelTask(task)) return false;
  if (isShellTask(task)) {
    if (outputBufferedUntilExit(task.command ?? "")) return true;
    return shellSilentForMs(task.id, now) < SHELL_QUIESCENT_MS;
  }
  return true;
}

/** 是否有值得等的后台任务——「有后台任务就别催 / 别退」类判断统一走这里 */
export function hasAwaitedBackgroundTasks(now = Date.now()): boolean {
  return getRunningTasks().some((t) => isAwaitedBackgroundTask(t, now));
}

/**
 * 这个 shell 任务会不会**自己**回报（退出 / 到期都有通知），不需要静默唤醒兜底。
 *
 * 两类，恰好是 `isAwaitedBackgroundTask` 判「值得等」时不看静默时长的那两类：
 * - 输出按结构憋到退出（`outputBufferedUntilExit`）：退出时必有完成通知；
 * - 显式声明了期限（`wait_until_seconds` → 登记表里的 `deadline`）：到期由 harness kill 并通知。
 *
 * 为什么不在这里判 monitor：monitor 不是 shell（`isShellTask` 为假），进不了本模块的
 * `pendingWakeIds`，本来就不会收到静默通知。
 */
function reportsOnItsOwn(task: TaskState): boolean {
  if (!isShellTask(task)) return false;
  if (outputBufferedUntilExit(task.command ?? "")) return true;
  return hasDeadlineWait(task.id);
}

/** queryLoop 入口调用：主循环开始干活，此前登记的待唤醒清单作废（新的一轮会自己看到任务状态） */
export function beginMainLoopTurn(): void {
  activeMainLoops++;
  pendingWakeIds.clear();
}

/**
 * queryLoop 收尾（finally）调用：主循环即将空闲，登记此刻仍值得等的后台 shell。
 * 之后它们转入静默时由 `takeQuiescentWake` 放出唤醒。
 *
 * 「自己会回报」的两类不登记（`reportsOnItsOwn`）：它们会在退出 / 到期时通知，
 * 再补一条「已静默、不会再自动回报」只会诱导模型前台轮询（N4）。
 */
export function endMainLoopTurn(now = Date.now()): void {
  activeMainLoops = Math.max(0, activeMainLoops - 1);
  if (activeMainLoops > 0) return;
  pendingWakeIds.clear();
  for (const t of getRunningTasks()) {
    if (!isShellTask(t) || !isAwaitedBackgroundTask(t, now)) continue;
    if (reportsOnItsOwn(t)) continue;
    pendingWakeIds.add(t.id);
  }
}

/**
 * shell 看门狗每次 tick 调用：主循环空闲、该任务在收尾时被登记为「在等」、且现在已静默
 * → 返回 true（并消费登记，同一次等待只唤醒一次）。
 *
 * `reportsOnItsOwn` 的短路必须在**这里**再判一次，不能只靠 `endMainLoopTurn` 不登记：
 * `wait_until_seconds` 的登记与主循环收尾谁先谁后没有强制约定，只靠「登记时已排除」
 * 会在顺序变化后静默失效，而失效形态正是它本该防的那条（20261109-191904-962011a6）。
 */
export function takeQuiescentWake(taskId: string, now = Date.now()): boolean {
  if (activeMainLoops > 0 || !pendingWakeIds.has(taskId)) return false;
  const task = getTask(taskId);
  // 自己不回报的任务才需要这条兜底唤醒；登记不消费（它永远不会走到「已唤醒」那一步）
  if (task && reportsOnItsOwn(task)) return false;
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
