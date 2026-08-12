/**
 * 消息序列化 → 人类可读 Markdown
 *
 * 导出完整对话历史为 Markdown 格式，方便阅读和分享。
 * 支持 maxBytes 截断保护（剪贴板场景）。
 */

import type { Message, ContentBlock } from "@sid-code/core/llm/types.ts";

export interface SerializeMdOptions {
  sessionId: string;
  model: string;
  provider: string;
  cwd: string;
  sidCodeVersion: string;
  maxBytes?: number;
}

/**
 * 将 Message[] 序列化为人类可读 Markdown。
 * 超过 maxBytes 时从头部截断旧消息。
 */
export function serializeToMarkdown(messages: Message[], options: SerializeMdOptions): string {
  const { maxBytes } = options;
  const header = buildHeader(messages.length, options);

  // 无截断限制：直接全量序列化
  if (!maxBytes) {
    const body = messages.map(renderMessage).join("\n\n---\n\n");
    return `${header}\n\n---\n\n${body}\n`;
  }

  // 有截断限制：从尾部向头部累积，直到超限
  const headerBytes = Buffer.byteLength(header, "utf-8");
  const separatorBytes = Buffer.byteLength("\n\n---\n\n", "utf-8");
  // 预留截断提示的空间
  const reservedBytes = headerBytes + separatorBytes + 200;
  const budget = maxBytes - reservedBytes;

  const renderedMessages: string[] = [];
  let totalBytes = 0;
  let truncatedCount = 0;

  // 从最新消息开始累积
  for (let i = messages.length - 1; i >= 0; i--) {
    const rendered = renderMessage(messages[i]!);
    const msgBytes = Buffer.byteLength(rendered, "utf-8") + separatorBytes;
    if (totalBytes + msgBytes > budget && renderedMessages.length > 0) {
      truncatedCount = i + 1;
      break;
    }
    totalBytes += msgBytes;
    renderedMessages.unshift(rendered);
  }

  const body = renderedMessages.join("\n\n---\n\n");
  const truncateNotice =
    truncatedCount > 0
      ? `\n\n> [...已省略 ${truncatedCount} 条早期消息]\n\n---\n\n`
      : "\n\n---\n\n";

  return `${header}${truncateNotice}${body}\n`;
}

function buildHeader(messageCount: number, opts: SerializeMdOptions): string {
  const now = new Date();
  const timeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return [
    "# 对话导出",
    "",
    `> 会话: ${opts.sessionId}`,
    `> 模型: ${opts.model} (${opts.provider})`,
    `> 时间: ${timeStr}`,
    `> 消息数: ${messageCount}`,
    `> 工作目录: ${opts.cwd}`,
    `> 版本: ${opts.sidCodeVersion}`,
  ].join("\n");
}

function renderMessage(msg: Message): string {
  const parts: string[] = [];

  for (const block of msg.content) {
    parts.push(renderBlock(msg.role, block));
  }

  return parts.join("\n\n");
}

function renderBlock(role: string, block: ContentBlock): string {
  const roleLabel = role === "user" ? "User" : "Assistant";

  switch (block.type) {
    case "text":
      return `## ${roleLabel}\n\n${block.text}`;

    case "tool_use":
      return `## ${roleLabel} [tool_use: ${block.name}]\n\n\`\`\`json\n${formatInput(block.input)}\n\`\`\``;

    case "tool_result": {
      const status = block.is_error ? "error" : "success";
      const content = block.content || "(无内容)";
      return `## ${roleLabel} [tool_result: ${status}]\n\n${content}`;
    }

    case "thinking":
      return `## ${roleLabel} [thinking]\n\n${toBlockquote(block.thinking)}`;

    case "redacted_thinking":
      return `## ${roleLabel} [thinking]\n\n> [思考内容已省略]`;

    default:
      return `## ${roleLabel}\n\n[未知内容块类型]`;
  }
}

/** JSON.stringify input，处理各种类型 */
function formatInput(input: unknown): string {
  if (input === undefined || input === null) return "null";
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/** 文本转 Markdown 引用块 */
function toBlockquote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
