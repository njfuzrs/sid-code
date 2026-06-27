/**
 * 压缩前消息剥离（Strip 操作，对标 claude-code stripImages / stripReinjectedAttachments）
 *
 * 摘要 LLM 的输入应只含"能被文字摘要保留"的内容。两类内容剥离后能提高摘要效率与质量：
 *   1. **图片块**：图片 token 开销大，但文字摘要无法保留其语义，发给摘要 LLM 纯属浪费。
 *      注意：sid-code 的 ContentBlock 严格联合类型当前不含 "image"，但 MCP / 多模态 provider
 *      可能注入 type:"image" 的块（运行时存在、类型上不可见）。故按运行时 type 字段防御性过滤。
 *   2. **post-compact 重注入的恢复消息**：上一次压缩后注入的"文件恢复 / Plan 恢复 / 决策点"消息，
 *      若不剥离，下一次压缩会把它们再次当作历史内容总结，造成重复累积、信息噪音。
 *
 * 纯函数：不修改入参，返回新数组。无 I/O、无日志。
 */

import type { Message } from "../../llm/types.ts";
import {
  REATTACH_FILE_PREFIX,
  REATTACH_PLAN_PREFIX,
  REATTACH_DECISIONS_PREFIX,
} from "./reattach-markers.ts";

/**
 * 剥离消息中的图片块（运行时 type==="image"）。
 * 剥离后 content 为空的消息整条丢弃（避免空消息破坏角色交替）。
 */
export function stripImages(messages: Message[]): Message[] {
  const result: Message[] = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) {
      result.push(msg);
      continue;
    }
    // 按运行时 type 过滤（"image" 不在静态联合类型里，用 any 断言读取）
    const kept = msg.content.filter((block) => (block as { type: string }).type !== "image");
    if (kept.length === msg.content.length) {
      result.push(msg); // 无图片，引用不变
    } else if (kept.length > 0) {
      result.push({ ...msg, content: kept });
    }
    // kept.length === 0 → 整条丢弃
  }
  return result;
}

/**
 * 剥离之前 post-compact 注入的恢复消息（文件恢复 / Plan 恢复 / 决策点恢复）。
 *
 * 判定：消息首个 text 块以已知重注入前缀开头。这些消息及其紧随的 assistant 确认消息
 * （内部来源 _meta.origin==="compact-reattach"）都应被剥离，避免连环重复累积。
 */
export function stripReinjectedAttachments(messages: Message[]): Message[] {
  return messages.filter((msg) => {
    // 内部来源标记的重注入确认消息：直接剥离
    if (msg._meta?.origin === "compact-reattach") return false;

    const first = msg.content?.[0];
    if (first && first.type === "text") {
      const t = first.text;
      if (
        t.startsWith(REATTACH_FILE_PREFIX) ||
        t.startsWith(REATTACH_PLAN_PREFIX) ||
        t.startsWith(REATTACH_DECISIONS_PREFIX)
      ) {
        return false;
      }
    }
    return true;
  });
}
