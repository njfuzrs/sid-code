/**
 * Todo 回注节流判定 —— 无状态消息扫描（对标 claude-code `utils/attachments.ts:3212-3291`）
 *
 * ## 这个模块要替掉什么
 *
 * 旧实现把"该不该回注 todo 清单"押在 `LoopState` 的一串计数器上，再叠「逐字节去重 + 封顶 2 次」
 * 两道闸。实测后果（2026-08-01，60 轮停滞会话）：
 *
 *   60 轮内注入轮次: [ 11 ]  共 1 次
 *   nagCount 最终 = 1 / cap 2  → 封顶根本没用上，dedup 先锁死
 *
 * 全网遥测同向：`NoProgressNagInjected` 的 todo 通道累计只注入过 **3 次 / 4 个会话**。
 * 这条通道在现网基本不工作。
 *
 * 两层病因：
 *
 * 1. **去重锁死**（`reminder-throttle.ts:63`）。`buildTodoReminder(todos)` 的文本只随清单内容
 *    变化，模型一停滞清单就不变 → 文本恒定 → 从第 2 次起永久静音。而"模型停滞"恰恰是**最需要
 *    催更**的时刻，去重把催更和"无需催更"判反了。
 * 2. **状态位置错了**（本项目已有同源结论：memory `resilience-layer-state-locality-cc-alignment`）。
 *    `LoopState` 由 `createInitialLoopState()` 在**每条用户消息**重建，于是 7 个 todo 计数器跨
 *    用户消息全部归零，与对标"扫描全历史"的语义根本不等价。
 *
 * ## 为什么判定要落在消息历史上，而不是计数器上
 *
 * 对标实现的节流判定**不存任何状态**，每轮倒序扫描消息历史现算。这不是风格差异，是**正确性
 * 差异**：消息历史是唯一事实源，而计数器是它的影子。两个白拿的好处：
 *
 * - **跨用户消息不失忆**：历史不会因为用户又发了一句话就归零；
 * - **压缩后自动重注**：压缩把 `todo_write` 的 tool_use 块删掉后，扫描算出"距上次写清单很久了"
 *   → 自动重注一次。旧实现要为此专门背一个 `todoReminderPendingAfterCompact` 补丁位，
 *   而那个补丁位又要在 6 处 compact 调用点手工置位——漏一处就是清单永久消失。
 *
 * ## 与对标的一处**刻意偏离**（不是没做到，是判断后选择不做）
 *
 * 对标把 reminder 自己作为一条 `attachment` 消息**写进 conversation**，于是"上次注入是哪轮"
 * 也记录在历史里。本项目**不这么做**，因为 `reminder-inject.ts` 不变量 3（"注入产物只进发送副本、
 * 永不写回 ctxMgr"）有三处实测事故背书 + 哨兵测试守卫：破坏它会同时引发 TUI 泄漏内部文本、
 * 压缩把工具列表当"用户最初的请求"、reminder 在历史里逐轮累积。
 *
 * 对标能安全走那条路，是因为它有独立的 attachment 消息类型 + `nullRenderingAttachments` 白名单；
 * 本项目的 `Message.role` 只有 `user | assistant`，reminder 落历史就是一条真 user 消息，
 * 正是那三处事故的成因。
 *
 * 所以这里**只把"上次注入"这一个标量**交给 `SessionState`（跨用户消息持久，与 `getAbsoluteTurn()`
 * 同口径），历史侧只扫真正属于历史的事实（`todo_write` 调用）。这与本文件上方两处既有先例
 * 完全同构——`lastSeenContextPressureLevel` / `lastSeenPermissionMode` 都因"LoopState 每消息
 * 重建"而上移到 SessionState（审计第 9 条）。**拿到的非重置语义与对标等价，代价是一个标量，
 * 而不是一条会泄漏进 TUI 的消息。**
 */

import type { Message, ContentBlock } from "../llm/types.ts";

/** 本模块识别的 todo 写入工具名（与 `TodoWriteTool.name()` 保持一致）。 */
const TODO_WRITE_TOOL_NAME = "todo_write";

