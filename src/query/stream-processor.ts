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
  ContentBlock,
} from "../llm/types.ts";
import { accumulateUsage } from "../llm/types.ts";
import { getLogger } from "../debug/index.ts";
import { normalizeToolInput } from "../llm/normalize-tool-input.ts";
import { detectUnansweredEndTurn } from "./unanswered-end-turn.ts";

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
  // 5.1 / 方案①：provider 原始 output usage 是否为 0（在任何估算兜底之前的事实）。
  // 由 openai.ts 经 message_delta._rawOutputTokensZero 透传——这是判"未答复 end_turn"
  // 最硬的结构信号，且必须与"估算兜底后的 usage"解耦（估算会把值补成非零）。
  let rawOutputTokensZero = false;

  // P1（9bc92c2c 根因修复）：SSE event.index → content 数组实际位置的映射。
  // 某些第三方代理返回的 content_block index 不从 0 开始或不连续（如直接调用工具时
  // index=1 跳过 0），用 index 做数组下标会产生 undefined 空洞导致下游 TypeError。
  // 改为 push 到末尾 + 映射表查找，保证 content 数组始终密集。
  const indexToPosition = new Map<number, number>();

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

        case "content_block_start": {
          const pos = response.content.length; // push 到末尾，保证数组密集
          indexToPosition.set(event.index, pos);
          if (event.content_block.type === "text") {
            response.content.push({ type: "text", text: "" });
            if (event._raw_block && (event._raw_block as any).type === "thinking") {
              thinkingIndexes.add(event.index);
              // SP1：起点在 block_start 而非首 delta，把开头等待时间计入耗时，
              // 与 content_block_stop 的时间差才是真实思考时长。
              thinkingStartMs.set(event.index, Date.now());
            }
          } else if (event.content_block.type === "tool_use") {
            response.content.push({
              type: "tool_use",
              id: event.content_block.id,
              name: event.content_block.name,
              input: {},
            });
            jsonAccumulators.set(event.index, "");
          } else if ((event.content_block as any).type === "thinking") {
            // Anthropic SDK 直接发来 thinking 类型块（非通过 text + _raw_block 通道）
            response.content.push({ type: "text", text: "" });
            thinkingIndexes.add(event.index);
            thinkingStartMs.set(event.index, Date.now());
          } else if ((event.content_block as any).type === "redacted_thinking") {
            // redacted_thinking 块：必须原样保留用于多轮回传
            // [来源: anthropic-api.md:356-357]
            response.content.push({
              type: "redacted_thinking" as any,
              data: (event.content_block as any).data || "",
            });
          }
          break;
        }

        case "content_block_delta": {
          const pos = indexToPosition.get(event.index);
          if (pos === undefined) break; // 未知 index 的 delta，忽略
          const delta = event.delta;
          if (delta.type === "text_delta") {
            const block = response.content[pos];
            if (block?.type === "text") {
              block.text += delta.text;
              // 对标 Claude Code：思考块不调 onText，调 onThinking
              if (thinkingIndexes.has(event.index)) {
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
          const pos = indexToPosition.get(event.index);
          if (pos === undefined) break; // 未知 index，忽略
          const jsonStr = jsonAccumulators.get(event.index);
          if (jsonStr !== undefined) {
            const block = response.content[pos];
            if (block?.type === "tool_use") {
              // O(n) 设计：拼接字符串 + 最终一次性解析，不做增量 parse（对齐 CC raw stream 策略）
              try {
                block.input = normalizeToolInput(jsonStr ? JSON.parse(jsonStr) : {});
              } catch (e) {
                // telemetry: 工具输入 JSON 解析失败（对齐 CC tengu_tool_input_json_parse_fail）
                log.warn("STREAM", `工具输入 JSON 解析失败`, {
                  toolName: block.name,
                  inputLength: jsonStr.length,
                  error: e instanceof Error ? e.message : String(e),
                  inputHead: jsonStr.slice(0, 200),
                });
                block.input = {};
              }
            }
            jsonAccumulators.delete(event.index);
          }
          if (thinkingIndexes.has(event.index)) {
            const block = response.content[pos];
            if (block?.type === "text" && block.text) {
              // SP1：算出该思考块耗时（block_start → stop）；无起点则不附。
              const startedAt = thinkingStartMs.get(event.index);
              const durationMs =
                startedAt !== undefined
                  ? Math.max(0, Date.now() - startedAt)
                  : undefined;
              // 原地转型为 ThinkingBlock（保留在 content 中，对标 Claude Code）
              // § 把 anthropic.ts 累积的 signature 从 _raw_block 中提取
              const rawBlock = (event as any)._raw_block;
              const signature = rawBlock?.signature;
              const thinkingBlock = {
                type: "thinking" as const,
                thinking: block.text,
                ...(signature ? { signature } : {}),
                ...(durationMs !== undefined ? { durationMs } : {}),
              };
              response.content[pos] = thinkingBlock;
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
          // 5.1 / 方案①：捕获 provider 原始 output 是否为 0（估算兜底前的事实）。
          // 任一 message_delta 报"原始为 0"即置位——聚合 usage 可能被 estimator 补成非零，
          // 故不能用 response.usage 反推，必须用此独立标记。
          if ((event as any)._rawOutputTokensZero === true) {
            rawOutputTokensZero = true;
          }
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

  // 内联 <think> 标签后处理：部分 OpenAI 兼容模型（GPT-5.4、QwQ 等）不通过
  // reasoning_content 字段、也不通过 _raw_block 标记思考块，而是直接在文本中
  // 内联 <think>...</think> 标签。流式累积完成后统一检测并拆分。
  // 仅在没有已识别的 thinking 块时处理（避免与 DeepSeek reasoning_content 重复）。
  if (thinkingBlocks.length === 0) {
    for (let i = 0; i < response.content.length; i++) {
      const block = response.content[i];
      if (block.type !== "text" || !block.text.trimStart().startsWith("<think>")) continue;
      const thinkMatch = block.text.match(/^[\s]*<think>([\s\S]*?)<\/think>/);
      if (!thinkMatch) continue;
      const thinkText = thinkMatch[1]?.trim() ?? "";
      const remaining = block.text.slice(thinkMatch[0].length).trim();
      // 拆分：thinking 块插入当前位置，text 块跟在后面
      const newBlocks: ContentBlock[] = [];
      if (thinkText) {
        newBlocks.push({ type: "thinking", thinking: thinkText });
      }
      if (remaining) {
        newBlocks.push({ type: "text", text: remaining });
      }
      if (newBlocks.length > 0) {
        response.content.splice(i, 1, ...newBlocks);
      }
      break; // 通常只有一个 think 块在文本开头
    }
  }

  // 思考块已原地转型为 ThinkingBlock 保留在 content 中，不再需要过滤移除

  // 「未答复的 end_turn」统一识别（方案①/②，deepseek-reasoning-leak 修复）。
  // 抽到 unanswered-end-turn.ts 纯函数，与非流式降级路径共用，避免行为漂移。
  // 放在 <think> 拆分之后——先让内联 <think> 答复归位，再判是否真答复，避免误判。
  detectUnansweredEndTurn(response, rawOutputTokensZero);

  // P0-1（9bc92c2c 根因修复最终防线）：过滤掉可能残余的 undefined 空洞。
  // 正常情况下 P1 的 push + indexToPosition 已保证数组密集，此处为纵深防御。
  response.content = response.content.filter(Boolean);

  return response;
}
