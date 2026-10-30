/**
 * 无头结果的「本轮答案」取数（F1-D04）。
 *
 * 一轮用户 prompt 可能产生多条带文本的 assistant 消息：todo 收尾门禁、续写、强制总结轮
 * 都会让模型先交付完整报告、再补一句收尾。旧实现 json 取「最后一条 assistant」、
 * stream-json 取「倒序第一条 assistant 的 text」，于是结果只剩那句收尾，报告只在轨迹里；
 * text 模式累加全部增量，反而是对的。三种格式在这里收成同一口径。
 *
 * 入参是**本轮**的 assistant 消息（调用方从 assistant_message 事件收集），而不是
 * 「消息历史 + 起始下标」：轮中压缩会整体替换历史（setMessages），下标随之失效，
 * 按下标切会把前几轮的文本算进来或把本轮报告切掉。事件流不受压缩影响。
 */

import type { Message, TextBlock } from "../llm/types.ts";

export interface TurnAssistantText {
  /** 本轮全部 assistant 的 text block，按出现顺序（不含 thinking / tool_use 等） */
  blocks: TextBlock[];
  /** 拼接文本：同一条消息内的 text 直接相连，消息之间空一行 */
  text: string;
}

export function collectTurnAssistantText(messages: readonly Message[]): TurnAssistantText {
  const blocks: TextBlock[] = [];
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const texts = m.content.filter(
      (b): b is TextBlock => b.type === "text" && typeof b.text === "string",
    );
    const joined = texts.map((b) => b.text).join("");
    // 只有空白的消息不进结果：它对调用方没有信息，却会在拼接里留下多余空行。
    if (joined.trim() === "") continue;
    blocks.push(...texts.filter((b) => b.text.trim() !== ""));
    parts.push(joined);
  }
  return { blocks, text: parts.join("\n\n") };
}
