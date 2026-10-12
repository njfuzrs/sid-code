/**
 * 中断输入暂存（A4：未送达模型的输入，ESC 后放回输入框）
 *
 * 对标 claude-code `screens/REPL.tsx:2996-3022` 的 "Auto-restore"：
 * 用户提交输入后、模型还没收到 / 没产出任何内容之前按 ESC 取消，应把刚提交的原文回填到输入框，
 * 让用户可以编辑/重发，避免辛苦敲的输入凭空消失，也避免屏幕上留着一条"看着像发出去了"的消息。
 *
 * 口径：**只有「模型零响应」的轮次才撤回 + 回填**。模型已经回过任何东西（文本 / 思考 /
 * 工具调用），说明消息已送达，ESC 只中断、不撤回。
 *
 * 设计同构于 early-input.ts：用模块级缓冲解耦 App 层（产生回填）与 TUI InputArea（消费回填），
 * 无需新建 App↔TUI 的双向状态接线。
 *
 * 两条回填路径：
 *   A. 忙时 ESC（请求还在重试 / 等待中）：
 *      onUserInput 提交 → stashPendingInput；用户 ESC 且模型零响应 → app 撤回本轮 + markForRestore；
 *      InputArea 在 loading→idle 边沿 consumePendingRestore() 回填。
 *   B. 失败后空闲 ESC（请求已报错收尾，界面停在错误卡片）：
 *      本轮失败且模型零响应 → app 调 markRetractable()（此时**不**撤回，保留报错现场）；
 *      用户在空输入框按 ESC → InputArea 调 retractFailedTurn() → 经 app 注册的 retractor
 *      撤回本轮，成功则返回原文由 InputArea 回填。
 *   正常完成 / 模型已有响应 → clearPendingInput() 丢弃，不回填。
 */

/** 待回填的输入快照 */
export interface PendingInput {
  /** 用户提交的原始文本（未经 @ 展开） */
  text: string;
  /** 提交时是否处于 shell 模式（! 前缀）。回填时据此恢复 shell 模式 */
  shellMode: boolean;
}

let pending: PendingInput | null = null;
/** 路径 A：是否已被标记为"待回填"。只有标记后 consumePendingRestore 才会返回内容 */
let armed = false;
/** 路径 B：本轮已失败收尾、等待用户 ESC 撤回 */
let retractable = false;
/**
 * 路径 B 的撤回执行器（app 层注册）：回退对话、清掉屏上的这条消息、撤销落盘。
 * 返回 false 表示现场已变（期间又跑过别的轮次 / 命令），不能撤回。
 */
let retractor: (() => boolean) | null = null;

/**
 * 暂存本轮用户输入（提交时调用）。
 * 仅暂存，不代表会回填——是否回填由后续 markForRestore / markRetractable 决定。
 * 新一轮提交同时作废上一轮遗留的「可撤回」状态。
 */
export function stashPendingInput(text: string, shellMode: boolean): void {
  pending = { text, shellMode };
  armed = false;
  retractable = false;
}

/**
 * 「已 armed」订阅者（InputArea 挂载期间注册）。
 *
 * 为什么需要通知而不能只靠 loading→idle 边沿：tuiAgentLoop 的 finally 先把 isLoading 置 false，
 * onUserInput 要等 `await tuiAgentLoop()` 返回后才知道「本轮被取消、可回填」并调 markForRestore——
 * 边沿已经在 arm 之前过去了，回填永远拿到 null。arm 时主动通知，与边沿的先后顺序就无关了。
 */
const restoreListeners = new Set<() => void>();

/** 订阅「已 armed」事件，返回取消订阅函数。 */
export function onRestoreArmed(listener: () => void): () => void {
  restoreListeners.add(listener);
  return () => {
    restoreListeners.delete(listener);
  };
}

/**
 * 路径 A：标记"待回填"（用户 ESC 取消且本轮已撤回后调用）。
 * 若当前无暂存输入则 no-op。arm 后同步通知订阅者（InputArea 据此立即回填）。
 */
export function markForRestore(): void {
  if (!pending) return;
  armed = true;
  retractable = false;
  for (const l of [...restoreListeners]) {
    try {
      l();
    } catch {
      /* 订阅者异常不影响其它订阅者 */
    }
  }
}

/**
 * 路径 A：消费待回填输入（InputArea 在 loading→idle 时、或挂载时调用）。
 * 仅当已 armed 才返回快照，返回后清空状态。否则返回 null。
 */
export function consumePendingRestore(): PendingInput | null {
  if (!armed || !pending) return null;
  const result = pending;
  pending = null;
  armed = false;
  return result;
}

