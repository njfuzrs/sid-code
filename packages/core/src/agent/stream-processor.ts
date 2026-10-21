/**
 * StreamProcessor — 流式响应处理共享组件
 *
 * 从 sub-agent.ts 和 loop.ts 提取，统一处理 LLM 流式响应：
 * - 累积 ContentBlock（text / tool_use）
 * - 累加 Usage
 * - 转换 error 事件为 stopReason="error"（不抛异常）
 */

import type { ContentBlock, StreamEvent, ToolUseBlock, Usage } from "../llm/types.ts";
import { accumulateUsage } from "../llm/types.ts";
import { getLogger } from "../debug/index.ts";
import { normalizeToolInput } from "../llm/normalize-tool-input.ts";
import { resetOnStreamRestart, recordStreamRestart } from "../llm/stream-restart.ts";

/** 流式处理结果 */
export interface StreamProcessResult {
  content: ContentBlock[];
  stopReason: string | null;
  usage: Usage;
  errorMessage?: string;
  /**
   * R1：流内 error 事件的**结构化字段**原样透传（type / statusCode / streamLevel）。
   *
   * 为什么必须留：OpenAI 族的流内 error 常常 `message` 里没有任何可匹配的关键词，
   * 判定完全依赖 `error.type`/`code`（见 openai.ts:1644-1646 的注释与构造）。
   * 若只保留 errorMessage 文本、让调用方用 classifyError(new Error(msg)) 去猜，
   * 形如 `{message:"OpenAI 流内错误: Service is busy right now", type:"rate_limit_error"}`
   * 会被判成**不可重试的普通 Error**，而主路径用 classifyStreamError 会正确判成
   * rate_limit → 该重试的不重试，限流下子代理照旧秒失败（R1 的初版就踩了这个坑）。
   */
  errorMeta?: { type?: string; statusCode?: number; streamLevel?: boolean };
}

/**
 * 子代理流处理器配置。
 *
 * ⛔ 不要在这里加回任何超时层（idle / overall / 首字节）。2026-10-17 已整层删除：
 * 事故 20261016-224545 里这层 idle 60s 到点只置标志、连接没断（`getAbortController`
 * 全仓零调用方），等漏斗 180s 真正断流并重试时，重试流的首个事件被
 * `stream-lifecycle` 的 `if (snapshot.timedOut) break` 截断 → 整个子代理判 error。
 * 一个「只会判死、不会断流」的计时器只会把漏斗的重试变成失败。
 * 现在超时**只**由漏斗（`streamWithResilience` → `fallback.ts` startStreamTimeout）负责，
 * 触发即 abort + 重试，与主循环同构；本函数只消费事件。
 */
export interface AgentStreamOptions {
  /** 中止信号（B1 纵深防御：流消费中检查，防止 abort 无法穿透底层时挂死） */
  signal?: AbortSignal;
}

/**
 * 处理 LLM 流式响应，累积内容块和用量信息
 * 对标 claude-code 的 accumulative stream 处理模式
 *
 * 本函数不判超时：卡死由漏斗断流并重试（见 {@link AgentStreamOptions} 注释）。
 *
 * 向后兼容：第二参可传 AbortSignal（旧签名）或 AgentStreamOptions（新签名）。
 */
