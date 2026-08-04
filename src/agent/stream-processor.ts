/**
 * StreamProcessor — 流式响应处理共享组件
 *
 * 从 sub-agent.ts 和 loop.ts 提取，统一处理 LLM 流式响应：
 * - 累积 ContentBlock（text / tool_use）
 * - 累加 Usage
 * - 转换 error 事件为 stopReason="error"（不抛异常）
 */

import type { ContentBlock, StreamEvent, Usage } from "../llm/types.ts";
import { accumulateUsage } from "../llm/types.ts";
import { getLogger } from "../debug/index.ts";
import { normalizeToolInput } from "../llm/normalize-tool-input.ts";
import { resetOnStreamRestart, describeStreamRestart } from "../llm/stream-restart.ts";
import { emitTimeoutFired } from "../trace/stream-observer.ts";
import { createStreamLifecycle, LIFECYCLE_PRESETS } from "../llm/stream-lifecycle.ts";

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

/** 子代理流处理器配置（T4：补齐心跳 + 整体超时，对标主循环 query/stream-processor.ts） */
export interface AgentStreamOptions {
  /** 中止信号（B1 纵深防御：流消费中检查，防止 abort 无法穿透底层时挂死） */
  signal?: AbortSignal;
  /**
   * 获取 AbortController（用于超时时主动中断上游流）。
   * 与主循环 query/stream-processor 的 getAbortController 同义。
   */
  getAbortController?: () => AbortController | null | undefined;
  /** 心跳超时（毫秒，默认 60000 = 60s 无数据 → abort） */
  heartbeatTimeoutMs?: number;
  /** 整体超时（毫秒，默认 180000 = 3min，子代理应比主循环 300s 更短） */
  overallTimeoutMs?: number;
  /** 心跳检查间隔（毫秒，默认 5000） */
  heartbeatCheckIntervalMs?: number;
}

/**
 * 处理 LLM 流式响应，累积内容块和用量信息
 * 对标 claude-code 的 accumulative stream 处理模式
 *
 * T4：补齐 setInterval 心跳（60s 无数据）+ 整体超时（180s），对标主循环
 * query/stream-processor.ts:70-100。子代理流 stall 时不再依赖外层 5min
 * Promise.race（在 Bun 事件循环阻塞时可能延迟触发），而是每 5s 主动检查
 * 并 abort 上游。超时后返回 stopReason="error"（不抛异常，与既有契约一致）。
 *
 * 向后兼容：第二参可传 AbortSignal（旧签名）或 AgentStreamOptions（新签名）。
 */
export async function processStream(
  stream: AsyncIterable<StreamEvent>,
  signalOrOptions?: AbortSignal | AgentStreamOptions,
): Promise<StreamProcessResult> {
  // 兼容旧签名：第二参为 AbortSignal 时归一化为 options
  const options: AgentStreamOptions =
    signalOrOptions instanceof AbortSignal
      ? { signal: signalOrOptions }
      : (signalOrOptions ?? {});
  const signal = options.signal;

  const content: ContentBlock[] = [];
  let stopReason: string | null = null;
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const jsonAccumulators = new Map<number, string>();

  // ── T7：心跳 + 整体超时改由 StreamLifecycle 统一管理（替代原 setInterval 手写心跳）──
  // idle（心跳）= 60s 无事件 → abort；overall = 180s 请求级绝对上限。子代理阈值比主循环短。
  // 行为与迁移前 setInterval 版等价：超时触发 → abort 上游 + 返回 stopReason="error"（不抛异常）。
  const HEARTBEAT_TIMEOUT = options.heartbeatTimeoutMs ?? LIFECYCLE_PRESETS.subAgent.idleTimeoutMs;
  const OVERALL_TIMEOUT = options.overallTimeoutMs ?? LIFECYCLE_PRESETS.subAgent.overallTimeoutMs;
  let timeoutError: Error | null = null;

  const lifecycle = createStreamLifecycle<StreamEvent>({
    idleTimeoutMs: HEARTBEAT_TIMEOUT,
    overallTimeoutMs: OVERALL_TIMEOUT,
    // stall 告警阈值——不小于心跳超时，避免超时前的噪音告警（测试短超时下亦不误报）。
    stallWarnMs: Math.max(HEARTBEAT_TIMEOUT, 30_000),
    label: "SUB-AGENT",
    onTimeout: (layer) => {
      if (layer === "overall") {
        timeoutError = new Error(
          `sub-agent stream overall timeout: ${OVERALL_TIMEOUT / 1000}s 总时长超限`,
        );
        getLogger().warn("AGENT_STREAM", `整体超时: ${OVERALL_TIMEOUT / 1000}s`);
        emitTimeoutFired(-1, "agent_overall_timeout", { elapsed_ms: OVERALL_TIMEOUT });
        options.getAbortController?.()?.abort("agent-stream-overall-timeout");
      } else {
        // idle 层等价于原"心跳超时"（content_progress 未启用，不会走到该分支）
        timeoutError = new Error(
          `sub-agent stream heartbeat timeout: ${HEARTBEAT_TIMEOUT / 1000}s 无数据`,
        );
        getLogger().warn("AGENT_STREAM", `心跳超时: ${HEARTBEAT_TIMEOUT / 1000}s 无数据`);
        emitTimeoutFired(-1, "agent_heartbeat_timeout", { idle_ms: HEARTBEAT_TIMEOUT });
        options.getAbortController?.()?.abort("agent-stream-heartbeat-timeout");
      }
    },
  });

  try {
    for await (const event of lifecycle.guard(stream)) {
      // T4：一旦超时标志置位，主动退出循环返回错误（不再消费残余事件）
      if (timeoutError) {
        return {
          content,
          stopReason: "error",
          usage,
          errorMessage: (timeoutError as Error).message,
        };
      }

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
        const outcome = resetOnStreamRestart({ content, jsonAccumulators });
        if (outcome.discardedBlocks > 0 || outcome.discardedTextLength > 0) {
          getLogger().warn("AGENT_STREAM", describeStreamRestart(event, outcome));
        }
        break;
      }

      case "content_block_start":
        if (event.content_block.type === "text") {
          content[event.index] = { type: "text", text: "" };
        } else if (event.content_block.type === "tool_use") {
          content[event.index] = {
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
          const block = content[event.index];
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
        const jsonStr = jsonAccumulators.get(event.index);
        if (jsonStr !== undefined) {
          const block = content[event.index];
          if (block?.type === "tool_use") {
            // O(n) 设计：拼接字符串 + 最终一次性解析，不做增量 parse（对齐 CC raw stream 策略）
            try {
              block.input = normalizeToolInput(jsonStr ? JSON.parse(jsonStr) : {});
            } catch (e) {
              // telemetry: 工具输入 JSON 解析失败（对齐 CC tengu_tool_input_json_parse_fail）
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
  } finally {
    // T7：StreamLifecycle 在其 finally 中自清理全部定时器，此处无需额外清理。
  }

  // T4：循环正常结束后仍需检查超时标志（stream 自然 end 与超时 abort 竞态时）
  if (timeoutError) {
    return {
      content,
      stopReason: "error",
      usage,
      errorMessage: (timeoutError as Error).message,
    };
  }

  return { content, stopReason, usage };
}
