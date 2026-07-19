/**
 * 统一优先级消息队列内核（缺口1 h2A，对齐 CC utils/messageQueueManager.ts）
 *
 * 目标：把此前三个分散通道（用户输入排队 / 后台任务通知回注 / 后台 agent 消息）
 * 收敛到**同一个优先级队列**，支持 mid-turn 抢占式 drain。
 *
 * 三优先级（对齐 CC now/next/later）：
 * - `now`   —— 用户显式中断/改向。可 mid-turn 抢占（在安全检查点插入），优雅收束当前轮。
 * - `next`  —— 普通用户输入排队。回合边界 drain，按序接续。
 * - `later` —— 后台任务通知 / 后台 agent 消息。回合边界 drain，最低优先级。
 *
 * 出队顺序：`now` 全部 → `next` 全部 → `later` 全部；**同优先级严格 FIFO**。
 *
 * ⚠️ 确定性约束（本仓 workflow / 确定性回放禁用 Date.now()）：
 *   `enqueuedAt` 用模块内单调递增序号 `seq++` 而非墙钟时间，保证：
 *   ① 同优先级 FIFO 稳定可测；② 回放确定性（不依赖真实时间）。
 *
 * 设计为纯模块级单例 + 订阅通知：React 侧经 useSyncExternalStore 订阅 getQueueSnapshot()
 * 渲染「已排队 N 条」，非 React 代码（queryLoop）直接 drainByPriority()。
 */

/** 命令优先级（对齐 CC now/next/later） */
export type CommandPriority = "now" | "next" | "later";

/** 命令种类——决定 drain 后如何注入主循环 */
export type CommandKind =
  | "user-input" // 用户输入（流式中排队 / ESC 改向）
  | "task-notification" // 后台任务完成通知回注
  | "permission-response" // 孤儿权限响应
  | "agent-message"; // 后台 agent 消息

/** 队列条目 */
export interface QueuedCommand {
  /** 稳定唯一 ID（`c${seq}`，seq 单调递增） */
  id: string;
  priority: CommandPriority;
  kind: CommandKind;
  /** 载荷：user-input 为文本；task-notification 携带结构化快照等，由消费方解释 */
  payload: unknown;
  /** 单调递增入队序号（非墙钟；用于同优先级 FIFO + 确定性回放） */
  enqueuedAt: number;
}

/** 优先级排序权重：越小越先出队 */
const PRIORITY_RANK: Record<CommandPriority, number> = { now: 0, next: 1, later: 2 };

/** 模块级单例队列 */
let queue: QueuedCommand[] = [];
/** 单调递增序号——同时作 id 后缀与 enqueuedAt（确定性，不用 Date.now()） */
let seq = 0;
/** 订阅者（useSyncExternalStore 的 subscribe 回调） */
const listeners = new Set<() => void>();
/** 缓存的快照（useSyncExternalStore 要求 getSnapshot 返回稳定引用，内容不变时不能返回新数组） */
let cachedSnapshot: readonly QueuedCommand[] = [];

/** 通知所有订阅者队列已变化 */
function emitChange(): void {
  cachedSnapshot = queue.slice();
  for (const l of listeners) l();
}

/**
 * 入队一条命令。返回生成的条目（含 id）。
 * 稳定排序：入队即按 (priority rank, enqueuedAt) 插入有序位置，drain 时直接取前缀。
 */
export function enqueueCommand(cmd: {
  priority: CommandPriority;
  kind: CommandKind;
  payload: unknown;
}): QueuedCommand {
  const entry: QueuedCommand = {
    id: `c${seq}`,
    priority: cmd.priority,
    kind: cmd.kind,
    payload: cmd.payload,
    enqueuedAt: seq,
  };
  seq++;
  queue.push(entry);
  // 稳定排序：优先级升序，同级按 enqueuedAt 升序（FIFO）。
  // Array.sort 在 V8 是稳定排序，但显式比较 enqueuedAt 更抗未来引擎差异。
  queue.sort((a, b) => {
    const r = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    return r !== 0 ? r : a.enqueuedAt - b.enqueuedAt;
  });
  emitChange();
  return entry;
}

