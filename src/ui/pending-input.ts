/**
 * 中断输入暂存（A4：ESC 中断后自动恢复输入框内容）
 *
 * 对标 claude-code `screens/REPL.tsx:2996-3022` 的 "Auto-restore"：
 * 用户提交输入后、在收到任何实质响应之前按 ESC 取消，应把刚提交的原文回填到输入框，
 * 让用户可以编辑/重发，避免辛苦敲的输入凭空消失。
 *
 * 设计同构于 early-input.ts：用模块级缓冲解耦 App 层（产生回填）与 TUI InputArea（消费回填），
 * 无需新建 App↔TUI 的双向状态接线。
 *
 * 数据流：
 *   1. onUserInput 提交时 → stashPendingInput(原文, shellMode)（仅暂存，未"待回填"）。
 *   2. 用户 ESC 取消且满足回填守卫 → markForRestore()（置"待回填"标志）。
 *   3. InputArea 在 loading→idle 边沿 → consumePendingRestore()，拿到则 tb.setText() 回填。
 *   4. 正常完成（未取消）→ clearPendingInput() 丢弃,不回填。
 */

/** 待回填的输入快照 */
export interface PendingInput {
  /** 用户提交的原始文本（未经 @ 展开） */
  text: string;
  /** 提交时是否处于 shell 模式（! 前缀）。回填时据此恢复 shell 模式 */
  shellMode: boolean;
}

let pending: PendingInput | null = null;
/** 是否已被标记为"待回填"。只有标记后 consumePendingRestore 才会返回内容 */
let armed = false;

/**
 * 暂存本轮用户输入（提交时调用）。
 * 仅暂存,不代表会回填——是否回填由后续 markForRestore 决定。
 */
export function stashPendingInput(text: string, shellMode: boolean): void {
  pending = { text, shellMode };
  armed = false;
}

/**
 * 标记"待回填"（用户 ESC 取消且通过回填守卫后调用）。
 * 若当前无暂存输入则 no-op。
 */
export function markForRestore(): void {
  if (pending) armed = true;
}

/**
 * 消费待回填输入（InputArea 在 loading→idle 时调用）。
 * 仅当已 armed 才返回快照,返回后清空状态。否则返回 null。
 */
export function consumePendingRestore(): PendingInput | null {
  if (!armed || !pending) return null;
  const result = pending;
  pending = null;
  armed = false;
  return result;
}

/**
 * 清空暂存（本轮正常完成、或开始新一轮输入时调用），不回填。
 */
export function clearPendingInput(): void {
  pending = null;
  armed = false;
}

/** 仅含 role / content 的最小消息形状（便于测试,不依赖完整 Message 类型） */
interface MsgLike {
  role: string;
  content: Array<{ type: string; text?: string }>;
}

/**
 * A4 回填守卫判定（纯函数,可独立测试）。
 *
 * 对标 claude-code `messagesAfterAreOnlySynthetic`（REPL.tsx:3015）：
 * 仅当用户在"收到任何实质响应之前"中断,才允许回退会话 + 回填输入框。
 *
 * 判定:取末尾最后一条 user 消息,检查其后是否**没有任何含非空 text 的 assistant 消息**。
 * - 其后只有 tool_use/tool_result（工具已跑但还没产出 assistant 总结）→ 视为"无实质响应",可回填。
 * - 其后存在非空 assistant text → 有实质响应,不回填。
 * - 无任何 user 消息 → 不回填。
 *
 * @returns true 表示"无实质响应",可回填
 */
export function canRestoreCanceledInput(msgs: MsgLike[]): boolean {
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return false;

  for (let i = lastUserIdx + 1; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== "assistant") continue;
    const hasRealText = m.content.some(
      (b) => b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0,
    );
    if (hasRealText) return false;
  }
  return true;
}
