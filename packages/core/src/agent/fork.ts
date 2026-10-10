/**
 * 子代理 Fork 模式（Spec 18 §6）
 *
 * 普通子代理从空上下文起步；Fork 子代理继承主代理最近的对话上下文，
 * 复用相同的消息前缀以命中 prompt cache，适合"接着主对话往下钻"的子任务。
 *
 * buildForkMessages 截取主代理消息历史的尾部 N 条，附加子任务提示，
 * 形成子代理的初始消息序列。
 *
 * 契约是「轻量截尾 + 保留已配对的工具往返」：
 * - 截尾：只继承尾部 N 条，不是完整父对话；子代理的 system prompt / 工具池按自己的类型
 *   重建，所以**不承诺与父级字节相同、不承诺命中父级 prompt cache**。
 * - 工具往返：已配对的 tool_use / tool_result 原样保留 —— 父级刚读过的文件内容就在
 *   tool_result 里，丢掉它子代理只能看到「问题在 42 行」这种无法核验的断言并重读一遍
 *   （F1，2026-10-07：此前实现无条件丢弃全部工具块）。只删截断造成的**未配对**块。
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
 * 移除会破坏 API 协议的悬空工具块，已配对的 tool_use / tool_result 原样保留。
 *
 * 配对判据与协议一致：assistant 消息里的 tool_use 必须在**紧随其后的** user 消息里
 * 有同 id 的 tool_result；反过来 tool_result 必须指向紧邻上一条 assistant 里保留下来的
 * tool_use。截尾最常留下的悬空形态是首条 user 里那批 tool_result（对应的 tool_use 被
 * 截掉了），以及末条 assistant 里还没有结果的 tool_use。
 *
 * thinking / redacted_thinking 一律丢弃：签名绑定父级的模型与请求，子代理可能换模型，
 * 带过去只会被服务端拒收。消息丢完块后为空则整条跳过。
 */
function stripDanglingToolBlocks(messages: ForkMessage[]): ForkMessage[] {
  const resultIdsAt = (i: number): Set<string> => {
    const next = messages[i + 1];
    const ids = new Set<string>();
    if (!next || next.role !== "user") return ids;
    for (const b of next.content) {
      if (b.type === "tool_result") ids.add(b.tool_use_id);
    }
    return ids;
  };

  const result: ForkMessage[] = [];
  // 上一条 assistant 实际保留下来的 tool_use id（只对紧随其后的 user 消息有效）
  let keptUseIds = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    let content: ContentBlock[];
    if (msg.role === "assistant") {
      const answered = resultIdsAt(i);
      content = msg.content.filter(
        (b) => b.type === "text" || (b.type === "tool_use" && answered.has(b.id)),
      );
      keptUseIds = new Set(content.flatMap((b) => (b.type === "tool_use" ? [b.id] : [])));
    } else {
      const usable = keptUseIds;
      content = msg.content.filter(
        (b) => b.type === "text" || (b.type === "tool_result" && usable.has(b.tool_use_id)),
      );
      keptUseIds = new Set();
    }
    if (content.length === 0) continue;
    result.push({ role: msg.role, content });
  }
  return result;
}
