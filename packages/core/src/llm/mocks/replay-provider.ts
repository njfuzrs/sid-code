// src/llm/mocks/replay-provider.ts
// 录制回放（VCR）——把一次真实会话重放成 LLM 响应流
//
// 缺陷清单 P2-11：「无录制回放能力，无法把一次真实故障会话固化成可重放的测试用例」。
// 它的价值不在"又一个 mock"，而在**把个案排查升级成回归测试**：线上出一次怪问题，
// 目前只能靠人翻 raw.jsonl 手工比对；有了回放，那次会话本身就是一个可重复执行的用例。
//
// ─────────────────────────────────────────────────────────────
// 与 claude-code 的 services/vcr.ts 是**不同的设计**，这是刻意的
// ─────────────────────────────────────────────────────────────
//
// CC 的 VCR 是「按输入 hash 找 fixture 文件，没有就真发请求并录一份」——录制与回放
// 耦合在同一个函数里，fixture 是专为测试新造的一种文件。
//
// 本仓库**不该照抄那个形状**，因为录制半边早就存在了：`raw.jsonl` 存的正是
// 完整的 request/response pair（`src/trace/writer.ts` 的 `RawJsonlEntry`），
// 每个真实会话都在落盘，本机已有 1000+ 会话的语料。再造一套 fixture 格式等于：
//   1. 重复实现一遍已经在跑的录制逻辑；
//   2. 把「能回放的会话」局限在**专门为测试录过**的那些，而真实故障会话
//      （最有价值的那些）反而放不了——那正好是这条缺陷想解决的问题。
//
// 所以这里只做**回放**半边，录制直接复用 raw.jsonl。判断依据是那句纪律：
// 「先查后修」——查证发现前提变了（录制已存在），就不该按原方案的形状落地。
//
// ─────────────────────────────────────────────────────────────
// raw.jsonl 的两个真实特征（已按本机实际文件核验，不是照类型定义猜的）
// ─────────────────────────────────────────────────────────────
//
// 1. **两种行**混在一个文件里：
//      {"type":"request_sent", ...}  —— 只是"请求已发出"的标记，无响应
//      {index, request, response, usage, ...}  —— 完整 pair（**无 type 字段**）
//    回放只认后者。靠"无 type 字段"识别，与 collector 的写入逻辑一致。
//
// 2. **request 是增量的**：只有 index=1 那行带完整 `messages` / `system` / `tools`，
//    后续行只有 `new_messages` + `_messages_count`。所以不能假设每行都有完整上下文。
//    回放按 index 顺序出响应，不依赖请求侧字段——这反而让它对增量格式天然免疫。
//
// ─────────────────────────────────────────────────────────────
// 使用注意：辅助调用也会消耗轮次
// ─────────────────────────────────────────────────────────────
//
// 一次会话里发请求的不止主循环：memory-extract、标题生成、compact 摘要等**辅助调用**
// （影子调用）也会走 provider。所以用一份「只录了 1 轮」的录制跑 CLI 时，主轮答完之后
// 那些辅助调用会继续要响应，`onExhausted: "end-turn"` 下它们各拿到一个空响应，日志里
// 会出现一条 `错误无法分类为可重试…响应为空` 的 FALLBACK 警告。
//
// **这不是回放器的 bug**，是录制轮数不够。已实测：把录制补到 2 轮，该警告消失。
// 要完整复现一次会话，请用那次会话**完整的** raw.jsonl（它本来就含全部辅助调用的 pair）。

import type { Provider, ProviderCapabilities } from "../provider.ts";
import type { SendParams, StreamEvent, ContentBlock, Usage } from "../types.ts";

