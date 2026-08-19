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
import { getLogger } from "../debug/index.ts";
import { emitStreamRestart } from "../trace/stream-observer.ts";

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
  /**
   * 上面这些字符里属于**思考**的部分（`discardedTextLength` 的子集）。
   *
   * 为什么要单独拆出来：本文档标题问题问的是"用户丢了多少**思考**内容"，
   * 而思考文本在被杀的那一刻**长得跟普通文本一样** —— GLM/DeepSeek 的
   * `reasoning_content` 增量在 `openai.ts` 里被转成
   * `content_block_start{type:"text", _raw_block:{type:"thinking"}}` + text_delta，
   * 只有等到 `content_block_stop` 才会被就地转型成 `{type:"thinking"}`。
   * **流被掐死在思考中途时那个 stop 永远不会来**，于是块的 `type` 停在 `"text"`。
   *
   * 所以判据不能只看 `block.type`，还要看调用方传进来的 `thinkingIndexes` ——
   * 那是"这个 index 是思考块"的唯一权威来源。不传 `thinkingIndexes` /
   * `indexToPosition` 的消费者（子代理 / forked / 无头）拿到的是 0，
   * 不是"它们没丢思考"，而是**它们没有区分思考的能力** —— 别把 0 读成"没丢"。
   */
  discardedThinkingLength: number;
  /**
   * 被截断的工具入参 JSON 字符数（`jsonAccumulators` 里的残片）。
   *
   * 改造前这部分**完全不可观测**：`discardedBlocks` 会把 `tool_use` 块数进去，
   * 但它对 `discardedTextLength` 贡献恒为 0，于是"一个块 / 0 字符"看起来像
   * "没丢什么"，实际丢的是一串已经拼了一半的工具入参。
   */
  discardedToolJsonLength: number;
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

  // 「哪些数组位置是思考块」——由 SSE index 经 indexToPosition 换算。
  // 两个容器缺任意一个就退化为"只认自描述的 thinking 块"（见 discardedThinkingLength 注释）。
  const thinkingPositions = new Set<number>();
  if (state.thinkingIndexes && state.indexToPosition) {
    for (const idx of state.thinkingIndexes) {
      const pos = state.indexToPosition.get(idx);
      if (pos !== undefined) thinkingPositions.add(pos);
    }
  }

  let discardedTextLength = 0;
  let discardedThinkingLength = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i] as { type?: string; text?: string; thinking?: string };
    let len = 0;
    if (block?.type === "text" && typeof block.text === "string") {
      len = block.text.length;
    } else if (block?.type === "thinking" && typeof block.thinking === "string") {
      len = block.thinking.length;
    }
    discardedTextLength += len;
    // `type === "thinking"` 是已成形的思考块（自描述）；
    // `thinkingPositions` 覆盖"还没等到 content_block_stop、type 仍停在 text"的那些。
    if (block?.type === "thinking" || thinkingPositions.has(i)) {
      discardedThinkingLength += len;
    }
  }

  let discardedToolJsonLength = 0;
  if (state.jsonAccumulators) {
    for (const frag of state.jsonAccumulators.values()) {
      if (typeof frag === "string") discardedToolJsonLength += frag.length;
    }
  }

  // splice 而非重新赋值：容器多为 const 持有，且外部可能已捕获引用。
  state.content?.splice(0, state.content.length);
  state.thinkingBlocks?.splice(0, state.thinkingBlocks.length);
  state.indexToPosition?.clear();
  state.jsonAccumulators?.clear();
  state.thinkingIndexes?.clear();
  state.thinkingStartMs?.clear();

  return {
    discardedBlocks,
    discardedTextLength,
    discardedThinkingLength,
    discardedToolJsonLength,
  };
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
  // 思考/工具入参只在非零时追加：绝大多数重开只丢可见文本，无条件拼两个 0 会让
  // 真正有信息量的那几条淹在噪声里。
  const thinking =
    outcome.discardedThinkingLength > 0
      ? `（其中思考 ${outcome.discardedThinkingLength} 字符）`
      : "";
  const toolJson =
    outcome.discardedToolJsonLength > 0
      ? ` + 未完成的工具入参 ${outcome.discardedToolJsonLength} 字符`
      : "";
  return (
    `流重开（原因=${event.reason}${attempt}）：丢弃上一次尝试已累积的 ` +
    `${outcome.discardedBlocks} 个内容块 / ${outcome.discardedTextLength} 字符${thinking}${toolJson}`
  );
}

/** 四条流事件消费路径。用于把丢弃量按路径归因（它们的区分能力不同，见 `discardedThinkingLength`）。 */
export type StreamRestartConsumer = "main" | "subagent" | "forked" | "headless";

/** 各消费者沿用各自原有的日志 tag —— 换 tag 会让既有的日志检索/告警规则静默失效。 */
const CONSUMER_LOG_TAG: Record<StreamRestartConsumer, string> = {
  main: "STREAM",
  subagent: "AGENT_STREAM",
  forked: "STREAM",
  headless: "STREAM",
};

/**
 * 记录一次流重开的丢弃量 —— **日志 + 结构化轨迹事件的唯一出口**。
 *
 * ## 为什么要有这个函数（它替掉的是四份手写的同一个 if）
 *
 * 改造前四个消费者各写一遍
 * `if (outcome.discardedBlocks > 0 || outcome.discardedTextLength > 0) log.warn(...)`。
 * 与 {@link resetOnStreamRestart} 当初被抽出来的理由完全相同：**四份手写必然漂移**，
 * 而且这次漂移的是"什么算值得记一笔"这个判据本身。
 *
 * ## 日志有条件、事件无条件 —— 这不是不一致，是两个受众
 *
 * - **日志**给人读：零丢弃的重开不是警告，打出来只会淹掉真有损失的那几条。
 * - **事件**给离线复算读：**必须含零丢弃的那些，否则没有分母**。
 *   本仓铁律「分母比分子重要」—— 只有分子时，"丢弃变少了"既可能是修复生效，
 *   也可能只是重开次数变少了，两者结论完全相反。
 *
 * 实测过的代价：改造前一次会话 23 次重开只在 `warn.log` 留下 **2 行**，
 * 而 `events.jsonl` 里一个字都没有 —— 拿那 2 行当分母会得出"本来就几乎不丢"的错误结论。
 */
export function recordStreamRestart(
  event: Extract<StreamEvent, { type: "stream_restart" }>,
  outcome: StreamRestartOutcome,
  consumer: StreamRestartConsumer,
): void {
  const lost =
    outcome.discardedBlocks > 0 ||
    outcome.discardedTextLength > 0 ||
    outcome.discardedToolJsonLength > 0;
  if (lost) {
    getLogger().warn(CONSUMER_LOG_TAG[consumer], describeStreamRestart(event, outcome));
  }
  emitStreamRestart({
    reason: event.reason,
    attempt: event.attempt,
    discarded_blocks: outcome.discardedBlocks,
    discarded_chars: outcome.discardedTextLength,
    discarded_thinking_chars: outcome.discardedThinkingLength,
    discarded_tool_json_chars: outcome.discardedToolJsonLength,
    consumer,
  });
}
