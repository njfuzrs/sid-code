/**
 * openai-responses.ts — OpenAI Responses API 流式事件解析器
 *
 * T11：将 Responses API 的 SSE 事件（response.created / response.output_item.added /
 * response.output_text.delta / response.function_call_arguments.delta 等）转换为
 * 统一的 StreamEvent 序列，供 StreamLifecycle / fallback.ts 消费。
 *
 * 设计原则：
 *   - Provider 只负责协议适配（Responses SSE → StreamEvent）
 *   - 超时/重试/abort 在应用层由 StreamLifecycle 统一管理
 *   - 通过 isContentProgress(event) 告知哪些事件算"业务进展"
 *
 * Responses API 事件生命周期（正常流）：
 *   response.created
 *   response.in_progress
 *   response.output_item.added        (item = message | function_call)
 *   response.content_part.added       (part = text | reasoning)
 *   response.output_text.delta        (text 增量)
 *   response.output_text.done         (text 完整)
 *   response.content_part.done
 *   response.output_item.done
 *   response.completed                (含 usage)
 *
 * 工具调用流：
 *   response.output_item.added        (item.type = "function_call")
 *   response.function_call_arguments.delta
 *   response.function_call_arguments.done
 *   response.output_item.done
 *
 * 推理流（o-series）：
 *   response.reasoning_summary_text.delta  (推理摘要增量)
 *   response.reasoning_summary_text.done
 *
 * 参考：
 *   - https://platform.openai.com/docs/api-reference/responses-streaming
 *   - Vercel AI SDK: packages/openai/src/openai-chat-language-model.ts
 */

import { splitSSELines, parseSSEField, isDoneSentinel } from "./sse-line.ts";
import type { ProviderReasoningBlock, StreamEvent, Usage } from "./types.ts";
import { getLogger } from "../debug/logger.ts";
import { applyResponsesUsage } from "./openai-usage.ts";

// ─── Responses API 事件类型定义 ───

/** Responses API SSE 事件（所有事件的共通结构） */
export interface ResponsesStreamEvent {
  /** 事件类型（response.created / response.output_text.delta 等） */
  type: string;
  /** 序列号（单调递增，用于乱序检测） */
  sequence_number?: number;

  // response.created / response.completed / response.failed
  response?: ResponseObject;

  // output_item 相关
  output_index?: number;
  item?: OutputItem;

  // content_part 相关
  content_index?: number;
  part?: ContentPart;

  // text delta
  delta?: string;
  text?: string;

  // function call
  item_id?: string;
  name?: string;
  arguments?: string;

  // error
  error?: { message: string; code?: string };
}

interface ResponseObject {
  id: string;
  status: string;
  usage?: ResponsesUsage;
  output?: OutputItem[];
  /** 终态 incomplete 时的原因（content_filter / max_output_tokens），与非流式 body 同字段 */
  incomplete_details?: { reason?: string };
}

/**
 * Responses API 的 usage 形状 —— 与 Chat Completions **键名不同**，这是第三种形态。
 *
 * | 维度 | Chat Completions | Responses |
 * | --- | --- | --- |
 * | 输入 | `prompt_tokens` | `input_tokens` |
 * | 缓存命中 | `prompt_tokens_details.cached_tokens` | `input_tokens_details.cached_tokens` |
 * | 推理 | `completion_tokens_details.reasoning_tokens` | `output_tokens_details.reasoning_tokens` |
 *
 * 历史坑（2026-08-08 修复）：本类型此前只声明 `input_tokens/output_tokens/total_tokens`
 * 三个字段，映射处也只读这三个 —— 导致**整个 openai-responses 族 11 个模型**
 * （gpt-5.2 / 5.4 系 / 5.5 系 / 5.6 系含 luna/sol/terra）的缓存命中与 reasoning
 * token 全部漏采。漏采表现为账本命中率恒接近 0（luna 实测记成 2.2%，真实 95.2%），
 * 曾被误判为"网关后端不支持前缀缓存"。判断"同代码路径"必须核实协议分派，
 * 不能只看 provider 与 base_url 相同。
 */
export interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