/** raw.jsonl 里一条完整 pair（只声明回放需要的字段，其余原样忽略） */
interface RawPair {
  index: number;
  model?: string;
  timestamp?: string;
  request?: {
    model?: string;
    system?: unknown;
    messages?: unknown[];
    new_messages?: unknown[];
    tools?: unknown[];
  };
  response?: {
    content?: unknown[];
    stop_reason?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  stop_reason?: string;
  is_partial?: boolean;
}

/** 一次回放的单轮数据（对外可见，供测试断言"回放了什么"） */
export interface ReplayTurn {
  index: number;
  model: string;
  content: ContentBlock[];
  stopReason: string;
  usage: Usage;
  isPartial: boolean;
}

export interface ReplayProviderOptions {
  /**
   * 轮次耗尽后的行为。
   *
   * - `"throw"`（默认）：抛错。**这是刻意的默认值**——回放用例的关键断言之一往往是
   *   「主循环恰好跑了 N 轮」，静默返回空响应会把「多跑了一轮」这种回归伪装成通过。
   * - `"repeat-last"`：重复最后一轮。用于只关心某一轮行为、不关心轮数的场景。
   * - `"end-turn"`：返回一个空的 end_turn 响应，让主循环自然收尾。
   */
  onExhausted?: "throw" | "repeat-last" | "end-turn";
  /** 覆盖 provider 名（默认 "replay"） */
  name?: string;
}

/**
 * 解析 raw.jsonl 文本为可回放的轮次序列。
 *
 * 容错策略：**坏行跳过而非整体失败**。raw.jsonl 是 append 写的，进程被 kill 时
 * 末行可能是半条 JSON；因为一行残缺就让整个会话无法回放，等于把最有价值的
 * 「崩溃会话」排除在回放能力之外——而那恰恰是最需要复现的一类。
 */
export function parseRawJsonl(text: string): ReplayTurn[] {
  const turns: ReplayTurn[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // 半条 JSON（进程被 kill 时的末行）——跳过，不放弃整个文件
    }
    if (obj === null || typeof obj !== "object") continue;

    const pair = obj as RawPair & { type?: string };
    // 只要完整 pair。`type` 字段是 request_sent / 其它标记行的特征。
    if (typeof pair.type === "string") continue;
    if (!pair.response || !Array.isArray(pair.response.content)) continue;

    turns.push({
      index: typeof pair.index === "number" ? pair.index : turns.length + 1,
      model: pair.request?.model ?? pair.model ?? "replay-model",
      content: pair.response.content as ContentBlock[],
      // stop_reason 顶层与 response 内各有一份（顶层是给 merger.py 的冗余），
      // 优先 response 内的——那是更贴近 provider 原始返回的位置。
      stopReason: pair.response.stop_reason ?? pair.stop_reason ?? "end_turn",
      usage: {
        inputTokens: pair.usage?.input_tokens ?? 0,
        outputTokens: pair.usage?.output_tokens ?? 0,
        cacheReadInputTokens: pair.usage?.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: pair.usage?.cache_creation_input_tokens ?? 0,
      },
      isPartial: pair.is_partial === true,
    });
  }
  // 按 index 排序：resume 续接的会话里行序可能与 index 不完全一致
  turns.sort((a, b) => a.index - b.index);
  return turns;
}

/**
 * 把一组 ContentBlock 还原成 StreamEvent 序列。
 *
 * 这是回放保真度的核心。**必须逐块发 start/delta/stop**，不能图省事把整个
 * content 数组一次性塞进一个事件——下游 `processStream` 的累加器、
 * index→position 映射、thinking 计时全都是靠这个事件序列驱动的。
 * 一次性塞进去的话，回放能"跑通"但走的是与生产完全不同的代码路径，
 * 那就失去了回归测试的意义（测不到真正会出问题的那段逻辑）。
 */
export function* blocksToStreamEvents(
  content: ContentBlock[],
  stopReason: string,
  usage: Usage,
): Generator<StreamEvent> {
  yield {
    type: "message_start",
    message: { usage: { inputTokens: usage.inputTokens, outputTokens: 0 } },
  };

  for (let i = 0; i < content.length; i++) {
    const block = content[i]!;

    switch (block.type) {
      case "text": {
        yield { type: "content_block_start", index: i, content_block: { type: "text", text: "" } };
        if (block.text) {
          yield {
            type: "content_block_delta",
            index: i,
            delta: { type: "text_delta", text: block.text },
          };
        }
        yield { type: "content_block_stop", index: i };
        break;
      }
      case "thinking": {
        yield {
          type: "content_block_start",
          index: i,
          content_block: {
            type: "thinking",
            thinking: "",
            ...(block.signature ? { signature: block.signature } : {}),
          },
        };
        if (block.thinking) {
          // thinking 的增量走 text_delta（与 provider 侧一致：thinking_delta 在
          // 本仓库的 StreamEvent 里归一化成了 text_delta，由 index 所属块类型区分）
          yield {
            type: "content_block_delta",
            index: i,
            delta: { type: "text_delta", text: block.thinking },
          };
        }
        yield { type: "content_block_stop", index: i };
        break;
      }
      case "tool_use": {
        // tool_use 的 input 在真实流里是**分片的 JSON 字符串**（input_json_delta）。
        // 回放必须也走分片路径：`input={}` 那个真实事故（截断的 input_json_delta +
        // 未到达的 content_block_stop）只在这条路径上才可能被测到。
        yield {
          type: "content_block_start",
          index: i,
          content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
        };
        const json = safeJson(block.input);
        if (json !== undefined) {
          yield {
            type: "content_block_delta",
            index: i,
            delta: { type: "input_json_delta", partial_json: json },
          };
        }
        yield { type: "content_block_stop", index: i };
        break;
      }
      case "redacted_thinking": {
        yield {
          type: "content_block_start",
          index: i,
          content_block: { type: "redacted_thinking", data: block.data },
        };
        yield { type: "content_block_stop", index: i };
        break;
      }
      default:
        // 未知块类型原样透传 start/stop：不认识不等于该丢掉。
        // （本仓库已记录的教训：手写字段列表 / 手写分派链会静默丢块，
        //  默认透传 + default 兜底才是正解。）
        yield { type: "content_block_start", index: i, content_block: block as ContentBlock };
        yield { type: "content_block_stop", index: i };
        break;
    }
  }

  yield {
    type: "message_delta",
    delta: { stop_reason: stopReason },
    usage,
  };
  yield { type: "message_stop" };
}

