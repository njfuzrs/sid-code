/**
 * 子代理 Fork 模式（Spec 18 §6）
 *
 * 普通子代理从空上下文起步；Fork 子代理继承主代理最近的对话上下文，
 * 复用相同的消息前缀以命中 prompt cache，适合"接着主对话往下钻"的子任务。
 *
 * buildForkMessages 截取主代理消息历史的尾部 N 条，附加子任务提示，
 * 形成子代理的初始消息序列。
 */

import type { ContentBlock } from "../llm/types.ts";

export interface ForkMessage {
  role: string;
  content: ContentBlock[];
}

/**
 * 构建 Fork 子代理的初始消息。
 * @param parentMessages 主代理的消息历史
 * @param forkPrompt 子任务提示
 * @param maxInherit 最多继承的尾部消息数（默认 6）
 */
export function buildForkMessages(
  parentMessages: ForkMessage[],
  forkPrompt: string,
  maxInherit: number = 6,
): ForkMessage[] {
  // 截取尾部 N 条（保持 user/assistant 配对的起点：从 user 开始）
  let tail = parentMessages.slice(-maxInherit);

  // 确保 fork 上下文从 user 消息开始（避免孤立的 assistant/tool_result）
  while (tail.length > 0 && tail[0]!.role !== "user") {
    tail = tail.slice(1);
  }

  // 过滤掉未配对的 tool_use / tool_result（fork 后无法继续执行原工具调用）
  const cleaned = stripDanglingToolBlocks(tail);

  return [
    ...cleaned,
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `[Fork 子任务] 基于以上上下文，完成以下任务并只返回结果：\n\n${forkPrompt}`,
        } as ContentBlock,
      ],
    },
  ];
}

/**
 * 移除会破坏 API 协议的悬空工具块。
 * tool_use 必须紧跟对应的 tool_result，fork 截断可能留下孤立块。
 * 简化策略：丢弃含 tool_use / tool_result 的消息，只保留纯文本消息。
 */
function stripDanglingToolBlocks(messages: ForkMessage[]): ForkMessage[] {
  const result: ForkMessage[] = [];
  for (const msg of messages) {
    const textBlocks = msg.content.filter(
      (b) => b.type === "text",
    );
    // 消息含工具块 → 只保留文本部分；纯工具消息则跳过
    if (textBlocks.length === 0) continue;
    result.push({ role: msg.role, content: textBlocks });
  }
  return result;
}