export interface OutputItem {
  id: string;
  type: "message" | "function_call" | "reasoning";
  status?: string;
  role?: string;
  content?: ContentPart[];
  // function_call 特有
  call_id?: string;
  name?: string;
  arguments?: string;
  /** reasoning item 的摘要（流式对应 response.reasoning_summary_text.delta） */
  summary?: { type?: string; text?: string }[];
  /** reasoning item 的密文（store:false 时默认下发，回放必需） */
  encrypted_content?: string;
}

/**
 * `content_part.added` / `reasoning_summary_part.added` 的 part 载荷。
 *
 * ⚠️ 三个字面量都取自 OpenAI 规范，**不要凭直觉加 `"reasoning"`**：
 * - `content_part.added` 的 part 只能是 `output_text` / `refusal` / `reasoning_text`
 *   （openapi.yaml:54571-54575 的 `OutputContent` oneOf；`ReasoningTextContent.type`
 *   枚举值是 **`reasoning_text`**，openapi.yaml:75568-75574）；
 * - `reasoning_summary_part.added` 的 part 只能是 `summary_text`
 *   （openapi.yaml:68746-68755）。
 *
 * 此前这里写的是 `"reasoning"` —— 那个值在规范里**不存在**，导致推理块判据恒不命中，
 * 推理摘要被当正文发出。教训：协议字面量必须回源码规范核对，不能按语义猜。
 */
interface ContentPart {
  type: "output_text" | "reasoning_text" | "refusal" | "summary_text";
  text?: string;
  annotations?: unknown[];
}

// ─── 状态机 ───

/**
 * 一个 function_call output item 的累积状态。
 *
 * ⛔ 每个工具调用**自带** content block index，不要改回共用全局 `blockIndex`。
 * 2026-11-03 事故（会话 20261103-153824-062a9640，gpt-6.1-sol @ code.ppchat.vip）：
 * 并行工具调用时网关**不发** `function_call_arguments.delta`，完整参数只出现在
 * `function_call_arguments.done.arguments` 与 `output_item.done.item.arguments`。
 * 旧实现既不读这两个字段、又让所有块共用一个递增计数器，于是 3 个并行调用的参数
 * 全部落成 `{}`，被 F1 空参数检测作废重试 —— 看起来像「模型退化」，实为解析器丢数据。
 * 同一缺陷的另一形态：参数增量交错到达时，几段 JSON 会被拼进同一个块。
 */
interface ToolCallState {
  /** 该调用独占的 content block index（output_item.added 时分配，终身不变） */
  index: number;
  /** content_block_start 时发出的身份；收尾时若与最终值不同，经 stop.tool_use 修订 */
  startedId: string;
  startedName: string;
  id: string;
  name: string;
  /** 已经以 input_json_delta 发出的参数（= 消费方累加器里的内容） */
  emitted: string;
  /** 已发 content_block_stop —— 同一调用的 args.done 与 output_item.done 都会触发收尾，只收一次 */
  closed: boolean;
}

interface ParserState {
  /** 下一个可分配的 content block index（单调递增，每个块开块时取一个，块之间互不复用） */
  nextIndex: number;
  /** 当前打开的正文块 index（null = 没有打开的正文块） */
  openTextIndex: number | null;
  /** 当前打开的思考块 index（null = 不在思考块中） */
  openReasoningIndex: number | null;
  /** 工具调用状态（按 output item id） */
  toolCalls: Map<string, ToolCallState>;
  /** output_index → output item id（事件缺 item_id 时的回落路由） */
  outputIndexToItem: Map<number, string>;
  /** usage（从 response.completed 提取） */
  usage: Usage;
  /** 是否已 yield message_start */
  started: boolean;
  /**
   * 本次响应是否出现过 function_call（发现 5，2026-10-21）。
   * 终态映射 stop_reason 要用它：Responses 的 status 在带工具调用时仍是 `completed`。
   */
  sawToolCall: boolean;
  /** 本次请求的真实模型名，写进 provider_reasoning 块（密文绑定模型，跨模型回放要丢弃） */
  model: string;
}

// ─── 解析器主体 ───

/**
 * 将 Responses API 的 SSE 字节流解析为统一 StreamEvent 序列。
 *
 * @param stream - fetch response body（text/event-stream）
 * @param signal - abort signal（穿透到字节读取层）
 */
