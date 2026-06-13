/**
 * 流式响应处理器
 * 从 app.ts 提取，处理 LLM 流式事件，累积内容块
 *
 * v2 改变（对标 Claude Code）：思考块保留在 content 中（原地转型为 ThinkingBlock），
 * 不再从 content 移除。新增 onThinking 回调，与 onText 完全分离。
 */

import type {
  StreamEvent,
  AccumulatedResponse,
} from "../llm/types.ts";
import { accumulateUsage } from "../llm/types.ts";
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
  onThinking?: (text: string) => void,
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
  // SP1：每个 thinking 块的开始时间戳（首个 delta 到达时记录），用于在
  // content_block_stop 时算出 durationMs，持久化到 ThinkingBlock 供历史项显示耗时。
  const thinkingStartMs = new Map<number, number>();
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
          accumulateUsage(response.usage, event.message.usage);
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
              // 对标 Claude Code：思考块不调 onText，调 onThinking
              if (thinkingIndexes.has(event.index)) {
                // SP1：首个 thinking delta 到达时记录起点（仅记一次）。
                if (!thinkingStartMs.has(event.index)) {
                  thinkingStartMs.set(event.index, Date.now());
                }
                onThinking?.(delta.text);
              } else {
                onText?.(delta.text);
              }
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
              // SP1：算出该思考块耗时（首 delta → stop）；无起点（无 delta）则不附。
              const startedAt = thinkingStartMs.get(event.index);
              const durationMs =
                startedAt !== undefined
                  ? Math.max(0, Date.now() - startedAt)
                  : undefined;
              // 原地转型为 ThinkingBlock（保留在 content 中，对标 Claude Code）
              const thinkingBlock = {
                type: "thinking" as const,
                thinking: block.text,
                ...(durationMs !== undefined ? { durationMs } : {}),
              };
              response.content[event.index] = thinkingBlock;
              thinkingBlocks.push(thinkingBlock);
              accumulatedReasoning += block.text;
            }
            thinkingIndexes.delete(event.index);
            thinkingStartMs.delete(event.index);
          }
          break;
        }

        case "message_delta":
          response.stopReason = event.delta.stop_reason;
          // 统一走 accumulateUsage：累加 input/output 并补齐 cacheRead/cacheCreation
          // （DeepSeek 命中在最终 usage chunk 经 message_delta 到达，缺了会按全价算）
          accumulateUsage(response.usage, event.usage);
          break;

        case "error":
          throw new Error(`LLM 错误: ${event.error.message}`);

        case "system_api_error":
          // 对标 claude-code：通过 onText 将重试进度消息传递给 TUI 渲染
          // 格式："[重试中] 正在重试 (2/4)…" 等用户可见文案
          onText?.(`[重试中] ${event.content}`);
          break;
      }
    }
  } finally {
    clearInterval(checkInterval);
  }

  if (timeoutError) {
    throw timeoutError;
  }

  // 流结束日志（区分文本块和思考块）
  const totalTextLen = response.content
    .filter(b => b.type === "text")
    .reduce((sum, b) => sum + (b.type === "text" ? b.text.length : 0), 0);
  const thinkingCount = response.content.filter(b => b.type === "thinking").length;
  const toolCallCount = response.content.filter(b => b.type === "tool_use").length;
  log.info("STREAM", `流结束: 文本${totalTextLen}字符, 思考${thinkingCount}块, 工具调用${toolCallCount}个, stop=${response.stopReason}, in=${response.usage.inputTokens} out=${response.usage.outputTokens}`);

  if (thinkingBlocks.length > 0) {
    (response as any)._thinkingBlocks = thinkingBlocks;
  }

  // DeepSeek reasoning_content: 存到 _meta 供 convertMessages 回传
  if (accumulatedReasoning) {
    response._meta = { ...response._meta, reasoning_content: accumulatedReasoning };
  }

  // 思考块已原地转型为 ThinkingBlock 保留在 content 中，不再需要过滤移除

  return response;
}