export async function processStream(
  stream: AsyncIterable<StreamEvent>,
  signalOrOptions?: AbortSignal | AgentStreamOptions,
): Promise<StreamProcessResult> {
  // 兼容旧签名：第二参为 AbortSignal 时归一化为 options
  const options: AgentStreamOptions =
    signalOrOptions instanceof AbortSignal ? { signal: signalOrOptions } : (signalOrOptions ?? {});
  const signal = options.signal;

  const content: ContentBlock[] = [];
  let stopReason: string | null = null;
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const jsonAccumulators = new Map<number, string>();
  /** SSE index → content 数组位置（见 content_block_start 处的注释：数组必须密集） */
  const indexToPosition = new Map<number, number>();
  /** 思考块 SSE index → provider 发来的原块（stop 时取 signature） */
  const thinkingStarts = new Map<number, unknown>();

  for await (const event of stream) {
    // B1 纵深防御：子代理流消费中检查 signal，防止 abort 无法穿透到底层时挂死
    if (signal?.aborted) {
      return {
        content,
        stopReason: "error",
        usage,
        errorMessage: "Request aborted",
      };
    }

    switch (event.type) {
      case "message_start":
        accumulateUsage(usage, event.message.usage);
        break;

      // 流重开 → 上一次尝试的内容块全部作废（2026-08-04 事故根因修复）。
      //
      // 子代理路径的错乱形态与主循环**不同但同源**：这里用 `content[event.index]`
      // 直接按 index 落位（不是 push + 映射表），重开后 index 从 0 重新开始，低位块
      // 会被覆盖，但**上一次尝试的高位块原样残留**——拼出「新响应 + 旧尾巴」。
      // 主循环是「旧头 + 新响应」，子代理是「新头 + 旧尾」，都必须清。
      //
      // usage 刻意不回退：作废尝试的 token 是真实计费的（见 stream-restart.ts）。
      case "stream_restart": {
        const outcome = resetOnStreamRestart({
          content,
          jsonAccumulators,
          indexToPosition,
          thinkingIndexes: new Set(thinkingStarts.keys()),
        });
        thinkingStarts.clear();
        recordStreamRestart(event, outcome, "subagent");
        break;
      }

      // ⛔ 不要改回 `content[event.index] = ...` 按 SSE index 直接落位。
      //
      // 2026-10-11 事故：旧实现只认 text / tool_use，thinking 块被**跳过不落位**，
      // 于是「thinking(0) + tool_use(1)」的响应产出 `[<hole>, tool_use]` 稀疏数组，
      // 下游 agentic-loop 一遍历就崩 `undefined is not an object (evaluating 'block.type')`。
      // always-on 思考模型（Sonnet/Opus 5.x）每个工具轮都这样，子代理第 2 轮必崩。
      // 现与主循环 query/stream-processor 同构：index → position 映射 + push，数组恒密集；
      // 未知块类型、跳跃 index 都不可能再造出空洞。
      case "content_block_start": {
        const cb = event.content_block as ContentBlock & { type: string };
        const isThinking =
          cb.type === "thinking" ||
          (cb.type === "text" && (event._raw_block as { type?: string })?.type === "thinking");
        let block: ContentBlock | undefined;
        if (isThinking) {
          // 思考增量以 text_delta 送达（anthropic.ts / openai.ts 均如此），先累积成 text，
          // stop 时转型成 thinking 块——与主循环口径一致。
          block = { type: "text", text: "" };
          // 记住 provider 给的原块：anthropic.ts 在 stop 前会把累积的 signature 写回它。
          thinkingStarts.set(event.index, cb);
        } else if (cb.type === "text") {
          block = { type: "text", text: "" };
        } else if (cb.type === "tool_use") {
          block = {
            type: "tool_use",
            id: (cb as ToolUseBlock).id,
            name: (cb as ToolUseBlock).name,
            input: {},
          };
          jsonAccumulators.set(event.index, "");
        } else if (cb.type === "redacted_thinking" || cb.type === "provider_reasoning") {
          // 多轮回传必须原样保留，丢了会静默破坏推理链（anthropic-api.md:356-357；
          // provider_reasoning 是 Responses 的推理项，发现 1）
          block = { ...(cb as ContentBlock) };
        }
        // 其余未知类型（server_tool_use 等）不落位——只要不占位，就不会出空洞。
        if (block) {
          indexToPosition.set(event.index, content.length);
          content.push(block);
        }
        break;
      }

      case "content_block_delta": {
        const pos = indexToPosition.get(event.index);
        if (pos === undefined) break; // 未落位的块（未知类型）的增量，忽略
        const delta = event.delta;
        if (delta.type === "text_delta") {
          const block = content[pos];
          if (block?.type === "text") {
            block.text += delta.text;
          }
        } else if (delta.type === "input_json_delta") {
          const acc = jsonAccumulators.get(event.index) ?? "";
          jsonAccumulators.set(event.index, acc + delta.partial_json);
        }
        break;
      }

      case "content_block_stop": {
        const pos = indexToPosition.get(event.index);
        const startBlock = thinkingStarts.get(event.index);
        if (pos !== undefined && startBlock) {
          const block = content[pos];
          if (block?.type === "text") {
            const signature = (startBlock as { signature?: string }).signature;
            content[pos] = {
              type: "thinking",
              thinking: block.text,
              ...(signature ? { signature } : {}),
            };
          }
          thinkingStarts.delete(event.index);
        }
        const jsonStr = jsonAccumulators.get(event.index);
        if (jsonStr !== undefined && pos !== undefined) {
          const block = content[pos];
          // D8：provider 在 stop 时修订 tool_use 身份（OpenAI 族 id/name 可能首片缺席或被切碎），
          // 必须先于 input 解析与 onToolUseComplete 覆盖 —— 否则下游拿到的是 start 时的空串/半截。
          if (block?.type === "tool_use" && event.tool_use) {
            block.id = event.tool_use.id;
            block.name = event.tool_use.name;
          }
          if (block?.type === "tool_use") {
            // O(n) 设计：拼接字符串 + 最终一次性解析，不做增量 parse（对齐 CC raw stream 策略）
            try {
              block.input = normalizeToolInput(jsonStr ? JSON.parse(jsonStr) : {});
            } catch (e) {
              // telemetry: 工具输入 JSON 解析失败（对齐 CC 的同类解析失败打点）
              getLogger().warn("STREAM", `工具输入 JSON 解析失败`, {
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
        break;
      }

      case "message_delta":
        stopReason = event.delta.stop_reason;
        // 统一走 accumulateUsage：补齐此前丢弃的 inputTokens 与 cacheRead/cacheCreation 字段
        // （子代理路径原先只加 outputTokens → 接入计费后会按全价计 + input 计 0）
        accumulateUsage(usage, event.usage);
        break;

      case "error":
        return {
          content,
          stopReason: "error",
          usage,
          errorMessage: `LLM 错误: ${event.error.message}`,
          // R1：结构化字段原样带出，供调用方走 classifyStreamError 精确判定（见 errorMeta 注释）
          errorMeta: {
            type: event.error.type,
            statusCode: event.error.statusCode,
            streamLevel: event.error.streamLevel,
          },
        };

      case "system_api_error":
        // 子代理上下文无 TUI 渲染，静默忽略重试进度事件
        break;
    }
  }

  return { content, stopReason, usage };
}