/** 一次扫描的产出：两个"距今多少个 assistant 轮"的计数。 */
export interface TodoReminderTurnCounts {
  /**
   * 距最近一次 `todo_write` 调用过了多少个 assistant 轮。
   * 历史里从未出现过 `todo_write` → `Infinity`（"久到不可考"，语义上必然到期）。
   */
  turnsSinceLastTodoWrite: number;
  /**
   * 距最近一次 todo reminder 注入过了多少轮（按 absoluteTurn 相减）。
   * 从未注入过 → `Infinity`。
   */
  turnsSinceLastReminder: number;
}

/** 一条 assistant 消息里是否含 `todo_write` 的 tool_use 块。 */
function hasTodoWriteToolUse(msg: Message): boolean {
  if (msg.role !== "assistant") return false;
  if (!Array.isArray(msg.content)) return false;
  return (msg.content as ContentBlock[]).some(
    (b) => b?.type === "tool_use" && (b as { name?: string }).name === TODO_WRITE_TOOL_NAME,
  );
}

/**
 * 倒序扫描消息历史，现算两个节流计数（纯函数，无副作用）。
 *
 * `turnsSinceLastTodoWrite` 的计法与对标一致：数"最近一次 `todo_write` 之后又出现了多少个
 * assistant 轮"。含 `todo_write` 的那一轮本身不计（它就是基准点，距离为 0）。
 *
 * @param messages 当前消息序列（通常 `ctxMgr.getCleanedMessages()`）
 * @param opts.absoluteTurn            当前会话累计轮次（`SessionState.getAbsoluteTurn()`）
 * @param opts.lastReminderAbsoluteTurn 上次注入 todo reminder 时的累计轮次；未注过传 undefined
 */
export function getTodoReminderTurnCounts(
  messages: Message[],
  opts: { absoluteTurn: number; lastReminderAbsoluteTurn?: number },
): TodoReminderTurnCounts {
  let assistantTurnsSeen = 0;
  let turnsSinceLastTodoWrite = Number.POSITIVE_INFINITY;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (hasTodoWriteToolUse(msg)) {
      turnsSinceLastTodoWrite = assistantTurnsSeen;
      break;
    }
    if (msg.role === "assistant") assistantTurnsSeen++;
  }

  const last = opts.lastReminderAbsoluteTurn;
  const turnsSinceLastReminder =
    last === undefined ? Number.POSITIVE_INFINITY : Math.max(0, opts.absoluteTurn - last);

  return { turnsSinceLastTodoWrite, turnsSinceLastReminder };
}

/**
 * 纯节流判定 —— **无去重、无封顶**（对标 `attachments.ts:3288-3291`）。
 *
 * ```ts
 * if (turnsSinceLastTodoWrite >= 10 && turnsSinceLastReminder >= 10) { inject }
 * ```
 *
 * 两个条件是 **AND**：既要"模型确实有一阵没碰清单了"，又要"上次提醒也隔了一阵"。
 * 旧实现只用了 `TURNS_BETWEEN_REMINDERS` 一个条件，`TURNS_SINCE_WRITE` 是**死常量**
 * （在 `loop.ts` 里从未被引用，只在注释里提到）。改成扫描后两个条件都真正参与判定。
 *
 * ⚠️ **刻意不加去重、不加封顶。** 这两道闸是"防线过度生效导致主功能失效"的直接成因
 * （见文件头实测数据）。若落地后重新观察到弱模型把重复 reminder 误判成用户消息，
 * 正确的应对是**给文案加轮次等自然变化量**让"重复"在语义上不再重复，
 * 而不是恢复封顶——恢复封顶就是回到 60 轮响 1 次。
 */
export function shouldInjectTodoReminder(
  counts: TodoReminderTurnCounts,
  thresholds: { turnsSinceWrite: number; turnsBetweenReminders: number },
): boolean {
  return (
    counts.turnsSinceLastTodoWrite >= thresholds.turnsSinceWrite &&
    counts.turnsSinceLastReminder >= thresholds.turnsBetweenReminders
  );
}

/** SessionState 键名：上次注入 todo reminder 时的会话累计轮次（跨用户消息持久）。 */
export const LAST_TODO_REMINDER_TURN_KEY = "lastTodoReminderAbsoluteTurn";
