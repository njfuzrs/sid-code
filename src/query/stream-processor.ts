/**
 * 流式响应处理器
 * 从 app.ts 提取，处理 LLM 流式事件，累积内容块
 */

import type {
  StreamEvent,
  AccumulatedResponse,
} from "../llm/types.ts";
import { getLogger } from "../debug/index.ts";

/** 流式处理器配置 */
export interface StreamProcessorOptions {
  /** 心跳超时（毫秒，默认 60000） */
  heartbeatTimeoutMs?: number;
  /** 心跳检查间隔（毫秒，默认 5000） */
  heartbeatCheckIntervalMs?: number;
  /** 整体超时（毫秒，默认 300000 = 5 分钟） */
  overallTimeoutMs?: number;
  /** 获取 AbortController（用于超时时中断上游） */
  getAbortController?: () => AbortController | null;
}

/**
 * 处理流式响应，累积内容块（含心跳检测 + 整体超时）
 */
export async function processStream(
  stream: AsyncIterable<StreamEvent>,
  onText?: (text: string) => void,
  options?: StreamProcessorOptions,
): Promise<AccumulatedResponse> {
  const log = getLogger();
  const response: AccumulatedResponse = {
    role: "assistant",
    content: [],
    stopReason: null,
    usage: { inputTokens: 0, outputTokens: 0 },
  };

  // 用于累积工具调用的 JSON 分片
  const jsonAccumulators = new Map<number, string>();
  // 用于收集 thinking blocks（轨迹采集用）
  const thinkingBlocks: unknown[] = [];
  // 记录哪些 index 是 thinking 块
  const thinkingIndexes = new Set<number>();
  // 记录已完成的 thinking 块索引（用于最后从 content 中移除）
  const removedThinkingIndexes = new Set<number>();
  // 累积 reasoning 文本（DeepSeek reasoning_content 回传用）
  let accumulatedReasoning = "";

  // 超时配置（心跳 + 整体超时共用一个定时器，每 5 秒检查一次）
  const HEARTBEAT_TIMEOUT = options?.heartbeatTimeoutMs ?? 60_000;
  const OVERALL_TIMEOUT = options?.overallTimeoutMs ?? 300_000;
  const startTime = Date.now();
  let lastActivityTime = Date.now();
  let timeoutError: Error | null = null;

  const checkInterval = setInterval(() => {
    const now = Date.now();

    // 整体超时检测
    if (now - startTime > OVERALL_TIMEOUT) {
      timeoutError = new Error(
        `Stream overall timeout: ${OVERALL_TIMEOUT / 1000}s 总时长超限`,
      );
      log.warn("STREAM", `整体超时: ${OVERALL_TIMEOUT / 1000}s`);
      options?.getAbortController?.()?.abort();
      clearInterval(checkInterval);
      return;
    }

    // 心跳超时检测
    if (now - lastActivityTime > HEARTBEAT_TIMEOUT) {
      timeoutError = new Error(
        `Stream heartbeat timeout: ${HEARTBEAT_TIMEOUT / 1000}s 无数据`,
      );
      log.warn("STREAM", `心跳超时: ${HEARTBEAT_TIMEOUT / 1000}s 无数据`);
      options?.getAbortController?.()?.abort();
      clearInterval(checkInterval);
    }
  }, 5_000);

  try {
    for await (const event of stream) {
      lastActivityTime = Date.now();

      // 关键修复：每次事件前检查超时标志，一旦超时就抛错主动退出循环
      if (timeoutError) {
        throw timeoutError;
      }

      switch (event.type) {
        case "message_start":
          response.usage.inputTokens += event.message.usage.inputTokens;
          response.usage.outputTokens += event.message.usage.outputTokens;
          break;

        case "content_block_start":
          if (event.content_block.type === "text") {
            response.content[event.index] = { type: "text", text: "" };
            if (event._raw_block && (event._raw_block as any).type === "thinking") {
              thinkingIndexes.add(event.index);
            }
          } else if (event.content_block.type === "tool_use") {
            response.content[event.index] = {
              type: "tool_use",
              id: event.content_block.id,
              name: event.content_block.name,
              input: {},
            };
            jsonAccumulators.set(event.index, "");
          }
          break;

        case "content_block_delta": {
          const delta = event.delta;
          if (delta.type === "text_delta") {
            const block = response.content[event.index];
            if (block?.type === "text") {
              block.text += delta.text;
              onText?.(delta.text);
            }
          } else if (delta.type === "input_json_delta") {
            const acc = jsonAccumulators.get(event.index) ?? "";
            jsonAccumulators.set(event.index, acc + delta.partial_json);
          }
          break;
        }

        case "content_block_stop": {
          const jsonStr = jsonAccumulators.get(event.index);
          if (jsonStr !== undefined) {
            const block = response.content[event.index];
            if (block?.type === "tool_use") {
              try {
                block.input = jsonStr ? JSON.parse(jsonStr) : {};
              } catch {
                block.input = {};
              }
            }
            jsonAccumulators.delete(event.index);
          }
          if (thinkingIndexes.has(event.index)) {
            const block = response.content[event.index];
            if (block?.type === "text" && block.text) {
              thinkingBlocks.push({ type: "thinking", thinking: block.text });
              accumulatedReasoning += block.text;
            }
            removedThinkingIndexes.add(event.index);
            thinkingIndexes.delete(event.index);
          }
          break;
        }

        case "message_delta":
          response.stopReason = event.delta.stop_reason;
          response.usage.inputTokens += event.usage.inputTokens ?? 0;
          response.usage.outputTokens += event.usage.outputTokens;
          break;

        case "error":
          throw new Error(`LLM 错误: ${event.error.message}`);
      }
    }
  } finally {
    clearInterval(checkInterval);
  }

  if (timeoutError) {
    throw timeoutError;
  }

  // 流结束日志
  const totalTextLen = response.content
    .filter(b => b.type === "text")
    .reduce((sum, b) => sum + (b.type === "text" ? b.text.length : 0), 0);
  const toolCallCount = response.content.filter(b => b.type === "tool_use").length;
  log.info("STREAM", `流结束: 文本${totalTextLen}字符, 工具调用${toolCallCount}个, stop=${response.stopReason}, in=${response.usage.inputTokens} out=${response.usage.outputTokens}`);

  if (thinkingBlocks.length > 0) {
    (response as any)._thinkingBlocks = thinkingBlocks;
  }

  // DeepSeek reasoning_content: 存到 _meta 供 convertMessages 回传
  if (accumulatedReasoning) {
    response._meta = { ...response._meta, reasoning_content: accumulatedReasoning };
  }

  // 从 content 中移除 thinking 块（防止 convertMessages 把 thinking 文本混入 content）
  if (removedThinkingIndexes.size > 0) {
    response.content = response.content.filter((_, i) => !removedThinkingIndexes.has(i));
  }

  return response;
}
