/**
 * 流重开（`stream_restart`）的**共享作废语义**。
 *
 * 存在理由（2026-08-04 事故根因修复）：`fallback.ts` 在流中途失败时重开的是一个
 * **全新请求**（不是断点续传），语义上「前一次尝试产出的内容块全部作废」。这个语义
 * 此前从未传递给消费方——消费方的累加器声明在事件循环之外、跨重试存活，且
 * `content_block_start` 用 `content.length` 追加位置，于是第一次尝试的残骸被**焊死在**
 * 第二次完整响应前面，产出一条协议合法、语义错乱的 assistant 消息。
 *
 * 为什么抽成共享模块而不是各消费者各写一遍：流事件有**四个**独立消费者
 * （主循环 / 子代理 / 无头 / API handler），四份手写重置逻辑必然漂移——本仓库
 * 已经为「手写字段列表」「手写分派链」这类同病付过代价（见消息保真第 5 批）。
 * 这里把「作废时该清什么」收敛成唯一事实源，新增累加状态时只需改一处。
 *
 * @see {@link resetOnStreamRestart}
 */

import type { StreamEvent } from "./types.ts";

/**
 * 一次流重开需要清空的累加状态。
 *
 * 各字段可选：不同消费者累加的状态不同（如无头模式不收集 thinking 块）。
 * 传进来的容器**原地清空**（不返回新对象），因为调用方普遍用 `const` 持有它们。
 */
export interface StreamAccumulatorState {
  /** 已累积的内容块数组（原地清空） */
  content?: unknown[];
  /** SSE index → content 数组位置的映射（原地清空） */
  indexToPosition?: Map<number, number>;
  /** 工具输入 JSON 分片累加器（原地清空） */
  jsonAccumulators?: Map<number, string>;
  /** 被标记为 thinking 的 index 集合（原地清空） */
  thinkingIndexes?: Set<number>;
  /** 各 thinking 块的起始时间戳（原地清空） */
  thinkingStartMs?: Map<number, number>;
  /** 已收集的 thinking 块（轨迹采集用，原地清空） */
  thinkingBlocks?: unknown[];
}

/** {@link resetOnStreamRestart} 的返回值，供调用方按需记录/上报。 */
export interface StreamRestartOutcome {
  /** 本次作废丢弃了多少个已累积的内容块（0 表示重开前未产出内容） */
  discardedBlocks: number;
  /** 作废前已流出的文本字符数（>0 意味着用户屏幕上有需要撤回的内容） */
  discardedTextLength: number;
}

/**
 * 按 `stream_restart` 契约清空累加状态。
 *
 * **刻意不动 usage**：作废尝试消耗的 token 是**真实计费**的，回退会让 cost 少采——
 * 与本项目「更省」方向所依赖的度量准确性直接冲突（仓库已记录过「cost 三重少采」的
 * 教训）。作废的是**语义内容**，不是**已花的钱**。
 *
 * **刻意不动 stopReason**：重开意味着上一次没有有效的终止原因，而下一次尝试的
 * `message_delta` 会覆盖它；这里清成 null 反而会在「重开后流立刻断开」时把一个
 * 本可用于判定的旧值抹掉。
 *
 * @param state 要清空的累加状态容器（原地修改）
 * @returns 被丢弃的内容规模，供调用方决定是否需要通知 UI 撤回
 */
export function resetOnStreamRestart(state: StreamAccumulatorState): StreamRestartOutcome {
  const blocks = state.content ?? [];
  const discardedBlocks = blocks.length;
  let discardedTextLength = 0;
  for (const b of blocks) {
    const block = b as { type?: string; text?: string; thinking?: string };
    if (block?.type === "text" && typeof block.text === "string") {
      discardedTextLength += block.text.length;
    } else if (block?.type === "thinking" && typeof block.thinking === "string") {
      discardedTextLength += block.thinking.length;
    }
  }

  // splice 而非重新赋值：容器多为 const 持有，且外部可能已捕获引用。
  state.content?.splice(0, state.content.length);
  state.thinkingBlocks?.splice(0, state.thinkingBlocks.length);
  state.indexToPosition?.clear();
  state.jsonAccumulators?.clear();
  state.thinkingIndexes?.clear();
  state.thinkingStartMs?.clear();

  return { discardedBlocks, discardedTextLength };
}

/**
 * 供日志/遥测使用的统一描述串。
 *
 * 归因铁律（本仓库已记录的「归因与真实信号脱节」反模式）：`reason` 一律取
 * provider/fallback 层发出的**真实信号**（network_error / auth_refresh /
 * fallback_switch / idle_timeout …），不在此处二次猜测成因。
 */
export function describeStreamRestart(
  event: Extract<StreamEvent, { type: "stream_restart" }>,
  outcome: StreamRestartOutcome,
): string {
  const attempt = event.attempt !== undefined ? `，第 ${event.attempt} 次重试` : "";
  return (
    `流重开（原因=${event.reason}${attempt}）：丢弃上一次尝试已累积的 ` +
    `${outcome.discardedBlocks} 个内容块 / ${outcome.discardedTextLength} 字符`
  );
}