export async function* parseResponsesStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  opts?: { model?: string },
): AsyncIterable<StreamEvent> {
  const log = getLogger();
  const state: ParserState = {
    nextIndex: 0,
    openTextIndex: null,
    openReasoningIndex: null,
    toolCalls: new Map(),
    outputIndexToItem: new Map(),
    usage: { inputTokens: 0, outputTokens: 0 },
    started: false,
    sawToolCall: false,
    model: opts?.model ?? "",
  };

  for await (const event of readSSEEvents(stream, signal)) {
    const events = mapResponseEvent(event, state, log);
    for (const e of events) {
      yield e;
    }
  }
}

/**
 * 判断 Responses API 事件是否构成"业务进展"（用于 StreamLifecycle content progress timeout）。
 * text delta / function_call_arguments.delta / reasoning delta = 进展
 * response.created / content_part.added 等结构事件 = 非进展（类似 keep-alive）
 */
export function isResponsesContentProgress(event: StreamEvent): boolean {
  // 实际判断基于转换后的 StreamEvent
  return event.type === "content_block_delta";
}

// ─── 事件映射（核心逻辑） ───

/**
 * 开一个思考块（记下 `openReasoningIndex` + 发 `content_block_start`）。
 *
 * 抽成函数是因为**三处**都要开思考块：`content_part.added`（part 为 `reasoning_text`）、
 * `reasoning_summary_part.added`，以及没有 part.added 就直接来的摘要增量。各写一份
 * 就又回到"同一语义两份实现、其中一份漏了"的老形态。
 *
 * 幂等：已在思考块中时不重复开块。真实流里 `reasoning_summary_part.added` 可能
 * 对同一 item 发多次（`summary_index` 递增），重复开块会让 start/stop 失配。
 */
function openThinkingBlock(state: ParserState): StreamEvent[] {
  if (state.openReasoningIndex !== null) return [];
  const index = state.nextIndex++;
  state.openReasoningIndex = index;
  return [
    {
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "" },
      _raw_block: { type: "thinking" },
    } as StreamEvent,
  ];
}

/** 开一个正文块（幂等：已有打开的正文块时复用） */
function openTextBlock(state: ParserState, results: StreamEvent[]): number {
  if (state.openTextIndex !== null) return state.openTextIndex;
  const index = state.nextIndex++;
  state.openTextIndex = index;
  results.push({
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" },
  } as StreamEvent);
  return index;
}

/**
 * 按事件找到它所属的工具调用：优先 `item_id`，缺席时回落 `output_index`。
 * 两者都对不上返回 undefined —— 调用方丢弃该事件，不猜「大概是最后一个」。
 */
function findToolCall(raw: ResponsesStreamEvent, state: ParserState): ToolCallState | undefined {
  if (raw.item_id) {
    const tc = state.toolCalls.get(raw.item_id);
    if (tc) return tc;
  }
  if (typeof raw.output_index === "number") {
    const id = state.outputIndexToItem.get(raw.output_index);
    if (id) return state.toolCalls.get(id);
  }
  return undefined;
}

/** 登记一个工具调用并发 content_block_start（output_item.added，或 done 先于 added 时补开） */
function openToolCall(
  item: OutputItem,
  outputIndex: number | undefined,
  state: ParserState,
  results: StreamEvent[],
): ToolCallState {
  state.sawToolCall = true;
  const id = item.call_id ?? item.id ?? "";
  const name = item.name ?? "";
  const tc: ToolCallState = {
    index: state.nextIndex++,
    startedId: id,
    startedName: name,
    id,
    name,
    emitted: "",
    closed: false,
  };
  state.toolCalls.set(item.id, tc);
  if (typeof outputIndex === "number") state.outputIndexToItem.set(outputIndex, item.id);
  results.push({
    type: "content_block_start",
    index: tc.index,
    content_block: { type: "tool_use", id, name, input: {} },
  } as StreamEvent);
  return tc;
}

