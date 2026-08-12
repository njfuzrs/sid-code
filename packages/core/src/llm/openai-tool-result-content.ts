/**
 * OpenAI 兼容路径的 tool_result 内容序列化（单一事实源）
 *
 * 背景（审计第 6 条）：`ToolResultBlock` 有四个字段进上下文——`content` / `is_error` /
 * `mediaBlocks` / `structuredPatch`。Anthropic 路径（`anthropic.ts` 的
 * `serializeToolResultBlock`）把前三个都发出去了；OpenAI 兼容路径此前**只取 `content`**，
 * `is_error` 与 `mediaBlocks` 无处安放，静默丢弃：
 *
 * - `is_error` 丢失（**任何工具报错 + OpenAI 兼容 provider 即必现**）：模型无法区分
 *   "工具成功返回了这段文本" 与 "工具失败了，这段是错误信息"，可能把报错当有效结果继续推理。
 * - `mediaBlocks` 丢失：模型完全看不到工具返回的图像，却看到 content 里说"已附上截图"。
 *
 * 为什么不像 Anthropic 那样拼多部件 content：OpenAI 规范明确写着
 * 「For tool messages, only type `text` is supported」（openapi.yaml 的
 * `ChatCompletionRequestToolMessageContentPart` 只 oneOf 到 text part），
 * 且本项目 OpenAI provider 的 `capabilities().vision === false`。
 * 因此图片无法真正回传，正确做法是**如实告知模型"有图但看不到"**，而不是假装附上、
 * 也不是静默抹掉——后者会让模型对着"已附上截图"的文字空想。
 *
 * `structuredPatch` 刻意不回传（仅供 UI 渲染 diff，见 types.ts 注释），不在此处理。
 */

import type { ToolResultBlock } from "./types.ts";
import { getLogger } from "../debug/logger.ts";

/** 工具失败时给 content 加的前缀标记（OpenAI 协议无 is_error 原生字段，只能落到文本里） */
export const OPENAI_TOOL_ERROR_PREFIX = "[ERROR] ";

/**
 * 把内部 tool_result 块序列化为 OpenAI 兼容路径的 tool message content 字符串。
 *
 * @param block 内部 tool_result 块
 * @param providerName provider 名称，仅用于告警文案定位
 * @returns 非空字符串（规范要求 tool message content 非空）
 */
export function serializeToolResultContentForOpenAI(
  block: Pick<ToolResultBlock, "content" | "is_error" | "mediaBlocks" | "tool_use_id">,
  providerName: string,
): string {
  // §2.1：规范要求 tool message content 为非空 string。工具返回空串
  //（如 bash 无输出、grep 无匹配）时部分严格网关会判非法 → 400，兜底占位。
  let content = block.content && block.content.length > 0 ? block.content : "(empty)";

  // mediaBlocks：无法回传（协议只允许 text part + 本 provider vision=false），
  // 但要在文本里如实交代，避免模型对着"已附上截图"空想。
  if (block.mediaBlocks && block.mediaBlocks.length > 0) {
    const kinds = block.mediaBlocks.map((mb) => `${mb.kind}(${mb.mediaType})`).join(", ");
    content +=
      `\n[注意：本工具结果还包含 ${block.mediaBlocks.length} 个富媒体附件（${kinds}），` +
      `但当前 provider 的工具消息不支持图片/文档回传，你看不到这些内容。` +
      `若需要其中信息，请让用户改用支持视觉的模型，或改用能输出文本的方式获取。]`;
    getLogger().warn(
      "LLM:PROTOCOL",
      `[${providerName}] tool_result（tool_use_id=${block.tool_use_id}）含 ${block.mediaBlocks.length} 个 ` +
        `mediaBlocks，OpenAI 兼容路径无法回传（协议 tool message 仅支持 text part），已降级为文本说明。`,
    );
  }

  // is_error：OpenAI 协议下 tool message 没有原生错误字段，用前缀标注而非静默抹掉。
  if (block.is_error) {
    content = OPENAI_TOOL_ERROR_PREFIX + content;
  }

  return content;
}
