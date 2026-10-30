/**
 * terminal 出口的孤儿 tool_use 结算（路径不变量）。
 *
 * 为什么要在产生孤儿的那一刻结算，而不是交给发送前的 `finalizeMessagesForSend` 兜底：
 * 兜底确实不会 400，但它是「下一次发请求时」才补，占位文案只能写一句泛化的「未执行」，
 * 说不出这一轮**为什么**没执行；而且如果之后根本不再发请求（会话结束、导出轨迹），
 * 历史里留下的就是一段协议上不配对的 assistant(tool_use)，「模型这一轮到底做了什么」
 * 这件事实被污染。此前只有 ctx_window 分支就地结算，refusal / pause_turn / 未识别 /
 * 空流三类出口都漏了——新增一种 terminal 出口时也必然再漏，所以收成一个函数，
 * 所有 terminal 出口都调它。
 */

import type { Manager as ContextManager } from "../context/manager.ts";
import { buildPendingToolResults } from "../agent/message-invariants.ts";
import type { DoneIncompleteReason } from "./types.ts";

/** 各 terminal 原因给占位 tool_result 的文案：写清「为什么没执行」，不是泛化的「未执行」 */
const ORPHAN_REASON_TEXT: Partial<Record<DoneIncompleteReason, string>> = {
  context_window_exhausted: "上下文已撞到模型窗口上限",
  refusal: "模型基于安全策略拒答（stop_reason=refusal）",
  pause_turn: "上游 server tool 暂停（stop_reason=pause_turn），本地未实现续接",
  empty_stream: "模型返回空响应",
  unknown_stop_reason: "模型以未识别的停止原因结束本轮",
};

export function orphanPlaceholderText(reason: DoneIncompleteReason): string {
  return `[系统] ${ORPHAN_REASON_TEXT[reason] ?? `本轮提前收尾（${reason}）`}，此工具调用未执行。`;
}

/**
 * 为历史里所有未应答的 tool_use 补占位 tool_result。返回补了几个（0 = 无孤儿）。
 * 幂等：已配对的 tool_use 不会重复补。
 */
export function settleOrphanToolUses(ctxMgr: ContextManager, reason: DoneIncompleteReason): number {
  const orphans = buildPendingToolResults(ctxMgr.getMessages(), orphanPlaceholderText(reason));
  if (orphans.length > 0) ctxMgr.addMessage({ role: "user", content: orphans });
  return orphans.length;
}
