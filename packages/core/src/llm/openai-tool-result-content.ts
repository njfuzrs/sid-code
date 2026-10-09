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
 * ## 图片怎么发：放进紧随其后的 user 消息，而不是 tool message
 *
 * OpenAI 规范明确写着「For tool messages, only type `text` is supported」（openapi.yaml 的
 * `ChatCompletionRequestToolMessageContentPart` 只 oneOf 到 text part）。DeepSeek 虽然扩展了
 * tool message 可带图（deepseek-api.md:1852），但这条线服务的是**所有** OpenAI 兼容端点。
 * user 消息的 `image_url` 内容块是各家共同支持的形态，所以图片统一追加成一条 user 消息，
 * 放在本轮全部 tool message 之后（插在 tool message 中间会打断 tool_calls ↔ tool 的配对 → 400）。
 *
 * 发不发由**模型能力**决定（`vision-capability.ts`），不再由 provider 一刀切：
 * 此前 `capabilities().vision === false` 写死，支持图片的 `deepseek-flash` 也一律降级，
 * 用户看到的是「当前 provider 不支持图片回传」（实测会话 20261009-135641-0083c051）。
 *
 * 模型不支持时仍**如实告知"有图但看不到"**，而不是静默抹掉——后者会让模型对着
 * "已附上截图"的文字空想。PDF（document）在 OpenAI 兼容路径没有各家通用的形态，始终降级。
 *
 * `structuredPatch` 刻意不回传（仅供 UI 渲染 diff，见 types.ts 注释），不在此处理。
 */

import type { ToolResultBlock, ToolResultMediaBlock } from "./types.ts";
import { getLogger } from "../debug/logger.ts";

/** 工具失败时给 content 加的前缀标记（OpenAI 协议无 is_error 原生字段，只能落到文本里） */
export const OPENAI_TOOL_ERROR_PREFIX = "[ERROR] ";

/** 序列化选项 */
export interface OpenAIToolResultOptions {
  /**
   * 当前模型是否接受图片输入。`true` 时图片不再降级，由调用方经
   * `collectOpenAIImageMedia` 取出、追加到后续 user 消息。缺省 = 不支持。
   */
  visionEnabled?: boolean;
}

/** 本次会随后续 user 消息发出的图片（visionEnabled 时才有意义） */
export function collectOpenAIImageMedia(
  block: Pick<ToolResultBlock, "mediaBlocks">,
  opts: OpenAIToolResultOptions,
): ToolResultMediaBlock[] {
  if (!opts.visionEnabled || !block.mediaBlocks) return [];
  return block.mediaBlocks.filter((mb) => mb.kind === "image");
}

/** 媒体块 → base64 data URL（Chat Completions `image_url.url` 与 Responses `input_image.image_url` 通用） */
export function mediaBlockToDataURL(mb: ToolResultMediaBlock): string {
  return `data:${mb.mediaType};base64,${mb.data}`;
}

/** 图片随附 user 消息的引导文本：说明这些图来自哪次工具调用，避免模型以为是用户新发的。 */
export function toolImagesLeadText(toolUseIds: readonly string[]): string {
  return `以下图片是上面工具调用（tool_call_id=${toolUseIds.join(", ")}）返回的内容，不是用户新发送的消息。`;
}

/**
 * 把内部 tool_result 块序列化为 OpenAI 兼容路径的 tool message content 字符串。
 *
 * @param block 内部 tool_result 块
 * @param providerName provider 名称，仅用于告警文案定位
 * @param opts visionEnabled 时图片不降级（由调用方另行发送），只说明位置
 * @returns 非空字符串（规范要求 tool message content 非空）
 */
export function serializeToolResultContentForOpenAI(
  block: Pick<ToolResultBlock, "content" | "is_error" | "mediaBlocks" | "tool_use_id">,
  providerName: string,
  opts: OpenAIToolResultOptions = {},
): string {
  // §2.1：规范要求 tool message content 为非空 string。工具返回空串
  //（如 bash 无输出、grep 无匹配）时部分严格网关会判非法 → 400，兜底占位。
  let content = block.content && block.content.length > 0 ? block.content : "(empty)";

  const media = block.mediaBlocks ?? [];
  const sent = collectOpenAIImageMedia(block, opts);
  const dropped = media.filter((mb) => !sent.includes(mb));

  if (sent.length > 0) {
    content += `\n[本工具结果的 ${sent.length} 张图片已作为紧随其后的 user 消息附上，请直接查看。]`;
  }

  // 发不出去的附件（模型不支持图片 / PDF 无通用形态）：在文本里如实交代。
  if (dropped.length > 0) {
    const kinds = dropped.map((mb) => `${mb.kind}(${mb.mediaType})`).join(", ");
    const why = opts.visionEnabled
      ? "OpenAI 兼容协议没有各家通用的文档输入形态"
      : "当前模型不支持图片/文档输入";
    content +=
      `\n[注意：本工具结果还包含 ${dropped.length} 个富媒体附件（${kinds}），` +
      `但${why}，你看不到这些内容。` +
      `若需要其中信息，请让用户改用支持视觉的模型，或改用能输出文本的方式获取。]`;
    getLogger().warn(
      "LLM:PROTOCOL",
      `[${providerName}] tool_result（tool_use_id=${block.tool_use_id}）含 ${dropped.length} 个 ` +
        `mediaBlocks 未能发送（${why}），已降级为文本说明。`,
    );
  }

  // is_error：OpenAI 协议下 tool message 没有原生错误字段，用前缀标注而非静默抹掉。
  if (block.is_error) {
    content = OPENAI_TOOL_ERROR_PREFIX + content;
  }

  return content;
}
