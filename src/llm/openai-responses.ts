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

import type { StreamEvent, Usage } from "./types.ts";
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

interface OutputItem {
  id: string;
  type: "message" | "function_call" | "reasoning";
  status?: string;
  role?: string;
  content?: ContentPart[];
  // function_call 特有
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface ContentPart {
  type: "output_text" | "reasoning" | "refusal";
  text?: string;
  annotations?: unknown[];
}

// ─── 状态机 ───

interface ParserState {
  /** 当前正在构建的 content block index（用于 StreamEvent 对齐） */
  blockIndex: number;
  /** 累积的 tool call 参数（按 item_id 分组） */
  toolCalls: Map<string, { name: string; arguments: string; outputIndex: number }>;
  /** usage（从 response.completed 提取） */
  usage: Usage;
  /** 是否已 yield message_start */
  started: boolean;
  /** 是否在 reasoning block 中 */
  inReasoningBlock: boolean;
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
): AsyncIterable<StreamEvent> {
  const log = getLogger();
  const state: ParserState = {
    blockIndex: 0,
    toolCalls: new Map(),
    usage: { inputTokens: 0, outputTokens: 0 },
    started: false,
    inReasoningBlock: false,
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
      if (item?.type === "function_call" && item.name) {
        // 工具调用：创建 tool_use block
        state.toolCalls.set(item.id, {
          name: item.name,
          arguments: "",
          outputIndex: raw.output_index ?? 0,
        });
        results.push({
          type: "content_block_start",
          index: state.blockIndex,
          content_block: { type: "tool_use", id: item.call_id ?? item.id, name: item.name, input: {} },
        } as StreamEvent);
      }
      break;
    }

    // ─── Content Part 添加 ───
    case "response.content_part.added": {
      const part = raw.part;
      if (part?.type === "output_text") {
        results.push({
          type: "content_block_start",
          index: state.blockIndex,
          content_block: { type: "text", text: "" },
        } as StreamEvent);
      } else if (part?.type === "reasoning") {
        state.inReasoningBlock = true;
        results.push({
          type: "content_block_start",
          index: state.blockIndex,
          content_block: { type: "thinking", thinking: "" },
          _raw_block: { type: "thinking" },
        } as StreamEvent);
      }
      break;
    }

    // ─── Text Delta ───
    case "response.output_text.delta": {
      if (raw.delta) {
        results.push({
          type: "content_block_delta",
          index: state.blockIndex,
          delta: { type: "text_delta", text: raw.delta },
        } as StreamEvent);
      }
      break;
    }

    // ─── Text Done ───
    case "response.output_text.done": {
      results.push({ type: "content_block_stop", index: state.blockIndex } as StreamEvent);
      state.blockIndex++;
      break;
    }

    // ─── Reasoning Delta ───
    case "response.reasoning_summary_text.delta": {
      if (raw.delta) {
        results.push({
          type: "content_block_delta",
          index: state.blockIndex,
          delta: { type: "text_delta", text: raw.delta },
        } as StreamEvent);
      }
      break;
    }

    // ─── Reasoning Done ───
    case "response.reasoning_summary_text.done": {
      state.inReasoningBlock = false;
      results.push({ type: "content_block_stop", index: state.blockIndex } as StreamEvent);
      state.blockIndex++;
      break;
    }

    // ─── Function Call Arguments Delta ───
    case "response.function_call_arguments.delta": {
      if (raw.delta && raw.item_id) {
        const tc = state.toolCalls.get(raw.item_id);
        if (tc) tc.arguments += raw.delta;
        results.push({
          type: "content_block_delta",
          index: state.blockIndex,
          delta: { type: "input_json_delta", partial_json: raw.delta },
        } as StreamEvent);
      }
      break;
    }

    // ─── Function Call Arguments Done ───
    case "response.function_call_arguments.done": {
      results.push({ type: "content_block_stop", index: state.blockIndex } as StreamEvent);
      state.blockIndex++;
      break;
    }

    // ─── Content Part Done ───
    case "response.content_part.done": {
      // content_part.done 有时在 output_text.done 之后冗余到达，忽略
      break;
    }

    // ─── Output Item Done ───
    case "response.output_item.done": {
      // item 级别完成，无需额外映射
      break;
    }

    // ─── Response Completed（终态） ───
    case "response.completed": {
      const usage = raw.response?.usage;
      if (usage) {
        applyResponsesUsage(state.usage, usage);
      }
      results.push({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { ...state.usage },
      } as StreamEvent);
      results.push({ type: "message_stop" } as StreamEvent);
      break;
    }

    // ─── Response Failed ───
    case "response.failed": {
      const errMsg = raw.response?.status === "incomplete"
        ? "Response incomplete"
        : raw.error?.message ?? "Response failed";
      results.push({
        type: "error",
        error: { message: errMsg },
      } as StreamEvent);
      break;
    }

    // ─── Response Incomplete ───
    case "response.incomplete": {
      results.push({
        type: "message_delta",
        delta: { stop_reason: "max_tokens" },
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

  try {
    while (true) {
      if (signal?.aborted) break;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // 按双换行分割事件
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const eventBlock = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const parsed = parseSSEBlock(eventBlock);
        if (parsed) yield parsed;
      }
    }

    // 处理尾部数据（无 trailing \n\n 的最后一个事件）
    if (buffer.trim()) {
      const parsed = parseSSEBlock(buffer);
      if (parsed) yield parsed;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 解析单个 SSE 事件块
 * 格式：
 *   event: response.output_text.delta
 *   data: {"type":"response.output_text.delta","delta":"Hello",...}
 */
function parseSSEBlock(block: string): ResponsesStreamEvent | null {
  let eventType = "";
  let data = "";

  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return null;
      data += payload;
    } else if (line.startsWith(":")) {
      // SSE 注释（keep-alive），忽略
    }
  }

  if (!data) return null;

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
