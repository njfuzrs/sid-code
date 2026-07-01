/**
 * consumeStream — 统一的 LLM 流消费工具函数
 *
 * 封装 for-await 循环 + signal 纵深防御检查，所有 side-call（辅助 LLM 调用）
 * 和主循环流消费可复用此函数，避免各处独立实现 signal 检查逻辑。
 *
 * 设计要点：
 * - 每次 event 到达后立即检查 signal.aborted（纵深防御）
 * - signal abort 时抛 Error("Request aborted") 保持一致语义
 * - handler 返回 false 可提前终止消费（break 语义）
 */

import type { StreamEvent } from "./types.ts";

export interface ConsumeStreamOptions {
  /** 外部 abort signal，abort 后立即中断消费 */
  signal?: AbortSignal;
}

/**
 * 消费 LLM 流式响应，带 signal 纵深防御。
 *
 * @param stream - Provider 返回的 AsyncIterable<StreamEvent>
 * @param handler - 每个事件的处理函数，返回 false 提前终止
 * @param opts - 可选配置（signal）
 * @throws Error("Request aborted") 当 signal 被 abort 时
 *
 * @example
 * ```ts
 * const { text, usage } = await consumeStreamToText(stream, { signal });
 * ```
 */
export async function consumeStream(
  stream: AsyncIterable<StreamEvent>,
  handler: (event: StreamEvent) => void | boolean | Promise<void | boolean>,
  opts?: ConsumeStreamOptions,
): Promise<void> {
  const { signal } = opts ?? {};
  for await (const event of stream) {
    // 纵深防御：每次 event 到达后检查 signal，防止 provider 层超时失效时挂死
    if (signal?.aborted) {
      throw new Error("Request aborted");
    }
    const shouldContinue = await handler(event);
    if (shouldContinue === false) break;
  }
}

/**
 * 消费 LLM 流并累积文本内容 + usage 的便捷封装。
 * 大多数 side-call（recall / compact / classifier / evaluator）都是这个模式。
 */
export async function consumeStreamToText(
  stream: AsyncIterable<StreamEvent>,
  opts?: ConsumeStreamOptions,
): Promise<{ text: string; usage: any | null }> {
  let text = "";
  let usage: any = null;
  await consumeStream(
    stream,
    (event) => {
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        text += event.delta.text;
      } else if (event.type === "message_stop" && (event as any).usage) {
        usage = (event as any).usage;
      }
    },
    opts,
  );
  return { text, usage };
}