/**
 * 出队：取出**优先级 ≤ maxPriority** 的全部命令（已按 now→next→later、同级 FIFO 排好序）。
 *
 * @param maxPriority 只 drain 到这个优先级为止：
 *   - "now"   → 只取 now 级（mid-turn 抢占探测用，Phase B）；
 *   - "next"  → 取 now + next（回合边界处理用户输入）；
 *   - "later" → 取全部（回合边界完整 drain，默认）。
 * @returns 出队的命令数组（保持出队顺序）；队列相应移除这些条目。
 */
export function drainByPriority(maxPriority: CommandPriority = "later"): QueuedCommand[] {
  if (queue.length === 0) return [];
  const maxRank = PRIORITY_RANK[maxPriority];
  const taken: QueuedCommand[] = [];
  const remaining: QueuedCommand[] = [];
  for (const c of queue) {
    if (PRIORITY_RANK[c.priority] <= maxRank) taken.push(c);
    else remaining.push(c);
  }
  if (taken.length === 0) return [];
  queue = remaining;
  emitChange();
  return taken;
}

/**
 * 出队指定 kind 的全部命令（保持出队顺序，其余 kind 原位保留、顺序不变）。
 *
 * 用于跨通道隔离 drain：如任务通知回合边界只取 task-notification，绝不误吞 user-input
 *（后者归 UI Idle-drain / loop mid-turn）。比"全量 drain 再回队"更安全——不重排、不改序号。
 * 已按 (priority, enqueuedAt) 有序，故取出的同 kind 命令天然保持 now→next→later + FIFO。
 */
export function drainByKind(kind: CommandKind): QueuedCommand[] {
  if (queue.length === 0) return [];
  const taken: QueuedCommand[] = [];
  const remaining: QueuedCommand[] = [];
  for (const c of queue) {
    if (c.kind === kind) taken.push(c);
    else remaining.push(c);
  }
  if (taken.length === 0) return [];
  queue = remaining;
  emitChange();
  return taken;
}

/**
 * 出队**第一条**指定 kind 的命令（保持队列其余顺序不变）。
 *
 * 用于 UI 侧「逐条接续用户输入」：只取队首那条 user-input 发送，其余原位保留，
 * 既不触碰 task-notification（归 queryLoop 处理），也不因批量取出再回队而打乱 FIFO / 重置序号。
 * 队列已按 (priority, enqueuedAt) 有序，故第一条匹配项即优先级最高、最早入队的那条。
 *
 * @returns 出队的命令；无匹配返回 undefined。
 */
export function dequeueFirstByKind(kind: CommandKind): QueuedCommand | undefined {
  const idx = queue.findIndex((c) => c.kind === kind);
  if (idx === -1) return undefined;
  const [taken] = queue.splice(idx, 1);
  emitChange();
  return taken;
}

/** 查看队首命令（不出队）。用于 mid-turn 探测「是否有 now 级待处理」。 */
export function peek(): QueuedCommand | undefined {
  return queue[0];
}

/** 是否存在 ≤ maxPriority 的待处理命令（不出队）。mid-turn 抢占探测用。 */
export function hasPending(maxPriority: CommandPriority = "later"): boolean {
  const maxRank = PRIORITY_RANK[maxPriority];
  for (const c of queue) {
    if (PRIORITY_RANK[c.priority] <= maxRank) return true;
  }
  return false;
}

/** 当前队列长度 */
export function queueSize(): number {
  return queue.length;
}

/**
 * 只读快照（useSyncExternalStore 的 getSnapshot）。
 * 返回**稳定引用**：队列未变时始终返回同一个数组引用（避免 React 无限重渲染）。
 */
export function getQueueSnapshot(): readonly QueuedCommand[] {
  return cachedSnapshot;
}

/** 订阅队列变化（useSyncExternalStore 的 subscribe）。返回取消订阅函数。 */
export function subscribeQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 清空队列（会话 /clear、/compact、测试隔离用）。
 * 不重置 seq——seq 全局单调，跨清空仍保证 id 唯一、回放确定。
 */
export function clearQueue(): void {
  if (queue.length === 0) return;
  queue = [];
  emitChange();
}

/** 仅供测试：完全重置（清队列 + 归零 seq + 清订阅），保证用例间无状态泄漏。 */
export function __resetForTest(): void {
  queue = [];
  seq = 0;
  listeners.clear();
  cachedSnapshot = [];
}
