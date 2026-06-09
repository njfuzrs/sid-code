/**
 * StreamProcessor — 流式响应处理共享组件
 *
 * 从 sub-agent.ts 和 loop.ts 提取，统一处理 LLM 流式响应：
 * - 累积 ContentBlock（text / tool_use）
 * - 累加 Usage
 * - 转换 error 事件为 stopReason="error"（不抛异常）
 */

import type { ContentBlock, StreamEvent, Usage } from "../llm/types.ts";

/** 流式处理结果 */
export interface StreamProcessResult {
  content: ContentBlock[];
  stopReason: string | null;
  usage: Usage;
  errorMessage?: string;
}

/**
 * 处理 LLM 流式响应，累积内容块和用量信息
 * 对标 claude-code 的 accumulative stream 处理模式
 */
export async function processStream(
  stream: AsyncIterable<StreamEvent>,
): Promise<StreamProcessResult> {
  const content: ContentBlock[] = [];
  let stopReason: string | null = null;
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const jsonAccumulators = new Map<number, string>();

  for await (const event of stream) {
    switch (event.type) {
      case "message_start":
        usage.inputTokens += event.message.usage.inputTokens;
        usage.outputTokens += event.message.usage.outputTokens;
        break;

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
            try {
              block.input = jsonStr ? JSON.parse(jsonStr) : {};
            } catch {
              block.input = {};
            }
          }
          jsonAccumulators.delete(event.index);
        }
        break;
      }

      case "message_delta":
        stopReason = event.delta.stop_reason;
        usage.outputTokens += event.usage.outputTokens;
        break;

      case "error":
        return {
          content,
          stopReason: "error",
          usage,
          errorMessage: `LLM 错误: ${event.error.message}`,
        };

      case "system_api_error":
        // 子代理上下文无 TUI 渲染，静默忽略重试进度事件
        break;
    }
  }

  return { content, stopReason, usage };
}
