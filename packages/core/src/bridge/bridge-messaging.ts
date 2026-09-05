/**
 * Bridge 消息协议 — 资格判断 + 格式化
 *
 * 将 Agent 循环产生的事件转换为 BridgeOutMessage，
 * 过滤掉不应发送给远程客户端的内部事件。
 */

import type { BridgeOutMessage } from "./types.ts";

/** 单调递增消息 id 生成器（避免 Math.random 碰撞） */
let messageSeq = 0;
export function nextMessageId(prefix = "msg"): string {
  return `${prefix}-${Date.now()}-${++messageSeq}`;
}

/** 格式化文本消息 */
export function formatTextMessage(text: string): BridgeOutMessage {
  return {
    type: "text",
    id: nextMessageId("text"),
    data: { text },
    timestamp: Date.now(),
  };
}

/** 格式化工具调用消息 */
export function formatToolUseMessage(toolName: string, input: unknown): BridgeOutMessage {
  return {
    type: "tool_use",
    id: nextMessageId("tool"),
    data: { toolName, input },
    timestamp: Date.now(),
  };
}

/** 格式化工具结果消息 */
export function formatToolResultMessage(
  toolName: string,
  output: string,
  isError?: boolean,
): BridgeOutMessage {
  return {
    type: "tool_result",
    id: nextMessageId("result"),
    data: { toolName, output, isError: !!isError },
    timestamp: Date.now(),
  };
}

/** 格式化状态消息 */
export function formatStatusMessage(
  status: string,
  extra?: Record<string, unknown>,
): BridgeOutMessage {
  return {
    type: "status",
    id: nextMessageId("status"),
    data: { status, ...extra },
    timestamp: Date.now(),
  };
}

/**
 * 应转发给远程客户端的 `QueryEngineEvent.kind` 白名单。
 *
 * ⚠️ **这里曾是一份说着不存在的方言的白名单**（D13，比缺陷清单描述的更严重）。
 * 原集合是 `text` / `text_delta` / `tool_use` / `tool_result` / `turn_complete` / `error`
 * —— 这六个里**没有一个是真实的 `QueryEngineEvent.kind`**（真实的是
 * `stream_text` / `tool_start` / `tool_end` / `done` / `system` / `fatal_error` 等）。
 * 前四个是 **Bridge 出向消息**的 `BridgeOutMessage.type`，后两个是**状态字符串**，
 * 三套词汇被混成了一套。
 *
 * 所以缺陷清单建议的那个"一行修复"——在 `forwardEvent()` 的 switch 前加
 * `if (!isEligibleForBridge(kind)) return` ——**会把 100% 的事件全部过滤掉**，
 * Bridge 直接哑掉。这正是「两套判断会各自漂移，而漂移时不会有任何东西变红」的
 * 极端形态：白名单从来没被生产调用过，所以它漂到完全脱离现实也没人发现，
 * 而它的单测**全绿**（测试喂给它的也是同一套不存在的词）。
 *
 * 现在它按真实事件联合体重写，并成为 `forwardEvent()` 的**唯一**入口过滤。
 * 门禁见 `tests/bridge/eligibility-single-source.test.ts`：那里从
 * `query/types.ts` 里把 `kind:` 全部抽出来比对，确保白名单只包含真实存在的 kind
 * —— 判据是"词汇存在"而不是"集合内容对"，因为后者会随产品判断变，前者不该变。
 */
const BRIDGE_ELIGIBLE_KINDS = new Set<string>([
  // 流式文本增量。⚠️ 它由 setStreamTextCallback 单独转发，不走 forwardEvent，
  // 但仍列在此处：白名单的语义是"对远端用户有意义"，不是"由哪条通道发"。
  "stream_text",
  // 工具生命周期
  "tool_start",
  "tool_end",
  // 轮次结束
  "done",
  // 面向用户的系统提示（forwardEvent 再按 level 收窄到 warning/error）
  "system",
  // 致命错误：必须转发，否则远端只看到"没了下文"
  "fatal_error",
]);

/**
 * 判断一个 Agent 事件是否应发送给远程客户端。
 * 过滤内部调试事件（compact / context_warning / loop_detected / tombstone /
 * user_message_added / retry 等），仅转发对远端用户有意义的事件。
 *
 * **这是过滤规则的唯一真实入口**（D13）：`bridge-runner.ts` 的 `forwardEvent()`
 * 必须先问它。此前 `forwardEvent()` 是一个手写 switch、从不调用本函数，
 * 于是"两套判断"并存 —— 今天恰好一致，但会各自漂移，且漂移时不会有任何东西变红。
 */
export function isEligibleForBridge(eventKind: string): boolean {
  return BRIDGE_ELIGIBLE_KINDS.has(eventKind);
}

/** 白名单快照（供门禁与调试读取，避免测试重新硬编码一份） */
export function eligibleBridgeKinds(): readonly string[] {
  return [...BRIDGE_ELIGIBLE_KINDS];
}
