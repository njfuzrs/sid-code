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
 *   而那个补丁位又要在每个 compact 出口手工置位——漏一处就是清单永久消失（2026-11-01 核对：
 *   loop 内 7 处，手动 /compact 曾漏掉，现统一走 post-compact-flags.ts）。
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
   * 距最近一次 `todo_write` 调用过了多少个 assistant 轮（**单位：assistant 消息条数**）。
   * 历史里从未出现过 `todo_write` → `Infinity`（"久到不可考"，语义上必然到期）。
   *
   * 2026-11-07（T4）：原名 `assistantMsgsSinceTodoWrite`。改名是因为它和下面的
   * `absTurnsSinceReminder` 用了两种单位，读事件的人无法从名字看出差别。
   */
  assistantMsgsSinceTodoWrite: number;
  /**
   * 距最近一次 todo reminder 注入过了多少轮（**单位：absoluteTurn 差值**，不是消息条数）。
   * 从未注入过 → `Infinity`。
   */
  absTurnsSinceReminder: number;
  /**
   * 最近 `recentWindow` 个 assistant 轮里，含**工具调用**（且不是 `todo_write`）的轮数。
   *
   * C4（2026-11-03）：用来回答「模型是不是正在推进当前项」。本会话（3b4f9ca7）
   * 主会话 03:43–03:46 在读源码准备派子代理，清单本身没过期，却被每 8 轮催了 4 次。
   * 判据缺的正是这一个信号 —— 只看「多久没写清单」分不清「停滞」与「在干活」。
   *
   * **可选**（`?? 0`）：省略等价于旧行为「不放宽」。回归哨兵
   * 「60 轮停滞至少注入 6 次」依赖这个默认值，别把它改成"总是统计"。
   */
  recentToolUseTurns?: number;
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
 * 一条 assistant 消息里是否**含任意** tool_use 块（C4：判断「模型在不在干活」）。
 *
 * 不区分工具名：read / grep / bash / edit / 子代理调用都算推进。真正要排除的是
 * `todo_write` 本身 —— 那是「更新清单」这个被判定对象，`getTodoReminderTurnCounts`
 * 里在调用前就已经把它分流出去了。
 */
function hasAnyToolUse(msg: Message): boolean {
  if (msg.role !== "assistant") return false;
  if (!Array.isArray(msg.content)) return false;
  return (msg.content as ContentBlock[]).some((b) => b?.type === "tool_use");
}

/**
 * 倒序扫描消息历史，现算节流计数（纯函数，无副作用）。
 *
 * `assistantMsgsSinceTodoWrite` 的计法与对标一致：数"最近一次 `todo_write` 之后又出现了多少个
 * assistant 轮"。含 `todo_write` 的那一轮本身不计（它就是基准点，距离为 0）。
 *
 * `recentToolUseTurns` 是 C4 新增的「模型在不在干活」信号：数最近 `recentWindow`
 * 个 assistant 轮里有多少轮带了工具调用（`todo_write` 不算——那正是我们要判断的
 * 「有没有更新清单」本身）。**`recentWindow` 省略时恒为 0**，即旧行为（不放宽），
 * 回归哨兵「60 轮停滞至少注入 6 次」依赖这个默认值。
 *
 * @param messages 当前消息序列（通常 `ctxMgr.getCleanedMessages()`）
 * @param opts.absoluteTurn            当前会话累计轮次（`SessionState.getAbsoluteTurn()`）
 * @param opts.lastReminderAbsoluteTurn 上次注入 todo reminder 时的累计轮次；未注过传 undefined
 * @param opts.recentWindow            统计工具调用轮数的回看窗口；省略 = 不统计
 */
export function getTodoReminderTurnCounts(
  messages: Message[],
  opts: {
    absoluteTurn: number;
    lastReminderAbsoluteTurn?: number;
    recentWindow?: number;
  },
): TodoReminderTurnCounts {
  let assistantTurnsSeen = 0;
  let assistantMsgsSinceTodoWrite = Number.POSITIVE_INFINITY;
  let recentToolUseTurns = 0;
  const window = opts.recentWindow ?? 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;
    const isTodoWrite = hasTodoWriteToolUse(msg);
    if (isTodoWrite) {
      // 只认**最近**一次：更早的 todo_write 不再影响距离，也仍在窗口内被排除在
      // 「工具调用」计数之外（它不是「在干活」的证据，是我们要判定的对象本身）。
      if (assistantMsgsSinceTodoWrite === Number.POSITIVE_INFINITY) {
        assistantMsgsSinceTodoWrite = assistantTurnsSeen;
      }
    } else if (assistantTurnsSeen < window && hasAnyToolUse(msg)) {
      recentToolUseTurns++;
    }
    assistantTurnsSeen++;
  }

  const last = opts.lastReminderAbsoluteTurn;
  const absTurnsSinceReminder =
    last === undefined ? Number.POSITIVE_INFINITY : Math.max(0, opts.absoluteTurn - last);

  return { assistantMsgsSinceTodoWrite, absTurnsSinceReminder, recentToolUseTurns };
}