/**
 * 收尾一个工具调用：以**权威完整参数**（done 事件携带）为准，补齐/修订后发 stop。
 *
 * - 权威值以已发增量为前缀（含「一个增量都没发」的网关形态）：把剩余部分作为一条
 *   `input_json_delta` 补发 —— 所有消费方都只靠增量累加，这样无需改消费方即正确。
 * - 不是前缀（网关增量与终值矛盾）：经 `content_block_stop.tool_use.input_json`
 *   让消费方整段替换，并告警 —— 终值是规范定义的完整参数，增量只是流式预览。
 * - 权威值缺席（网关连 done 都不带 arguments）：以已累积的增量为准。
 */
function closeToolCall(
  tc: ToolCallState,
  final: { arguments?: unknown; name?: string; id?: string },
  state: ParserState,
  results: StreamEvent[],
  log: ReturnType<typeof getLogger>,
): void {
  if (tc.closed) return;
  tc.closed = true;
  if (final.name) tc.name = final.name;
  if (final.id) tc.id = final.id;

  let revisedJson: string | undefined;
  if (typeof final.arguments === "string" && final.arguments !== tc.emitted) {
    if (final.arguments.startsWith(tc.emitted)) {
      results.push({
        type: "content_block_delta",
        index: tc.index,
        delta: { type: "input_json_delta", partial_json: final.arguments.slice(tc.emitted.length) },
      } as StreamEvent);
    } else {
      log.warn(
        "RESPONSES",
        `工具调用 ${tc.name} 的参数增量与 done 终值不一致，以终值为准` +
          `（增量 ${tc.emitted.length} 字符，终值 ${final.arguments.length} 字符）`,
      );
      revisedJson = final.arguments;
    }
    tc.emitted = final.arguments;
  }

  const identityChanged = tc.id !== tc.startedId || tc.name !== tc.startedName;
  results.push({
    type: "content_block_stop",
    index: tc.index,
    ...(identityChanged || revisedJson !== undefined
      ? {
          tool_use: {
            id: tc.id,
            name: tc.name,
            ...(revisedJson !== undefined ? { input_json: revisedJson } : {}),
          },
        }
      : {}),
  } as StreamEvent);
}