/**
 * 路径 B：标记本轮"失败且未送达模型、可被 ESC 撤回"。
 * 若当前无暂存输入则 no-op。
 */
export function markRetractable(): void {
  if (!pending) return;
  retractable = true;
  armed = false;
}

/** 路径 B：当前是否有一条可撤回的失败轮次（InputArea 据此决定 ESC 是否归它处理）。 */
export function hasRetractableFailedTurn(): boolean {
  return retractable && pending !== null && retractor !== null;
}

/** 路径 B：app 层注册撤回执行器（传 null 注销）。 */
export function setFailedTurnRetractor(fn: (() => boolean) | null): void {
  retractor = fn;
}

/**
 * 路径 B：执行撤回。成功返回原文供回填；不可撤回（无状态 / 现场已变）返回 null。
 * 无论成败都清空状态——现场已变时这条状态就再也用不上了。
 */
export function retractFailedTurn(): PendingInput | null {
  if (!hasRetractableFailedTurn()) return null;
  const snapshot = pending;
  let ok = false;
  try {
    ok = retractor!();
  } catch {
    ok = false;
  }
  clearPendingInput();
  return ok ? snapshot : null;
}

/**
 * 清空暂存（本轮正常完成、或开始新一轮输入时调用），不回填。
 */
export function clearPendingInput(): void {
  pending = null;
  armed = false;
  retractable = false;
}

/**
 * 本轮是否「模型零响应」（纯函数）：对比本轮开始前的消息快照与当前消息。
 *
 * - 前缀未被改写（逐条引用相同）→ 只看快照之后新增的消息里有没有 assistant。
 *   这能正确处理「本轮 user 消息还没来得及入 ctxMgr 就被取消」——此时新增为空，可回填；
 *   而 canRestoreCanceledInput 会误看上一轮的 user 消息。
 * - 前缀被改写（本轮 user 消息被合并进上一条 / 发生过压缩）→ 回落 canRestoreCanceledInput。
 *
 * 只是结构性判定。流式中途被打断的半截输出不入 ctxMgr，调用方须再与
 * 「本轮观察到模型产出」取与（见 app.ts 的 TurnProbe.modelResponded）。
 */
export function isTurnUnanswered(
  snapshot: readonly MsgLike[],
  current: readonly MsgLike[],
): boolean {
  const n = snapshot.length;
  const prefixIntact = current.length >= n && snapshot.every((m, i) => current[i] === m);
  if (prefixIntact) {
    for (let i = n; i < current.length; i++) {
      if (current[i].role === "assistant") return false;
    }
    return true;
  }
  return canRestoreCanceledInput(current as MsgLike[]);
}

/** 仅含 role 的最小消息形状（便于测试，不依赖完整 Message 类型） */
interface MsgLike {
  role: string;
  content: Array<{ type: string; text?: string }>;
}

/**
 * A4 回填守卫的结构性判定（纯函数，可独立测试）：本轮输入在**对话历史里**是否还没有模型回应。
 *
 * 判定：取末尾最后一条 user 消息，其后**不能有任何 assistant 消息**。
 * 只要模型回过任何东西（文本、空白文本、tool_use、thinking），就说明这条输入已经被模型
 * 收到并处理过——此时撤回会让对话历史与模型实际看到的内容错位，必须保留。
 *
 * 这比 cc 的 `messagesAfterAreOnlySynthetic` 更严：cc 允许"其后只有 tool_use/tool_result"
 * 时回填，但工具已经跑过 = 模型确实收到了消息，按本项目「已送达不回显」的口径不回填。
 *
 * 注意：这只是结构性兜底。流式中途被打断的半截输出不会入 ctxMgr，所以调用方还必须
 * 结合「本轮是否观察到模型产出」一起判断（见 app.ts 的 turnModelResponded）。
 *
 * @returns true 表示"模型零响应"，可回填
 */
export function canRestoreCanceledInput(msgs: MsgLike[]): boolean {
  // 找最后一条「真实用户输入」：tool_result 也是 user 角色，但它是模型调工具的回执，
  // 不是用户敲的话——把它当锚点会把「工具已跑完」误判为「模型没回应」。
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "user") continue;
    const onlyToolResults =
      m.content.length > 0 && m.content.every((b) => b.type === "tool_result");
    if (onlyToolResults) continue;
    lastUserIdx = i;
    break;
  }
  if (lastUserIdx === -1) return false;

  for (let i = lastUserIdx + 1; i < msgs.length; i++) {
    if (msgs[i].role === "assistant") return false;
  }
  return true;
}
