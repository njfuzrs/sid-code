/**
 * 「标了 completed 之后又返工」检测（2026-10-06）
 *
 * 缺陷现场（会话 20261005-233851-9b91e1b7）：第 2 项「修改 ppchat-route 脚本」在 16:07:12 被标为
 * completed，随后 16:07–16:17 复测发现改法有问题，16:17:35 **又改了一次同一个文件**。这 10 分钟的
 * 返工全挂在第 3 项「同步脚本」名下——清单在这段时间里把一份没改好的代码显示成「已完成」。
 * 这是"清单状态不实时"的真实形态：不是标记慢了，而是**提前**标了、返工时没改回来。
 *
 * 判据只用不可伪造的副作用（与 measured-progress.ts 同一原则）：
 *   1. 每次 todo_write 时，把"上次 todo_write 以来落盘过的文件"归到**本次新变为 completed** 的项上；
 *   2. 之后若某个文件再次被 edit/write，而它归属的项**当前仍是 completed**、清单还没全部做完，
 *      就提醒一次：若是在返工那一项，请把它改回 in_progress。
 *
 * 只提醒、不拦截、不改清单：harness 不知道这次修改是不是在返工那一项（也可能是下一项顺手碰了
 * 同一个文件），所以提醒文案是条件式的，由模型自己判断。同一 (项, 文件) 只提醒一次。
 *
 * 设计原则：纯数据 + 纯函数，副作用（何时记录、何时注入）留在 loop.ts，便于单测。
 */

import type { TodoItem } from "../tool/todo-write.ts";

/** 返工检测状态（会话级，挂 SessionState——理由同 MEASURED_PROGRESS_KEY：要跨用户消息）。 */
export interface TodoReworkState {
  /** 上次 todo_write 以来落盘过的文件 */
  filesSinceLastWrite: Set<string>;
  /** 上次 todo_write 后各项状态（按 content 索引），用于算"本次新完成项" */
  lastStatuses: Map<string, TodoItem["status"]>;
  /** completed 项 content → 它完成前那段时间落盘的文件 */
  attribution: Map<string, Set<string>>;
  /** 已提醒过的 `content\0file`，防重复 */
  notified: Set<string>;
  /** 待注入的提醒（下一轮 reminder 通道消费） */
  pendingHints: TodoReworkHit[];
}

/** 一次返工命中 */
export interface TodoReworkHit {
  /** 已标 completed 的项 */
  item: string;
  /** 被再次修改的文件 */
  file: string;
}

export const TODO_REWORK_KEY = "todoReworkState";

export function createTodoReworkState(): TodoReworkState {
  return {
    filesSinceLastWrite: new Set(),
    lastStatuses: new Map(),
    attribution: new Map(),
    notified: new Set(),
    pendingHints: [],
  };
}

/**
 * 记一次 todo_write 后的清单：把期间落盘的文件归到新完成项上，被改回未完成的项撤销归属。
 * 调用时机：queryLoop 观察到 writeVersion 变化时（每次写入恰好调用一次）。
 */
export function recordTodoWrite(state: TodoReworkState, todos: TodoItem[]): void {
  const next = new Map<string, TodoItem["status"]>();
  for (const t of todos) {
    next.set(t.content, t.status);
    const before = state.lastStatuses.get(t.content);
    if (t.status === "completed" && before !== "completed") {
      if (state.filesSinceLastWrite.size > 0) {
        state.attribution.set(t.content, new Set(state.filesSinceLastWrite));
      }
    } else if (t.status !== "completed") {
      // 改回未完成 = 模型已经如实承认在返工，不再需要提醒
      state.attribution.delete(t.content);
    }
  }
  // 清单里已经不存在的项（被删 / 改名）撤销归属，避免拿过期 content 误报
  for (const content of [...state.attribution.keys()]) {
    if (!next.has(content)) state.attribution.delete(content);
  }
  state.lastStatuses = next;
  state.filesSinceLastWrite.clear();
}

/**
 * 记一次文件落盘，并判定是否在返工一个已标 completed 的项。
 *
 * `todos` 传当前（最新写入的）清单；为 null 或已全部完成时只记录不判定——
 * 全部完成后再改文件多半是用户的新要求，那不是"提前打勾"。
 */
export function recordFileEditForRework(
  state: TodoReworkState,
  filePath: unknown,
  todos: TodoItem[] | null,
): TodoReworkHit | null {
  if (typeof filePath !== "string") return null;
  const file = filePath.trim();
  if (!file) return null;
  state.filesSinceLastWrite.add(file);
  if (!todos || todos.every((t) => t.status === "completed")) return null;
  for (const t of todos) {
    if (t.status !== "completed") continue;
    const files = state.attribution.get(t.content);
    if (!files || !files.has(file)) continue;
    const key = `${t.content}\u0000${file}`;
    if (state.notified.has(key)) continue;
    state.notified.add(key);
    const hit = { item: t.content, file };
    state.pendingHints.push(hit);
    return hit;
  }
  return null;
}

/** 取出并清空待注入提醒，渲染成 system-reminder；无提醒返回 null。 */
export function drainTodoReworkReminder(state: TodoReworkState): string | null {
  if (state.pendingHints.length === 0) return null;
  const hits = state.pendingHints.splice(0);
  const lines = hits.map((h) => `- 「${h.item}」已标 completed，但你随后又修改了 ${h.file}`);
  return `<system-reminder>
任务清单与实际进展可能不一致（请勿向用户提及本提醒）：
${lines.join("\n")}
若这次修改是在返工上面那一项，请先用 todo_write 把它改回 in_progress，改完并验证后再标 completed——否则清单会把尚未改好的工作显示成"已完成"。若这次修改属于其他项，忽略本提醒即可。
</system-reminder>`;
}