function mapResponseEvent(
  raw: ResponsesStreamEvent,
  state: ParserState,
  log: ReturnType<typeof getLogger>,
): StreamEvent[] {
  const results: StreamEvent[] = [];

  switch (raw.type) {
    // ─── 生命周期事件 ───
    case "response.created":
    case "response.in_progress": {
      if (!state.started) {
        state.started = true;
        results.push({
          type: "message_start",
          message: { usage: { ...state.usage } },
        } as StreamEvent);
      }
      break;
    }

    // ─── Output Item 添加 ───
    case "response.output_item.added": {
      if (!state.started) {
        state.started = true;
        results.push({
          type: "message_start",
          message: { usage: { ...state.usage } },
        } as StreamEvent);
      }

      const item = raw.item;
      // 不再要求 item.name 非空：name 缺席时照样开块，收尾经 stop.tool_use 修订。
      // 旧判据 `&& item.name` 会让无名首片的调用连块都没有，参数全部丢失。
      if (item?.type === "function_call" && !state.toolCalls.has(item.id)) {
        openToolCall(item, raw.output_index, state, results);
      }
      break;
    }

    // ─── Content Part 添加 ───
    case "response.content_part.added": {
      const part = raw.part;
      if (part?.type === "output_text") {
        openTextBlock(state, results);
      } else if (part?.type === "reasoning_text") {
        // 规范字面量是 reasoning_text（openapi.yaml:75568-75574），不是 "reasoning"。
        results.push(...openThinkingBlock(state));
      }
      break;
    }

    // ─── Reasoning Summary Part 添加 ───
    // 真实流里推理摘要走的是**这个**事件（openapi.yaml:68718-68768），而不是
    // content_part.added —— 此前完全没有这个 case，是推理摘要串进正文的直接原因：
    // 思考块永不打开 → 后续 reasoning_summary_text.delta 被当正文 text_delta。
    case "response.reasoning_summary_part.added": {
      // part.type 恒为 summary_text（openapi.yaml:68746-68755）。这里不校验 part
      // 而是无条件开思考块：事件名本身已经确定了语义，多一层判据只会在网关
      // 省略 part 字段时再制造一次静默丢失。
      results.push(...openThinkingBlock(state));
      break;
    }

    // ─── Text Delta ───
    case "response.output_text.delta": {
      if (raw.delta) {
        // 缺了 content_part.added 的网关形态也能落位：没有打开的正文块就现开一个
        const index = openTextBlock(state, results);
        results.push({
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: raw.delta },
        } as StreamEvent);
      }
      break;
    }

    // ─── Text Done ───
    case "response.output_text.done": {
      if (state.openTextIndex !== null) {
        results.push({ type: "content_block_stop", index: state.openTextIndex } as StreamEvent);
        state.openTextIndex = null;
      }
      break;
    }

    // ─── Reasoning Delta ───
    case "response.reasoning_summary_text.delta": {
      if (raw.delta) {
        results.push(...openThinkingBlock(state));
        results.push({
          type: "content_block_delta",
          index: state.openReasoningIndex!,
          delta: { type: "text_delta", text: raw.delta },
        } as StreamEvent);
      }
      break;
    }

    // ─── Reasoning Done ───
    case "response.reasoning_summary_text.done": {
      if (state.openReasoningIndex !== null) {
        results.push({
          type: "content_block_stop",
          index: state.openReasoningIndex,
        } as StreamEvent);
        state.openReasoningIndex = null;
      }
      break;
    }

    // ─── Function Call Arguments Delta ───
    // 按 item_id（回落 output_index）路由到该调用**自己的** index：并行调用的增量交错
    // 到达时各归各位。找不到归属的增量丢弃而不是塞进「当前块」—— 塞错块比丢更糟，
    // 而且终值会在 done 时补齐。
    case "response.function_call_arguments.delta": {
      if (raw.delta) {
        const tc = findToolCall(raw, state);
        if (tc && !tc.closed) {
          tc.emitted += raw.delta;
          results.push({
            type: "content_block_delta",
            index: tc.index,
            delta: { type: "input_json_delta", partial_json: raw.delta },
          } as StreamEvent);
        } else if (!tc) {
          log.warn("RESPONSES", `function_call_arguments.delta 找不到所属调用，已丢弃`, {
            item_id: raw.item_id,
            output_index: raw.output_index,
          });
        }
      }
      break;
    }

    // ─── Function Call Arguments Done ───
    // `arguments` 是规范定义的**完整**参数（openapi：ResponseFunctionCallArgumentsDoneEvent）。
    // 有的网关（code.ppchat.vip，2026-11-03 实测）只发 done 不发 delta，参数只在这里。
    case "response.function_call_arguments.done": {
      const tc = findToolCall(raw, state);
      if (tc) closeToolCall(tc, { arguments: raw.arguments, name: raw.name }, state, results, log);
      break;
    }

    // ─── Content Part Done ───
    case "response.content_part.done": {
      // content_part.done 有时在 output_text.done 之后冗余到达，忽略
      break;
    }

    // ─── Output Item Done ───
    case "response.output_item.done": {
      const item = raw.item;
      if (item?.type === "function_call") {
        // 第二道收尾：网关省略 arguments.done 时，item.arguments 是最后一个权威来源。
        // 已被 arguments.done 收过的调用在 closeToolCall 里幂等跳过。
        // done 先于 added（或 added 缺席）时补开块，参数照样不丢。
        const tc =
          state.toolCalls.get(item.id) ?? openToolCall(item, raw.output_index, state, results);
        closeToolCall(
          tc,
          { arguments: item.arguments, name: item.name, id: item.call_id },
          state,
          results,
          log,
        );
        break;
      }
      // 发现 1（2026-10-21）：reasoning item 此前在这里被直接丢掉，推理链从未回传。
      // 现在把整个 item 存成不可见的 provider_reasoning 块，下一轮由 buildResponsesRequest 原样回放。
      const block = toProviderReasoningBlock(item, state.model);
      if (block) {
        // 推理 item 结束时若摘要块还开着（网关省略 summary_text.done），先关掉它
        if (state.openReasoningIndex !== null) {
          results.push({
            type: "content_block_stop",
            index: state.openReasoningIndex,
          } as StreamEvent);
          state.openReasoningIndex = null;
        }
        const index = state.nextIndex++;
        results.push({ type: "content_block_start", index, content_block: block } as StreamEvent);
        results.push({ type: "content_block_stop", index } as StreamEvent);
      }
      break;
    }

    // ─── Response Completed（终态） ───
    case "response.completed": {
      const usage = raw.response?.usage;
      if (usage) {
        applyResponsesUsage(state.usage, usage);
      }
      // 正常终态下仍未收尾的工具调用（网关两个 done 都省了）：以已累积增量收尾，
      // 否则消费方永远等不到 stop，块停在初始化的 `{}`。
      for (const tc of state.toolCalls.values()) {
        if (!tc.closed) closeToolCall(tc, {}, state, results, log);
      }
      // 发现 5（2026-10-21）：此前这里写死 end_turn，带工具的轮全被报成「回合结束」，
      // 靠主循环 F2 兜底才没停摆，代价是 warn.log 每轮一条「声称 end_turn 但含 tool_use」，
      // 协议偏差告警因此失去区分度。与非流式共用 mapResponsesStatus，两条路径不再各写一套。
      results.push({
        type: "message_delta",
        delta: {
          stop_reason: mapResponsesStatus(raw.response?.status, undefined, state.sawToolCall),
        },
        usage: { ...state.usage },
      } as StreamEvent);
      results.push({ type: "message_stop" } as StreamEvent);
      break;
    }

    // ─── Response Failed ───
    case "response.failed": {
      const errMsg =
        raw.response?.status === "incomplete"
          ? "Response incomplete"
          : (raw.error?.message ?? "Response failed");
      // D4（多 Provider 层审计）：三个终态都带完整 Response 对象（含 usage），此前只有
      // completed / incomplete 读了，failed 漏读 ⇒ sendViaResponsesAPI 的 accumulatedUsage
      // 停在 0、这一轮记 $0。而 failed 的 prompt 已被上游收下计费，且它必然触发重试/降级
      // ——白烧最典型的样本恰好免费，retryWastedRatio 的分子在它的目标人群上恒 0。
      //
      // ⚠ 只补 usage，不改失败语义：stop_reason 给 null（不是 end_turn），后面照发 error。
      // 发成 end_turn 会把一次真失败伪装成正常结束。消费方对 null stop_reason 的
      // message_delta 只做 usage 累加（stream-restart 契约：作废尝试的 token 计入不回退）。
      const usage = raw.response?.usage;
      if (usage) {
        applyResponsesUsage(state.usage, usage);
        results.push({
          type: "message_delta",
          delta: { stop_reason: null },
          usage: { ...state.usage },
        } as StreamEvent);
      }
      results.push({
        type: "error",
        error: { message: errMsg },
      } as StreamEvent);
      break;
    }

    // ─── Response Incomplete ───
    case "response.incomplete": {
      // 缺陷 B 修复：此前这里**不读 usage**，而同为终态的 response.completed 读了。
      // 规范上 incomplete 的 `response` 是完整 Response 对象、含 usage
      //（openapi.yaml:67965-67966），所以漏读纯属遗漏而非协议限制。
      //
      // 后果不是"少一个字段"，而是**方向性偏在最贵的样本上**：incomplete 意味着
      // 输出打到 max_tokens 上限，恰是单轮 output 最满、成本最高的那一类，
      // 而它的成本被记成 0。账本里越贵的轮越不计数，「更省」的曲线会系统性偏乐观。
      const usage = raw.response?.usage;
      if (usage) {
        applyResponsesUsage(state.usage, usage);
      }
      // incomplete 刻意**不**被 sawToolCall 改成 tool_use：截断时最后一个工具的参数可能残缺，
      // 报 max_tokens 让主循环走「截断带工具」分支（P1-4），而不是当作完整工具轮直接执行。
      results.push({
        type: "message_delta",
        delta: {
          stop_reason: mapResponsesStatus(
            "incomplete",
            raw.response?.incomplete_details?.reason,
            false,
          ),
        },
        usage: { ...state.usage },
      } as StreamEvent);
      results.push({ type: "message_stop" } as StreamEvent);
      break;
    }

    default: {
      // 未知事件静默忽略（向前兼容）
      log.debug("RESPONSES", `未知 Responses API 事件: ${raw.type}`);
      break;
    }
  }

  return results;
}