/** JSON 序列化 tool_use.input；已是字符串则原样用（provider 间形态不一） */
function safeJson(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return undefined;
  }
}

/**
 * 回放 Provider——按录制顺序逐轮返回响应。
 *
 * 不做「按请求内容匹配」（CC 的 fixture-by-hash 思路），而是**按轮次顺序**。原因：
 * 回放的目的是复现「主循环在这串响应下会怎么走」，而请求内容里含 cwd、时间戳、
 * 随机 tool_use_id——按内容 hash 匹配会因为这些无关差异全部 miss（CC 的 dehydrate
 * 函数有一大半篇幅就在处理这个）。按顺序回放没有这类脆弱性。
 *
 * 代价是它**不校验**「主循环发出的请求是否与录制时一致」。需要那个校验的用例可以
 * 自己用 `getReceivedParams()` 断言，比把校验硬编码进回放器更灵活。
 */
export class ReplayProvider implements Provider {
  private turns: ReplayTurn[];
  private cursor = 0;
  private receivedParams: SendParams[] = [];
  private opts: Required<Pick<ReplayProviderOptions, "onExhausted">> & { name: string };

  constructor(turns: ReplayTurn[], options: ReplayProviderOptions = {}) {
    this.turns = turns;
    this.opts = {
      onExhausted: options.onExhausted ?? "throw",
      name: options.name ?? "replay",
    };
  }

  /** 从 raw.jsonl 文本构造 */
  static fromRawJsonl(text: string, options?: ReplayProviderOptions): ReplayProvider {
    return new ReplayProvider(parseRawJsonl(text), options);
  }

  /** 从 raw.jsonl 文件路径构造 */
  static async fromFile(path: string, options?: ReplayProviderOptions): Promise<ReplayProvider> {
    const text = await Bun.file(path).text();
    return ReplayProvider.fromRawJsonl(text, options);
  }

  /**
   * 同步版文件构造。
   *
   * 存在的唯一理由：`registry.ts` 的 `createProvider()` 是**同步**的（刻意用 require
   * 避免顶层 await），而回放要能从 registry 走通才算真的接线——否则它就又是一份
   * 「写好了但配置层进不去」的资产，与本清单 P0-3 一模一样的失效形态。
   */
  static fromFileSync(path: string, options?: ReplayProviderOptions): ReplayProvider {
    const { readFileSync } = require("node:fs");
    return ReplayProvider.fromRawJsonl(readFileSync(path, "utf-8"), options);
  }

  name(): string {
    return this.opts.name;
  }

  capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      tools: true,
      // 录制里可能真的有 thinking 块，声明支持才不会被上游能力过滤掉
      thinking: true,
      vision: true,
      promptCaching: true,
      parallelToolCalls: true,
    };
  }

  /** 已回放轮数 */
  getReplayedCount(): number {
    return this.cursor;
  }

  /** 总轮数 */
  getTotalTurns(): number {
    return this.turns.length;
  }

  /** 主循环实际发出的请求参数（供用例断言「发了什么」） */
  getReceivedParams(): readonly SendParams[] {
    return this.receivedParams;
  }

  /** 重置游标（跨 case 复用同一份录制） */
  reset(): void {
    this.cursor = 0;
    this.receivedParams = [];
  }

  async *sendMessageStream(params: SendParams, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.receivedParams.push(params);

    // 尊重 abort：回放也要能测「用户中途 ESC」的路径
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
    }

    const turn = this.nextTurn();
    if (!turn) {
      // onExhausted="end-turn"：给一个空的 end_turn 让主循环自然收尾
      yield { type: "message_start", message: { usage: { inputTokens: 0, outputTokens: 0 } } };
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { inputTokens: 0, outputTokens: 0 },
      };
      yield { type: "message_stop" };
      return;
    }

    for (const ev of blocksToStreamEvents(turn.content, turn.stopReason, turn.usage)) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
      }
      yield ev;
    }
  }

  /** 取下一轮；耗尽时按 onExhausted 处理（返回 null 表示"发空 end_turn"） */
  private nextTurn(): ReplayTurn | null {
    if (this.cursor < this.turns.length) {
      return this.turns[this.cursor++]!;
    }
    switch (this.opts.onExhausted) {
      case "repeat-last": {
        const last = this.turns[this.turns.length - 1];
        if (!last) {
          throw new Error("ReplayProvider: 录制为空，无可重复的轮次");
        }
        this.cursor++;
        return last;
      }
      case "end-turn":
        this.cursor++;
        return null;
      case "throw":
      default:
        throw new Error(
          `ReplayProvider: 录制已耗尽（共 ${this.turns.length} 轮，请求第 ${this.cursor + 1} 轮）。` +
            `若用例不关心轮数，构造时传 onExhausted: "end-turn" 或 "repeat-last"。`,
        );
    }
  }
}

/** 工厂函数（与 createMockProvider 形状一致） */
export function createReplayProvider(
  turns: ReplayTurn[],
  options?: ReplayProviderOptions,
): Provider {
  return new ReplayProvider(turns, options);
}