/**
 * 纯节流判定 —— **无去重、无封顶**（对标 `attachments.ts:3288-3291`）。
 *
 * ```ts
 * if (assistantMsgsSinceTodoWrite >= 10 && absTurnsSinceReminder >= 10) { inject }
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
 *
 * ─── C4（2026-11-03）：模型在推进时放宽「距上次提醒」的间隔 ───
 *
 * 会话 3b4f9ca7 实测：主会话 03:43–03:46 正在读源码准备派子代理，清单没过期，
 * 却在 8 / 16 / 24 / 32 轮各挨一次提醒（4 次全进上下文，0 次换来 todo_write）。
 * 判据只看「多久没写清单」，分不清「停滞」与「在干活」。
 *
 * 现在由调用方传 `relaxWhenAdvancing: true`（它的判据是「清单恰好一个 in_progress」），
 * 配合扫描出的 `recentToolUseTurns > 0`（最近窗口内有工具调用），把间隔**放宽到 2 倍**。
 * 只是「少催一半」，不是永久静音：模型真停滞（无工具调用）时仍按原间隔响。
 *
 * ⚠️ 默认 `false`：不传 = 旧行为。回归哨兵「60 轮停滞至少注入 6 次」依赖这个默认值
 * —— 那条哨兵的消息历史里每轮都有工具调用，若默认放宽，注入次数会掉到 3–4 次。
 */
export function shouldInjectTodoReminder(
  counts: TodoReminderTurnCounts,
  thresholds: {
    turnsSinceWrite: number;
    turnsBetweenReminders: number;
    /**
     * C4：模型正在推进当前项时，把「距上次提醒」的间隔放宽到 2 倍。
     * 只有调用方能确认「清单恰好一个 in_progress」时才置 true。
     */
    relaxWhenAdvancing?: boolean;
  },
): boolean {
  const advancing = thresholds.relaxWhenAdvancing === true && (counts.recentToolUseTurns ?? 0) > 0;
  const between = advancing
    ? thresholds.turnsBetweenReminders * TODO_REMINDER_ADVANCE_RELAX_FACTOR
    : thresholds.turnsBetweenReminders;
  return (
    counts.assistantMsgsSinceTodoWrite >= thresholds.turnsSinceWrite &&
    counts.absTurnsSinceReminder >= between
  );
}

/**
 * C4：「模型正在推进」时提醒间隔的放宽倍数。
 *
 * 2 倍而不是更大：本会话 4 次提醒里 4 次都落在「距上次写清单 8/16/24/32 轮」上，
 * 放宽到 16 轮足以把这一段（约 40 轮探索）的提醒从 4 次压到 2 次；
 * 再大就会让「真的忘了更新清单」的停滞段也拖长。
 */
export const TODO_REMINDER_ADVANCE_RELAX_FACTOR = 2;

/**
 * 压缩后的 todo 重注入是否冗余（T5，2026-11-01）。
 *
 * 前置核实：microcompact / masking 只改写 tool_result，不动 tool_use.input；snip / 截断 /
 * 摘要是整条删除。所以「扫描还能找到 todo_write」⟺「清单原文仍在发送副本里」。
 * 距离有限且低于回注阈值时，模型眼前就有完整清单，再补一次是重复注入。
 * `Infinity`（压缩把它删掉了 / 从未写过）一律判不冗余，保住信息丢失兜底。
 */
export function isPostCompactTodoReinjectRedundant(
  assistantMsgsSinceTodoWrite: number,
  turnsSinceWriteThreshold: number,
): boolean {
  return (
    Number.isFinite(assistantMsgsSinceTodoWrite) &&
    assistantMsgsSinceTodoWrite < turnsSinceWriteThreshold
  );
}

/** SessionState 键名：上次注入 todo reminder 时的会话累计轮次（跨用户消息持久）。 */
export const LAST_TODO_REMINDER_TURN_KEY = "lastTodoReminderAbsoluteTurn";

/**
 * SessionState 键名：上次观察到的 todo `writeVersion` 基线（跨用户消息持久）。
 *
 * 与上面那个锚点**同因上移**（2026-08-02）：它原先挂在 `LoopState` 上，而 `LoopState` 由
 * `createInitialLoopState()` 在每条用户消息重建，于是基线每条消息归零成 `undefined`，
 * `lastSeen !== writeVersion` 在清单**根本没动**时也判 true。实测 writeVersion 恒定 3、
 * 零真实推进的会话，第二条用户消息后 `TodoProgressAdvanced` 埋点从 1 变 2。
 *
 * 后果不是"多一条日志"：这条事件是方案 §8.3 里唯一能直接量 todo 实时性的指标，
 * 虚增会让「改动到底有没有效」这个判断建在偏差尺子上；`persistProgress` 也会跟着
 * 重复落盘同一份快照。判定"清单是否推进"属于**跨用户消息的会话级事实**，
 * 只能放在会话级状态里。
 */
export const LAST_TODO_WRITE_VERSION_KEY = "lastSeenTodoWriteVersion";