// ─── SSE 字节流读取 ───

/**
 * 从 ReadableStream 读取 SSE 事件。
 * Responses API 的 SSE 格式与 Chat Completions 一致：
 *   event: <type>\n
 *   data: <json>\n
 *   \n
 */
async function* readSSEEvents(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<ResponsesStreamEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // 当前事件已收集的行（空行 = 事件分隔时整体交给 parseSSEBlock）。
  // 切行走 sse-line.ts 的唯一实现：此前按 `indexOf("\n\n")` 切块，CRLF 流下
  // 永远找不到分隔符，整条流堆在 buffer 里直到 EOF 才被当成**一个**事件解析。
  let eventLines: string[] = [];

  try {
    while (true) {
      if (signal?.aborted) break;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const { lines, rest } = splitSSELines(buffer);
      buffer = rest;
      for (const line of lines) {
        if (line === "") {
          if (eventLines.length > 0) {
            const parsed = parseSSEBlock(eventLines);
            eventLines = [];
            if (parsed) yield parsed;
          }
        } else {
          eventLines.push(line);
        }
      }
    }

    // 处理尾部数据（无 trailing 空行的最后一个事件）
    buffer += decoder.decode();
    const { lines, rest } = splitSSELines(buffer);
    for (const line of rest ? [...lines, rest] : lines) {
      if (line !== "") eventLines.push(line);
    }
    if (eventLines.length > 0) {
      const parsed = parseSSEBlock(eventLines);
      if (parsed) yield parsed;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 解析单个 SSE 事件块（已切好的行，不含分隔空行）
 * 格式：
 *   event: response.output_text.delta
 *   data: {"type":"response.output_text.delta","delta":"Hello",...}
 *
 * 字段语法走 sse-line.ts 的 parseSSEField（冒号后**一个**可选空格、注释行忽略）。
 * 多行 data 按规范用 `\n` 连接。
 */
function parseSSEBlock(lines: string[]): ResponsesStreamEvent | null {
  let eventType = "";
  const dataParts: string[] = [];

  for (const line of lines) {
    const f = parseSSEField(line);
    if (!f) continue; // 注释（keep-alive）
    if (f.field === "event") {
      eventType = f.value.trim();
    } else if (f.field === "data") {
      if (isDoneSentinel(f.value)) return null;
      dataParts.push(f.value);
    }
  }

  const data = dataParts.join("\n");
  if (!data.trim()) return null;

  try {
    const parsed = JSON.parse(data) as ResponsesStreamEvent;
    // event: 行的类型优先于 data 中的 type 字段
    if (eventType && !parsed.type) {
      parsed.type = eventType;
    }
    return parsed;
  } catch {
    return null;
  }
}

// ─── 非流式响应解析（P0-5） ───

/** 非流式 Responses 响应体（`stream: false` 时 POST /responses 的 JSON） */
export interface ResponsesNonStreamingBody {
  id?: string;
  status?: string;
  usage?: ResponsesUsage;
  output?: OutputItem[];
  error?: { message?: string; code?: string };
  incomplete_details?: { reason?: string };
}

/**
 * reasoning output item → provider_reasoning 块。
 *
 * 没有 `encrypted_content` 就不存：store:false 下没有密文的 item 只剩一个 id，
 * 回放它服务端会报「Item … not found」400——存了反而有害。
 */
export function toProviderReasoningBlock(
  item: OutputItem | undefined,
  model: string,
): ProviderReasoningBlock | null {
  if (item?.type !== "reasoning") return null;
  if (typeof item.encrypted_content !== "string" || item.encrypted_content === "") return null;
  return {
    type: "provider_reasoning",
    protocol: "openai-responses",
    model,
    item: { ...item } as unknown as Record<string, unknown>,
  };
}

/** 非流式解析结果（与 AccumulatedResponse 的三个字段同形，由 provider 组装成完整对象） */
export interface ParsedResponsesBody {
  /** thinking 块在前、text 块在后、tool_use 最后（与流式路径同序） */
  content: Array<
    | { type: "thinking"; thinking: string }
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | ProviderReasoningBlock
  >;
  /** 映射后的统一 stopReason（end_turn / tool_use / max_tokens / content_filter） */
  stopReason: string;
  usage: Usage;
}

/**
 * 解析非流式 Responses 响应体（P0-5）。
 *
 * 为什么必须有这个函数：`sendMessageNonStreamingInner` 此前**无条件**打
 * `/chat/completions`，只有流式入口做 `shouldUseResponsesAPI` 分派。于是 GPT-5.x
 * 在三条降级路径（流式传输错误降级 / 空流降级 / ModelFallback）上会静默换协议，
 * 后果之一正是**缓存口径分裂**：同一个模型，流式走 Responses（命中在
 * `input_tokens_details`）、降级走 Chat（命中在 `prompt_tokens_details`），
 * 命中率取决于当时是否降级 —— 无法解释也无法复现。
 *
 * usage 提取与流式路径共用 `applyResponsesUsage`（同一个函数，不是同一份逻辑的两份拷贝），
 * 所以两条路径的口径**不可能**再分裂。
 */
export function parseResponsesBody(
  body: ResponsesNonStreamingBody,
  opts?: { model?: string },
): ParsedResponsesBody {
  const content: ParsedResponsesBody["content"] = [];
  let sawToolCall = false;

  for (const item of body.output ?? []) {
    if (item.type === "reasoning") {
      // 推理摘要（流式对应 reasoning_summary_text.delta）→ thinking 块
      const text = (item.summary ?? [])
        .map((s) => s.text ?? "")
        .filter((t) => t !== "")
        .join("");
      if (text !== "") content.push({ type: "thinking", thinking: text });
      // 与流式同序：摘要 thinking 在前，可回放的密文块在后
      const replayable = toProviderReasoningBlock(item, opts?.model ?? "");
      if (replayable) content.push(replayable);
      continue;
    }

    if (item.type === "function_call") {
      sawToolCall = true;
      let input: unknown = {};
      try {
        input = item.arguments ? JSON.parse(item.arguments) : {};
      } catch {
        // 参数不是合法 JSON：与 Chat 路径同处理（落空对象，交由上层工具校验报错），
        // 不在协议层抛错 —— 抛了会把"模型参数写错"变成"请求失败"，丢掉可恢复性。
        input = {};
      }
      content.push({
        type: "tool_use",
        id: item.call_id ?? item.id ?? "",
        name: item.name ?? "",
        input,
      });
      continue;
    }

    // type === "message"：output_text 部分是正文，reasoning 部分是思考
    for (const part of item.content ?? []) {
      if (part.type === "output_text" && part.text) {
        content.push({ type: "text", text: part.text });
      } else if (part.type === "reasoning_text" && part.text) {
        // 同缺陷 A：此处原本也写 "reasoning"（规范里不存在的值），
        // 即非流式路径的思考内容同样被丢弃。两条路径必须用同一个字面量。
        content.push({ type: "thinking", thinking: part.text });
      } else if (part.type === "refusal" && part.text) {
        // 与 Chat 路径对齐：refusal 兜底为可见文本，否则表现为"模型莫名没回复"
        content.push({ type: "text", text: `[模型拒绝] ${part.text}` });
      }
    }
  }

  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  applyResponsesUsage(usage, body.usage);

  return {
    content,
    stopReason: mapResponsesStatus(body.status, body.incomplete_details?.reason, sawToolCall),
    usage,
  };
}

/**
 * 把 Responses 的 status / incomplete_details 映射成统一 stopReason。
 *
 * 有工具调用时优先 `tool_use`：Responses 的 status 在带工具调用时仍是 `completed`，
 * 若照搬会把"要继续跑工具"报成"回合结束"，主循环就此停摆。
 *
 * 流式与非流式**共用这一份**（发现 5）：流式曾写死 end_turn，跟这里分裂了两套口径。
 */
export function mapResponsesStatus(
  status: string | undefined,
  incompleteReason: string | undefined,
  sawToolCall: boolean,
): string {
  if (sawToolCall) return "tool_use";
  if (status === "incomplete") {
    return incompleteReason === "content_filter" ? "content_filter" : "max_tokens";
  }
  return "end_turn";
}
