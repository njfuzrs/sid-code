/**
 * System-reminder 注入（对标 Claude Code 每轮 user message 注入）
 *
 * 从 query/loop.ts 抽出为纯函数，便于单测覆盖。核心职责：把本轮收集的
 * system-reminder 片段（plan 提醒 / todo 回注 / 工作日志摘要）注入到消息序列
 * **最后一条 user 消息**，让 LLM 在注意力最强的位置看到约束。
 *
 * 关键不变量（缺陷修复，见 injectReminders 实现注释）：
 * plan mode 高频场景是连续工具调用，最后一条 user 消息常常**只含 tool_result、
 * 无 text block**。此时必须在 content 末尾**追加** text block 承载 reminder，
 * 而不是放弃注入——否则工具探索轮全部漏注入，恰恰丢在最需要约束的轮次。
 */

import type { Message } from "../llm/types.ts";

/**
 * 把 reminder 注入到 messages 最后一条 user 消息。
 *
 * 不修改入参（in-place 安全）：仅当需要改动时，浅拷贝 messages 数组 + 目标消息 + 其 content。
 * 返回的数组可能与入参同引用（reminderParts 为空时）或为新数组（注入发生时）。
 *
 * @param messages 当前消息序列（通常是 ctxMgr.getCleanedMessages() 的浅拷贝）
 * @param reminderParts 本轮要注入的 reminder 片段，按顺序拼接
 * @returns 注入后的消息序列
 */
export function injectReminders(
  messages: Message[],
  reminderParts: string[],
): Message[] {
  if (reminderParts.length === 0) return messages;

  const reminder = reminderParts.join("\n\n");
  let result = messages;

  for (let i = result.length - 1; i >= 0; i--) {
    const msg = result[i];
    if (msg.role !== "user") continue;

    const content = msg.content as any[];
    const textIdx = content.findIndex((c: any) => c.type === "text");
    const newContent = [...content];

    if (textIdx >= 0) {
      // 已有 text block：前置 reminder（注意力最强位置）
      newContent[textIdx] = {
        ...newContent[textIdx],
        text: reminder + "\n\n" + newContent[textIdx].text,
      };
    } else {
      // 无 text block（纯 tool_result 轮）：在末尾追加独立 text block。
      // OpenAI provider 会把 [tool_result..., text] 拆成「N 条 role:tool + 1 条 role:user」，
      // 顺序合法（见 openai.ts convertMessages），不破坏 tool_calls 协议。
      newContent.push({ type: "text", text: reminder });
    }

    result = [...result];
    result[i] = { ...msg, content: newContent };
    break;
  }

  return result;
}
