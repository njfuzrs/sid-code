import type { LocalCommandModule, LocalCommandResult, CommandContext } from "../../types.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

/** 从一条消息里拼出纯文本（只取 text 块，忽略 thinking/tool_use/tool_result）。 */
export function extractText(msg: Message): string {
  return msg.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** 提取 markdown 代码块内容（去掉 ``` 围栏与语言标注）。无代码块返回 []。 */
export function extractCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  const FENCE = /```[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = FENCE.exec(text)) !== null) {
    const code = m[1].replace(/\n$/, "");
    if (code.trim()) blocks.push(code);
  }
  return blocks;
}

/** 找最后一条 assistant 消息（含 text 块）。 */
function findLastAssistantText(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "assistant") continue;
    const text = extractText(messages[i]);
    if (text) return text;
  }
  return null;
}

/**
 * /copy 命令实现（按需加载）
 *
 * 用法：
 *   /copy        — 复制最后一条助手回复全文到剪贴板
 *   /copy code   — 只复制其中的代码块（多个则用空行拼接）
 *
 * 剪贴板走 setClipboard（OSC52 + 原生兜底，与 /export 同一套）。
 */
const mod: LocalCommandModule = {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const messages = ctx.ctxMgr.getMessages();
    const text = findLastAssistantText(messages);
    if (!text) {
      return { type: "text", value: "没有可复制的助手回复。" };
    }

    const wantCode = args.trim().toLowerCase() === "code";
    let payload = text;
    if (wantCode) {
      const blocks = extractCodeBlocks(text);
      if (blocks.length === 0) {
        return { type: "text", value: "最后一条助手回复里没有代码块。" };
      }
      payload = blocks.join("\n\n");
    }

    try {
      const { setClipboard } = await import("@sid-code/tui-renderer/termio/osc.ts");
      const oscSeq = await setClipboard(payload);
      if (oscSeq) process.stdout.write(oscSeq);
    } catch {
      return { type: "text", value: "⚠ 剪贴板写入失败（终端可能不支持 OSC52）。" };
    }

    const bytes = Buffer.byteLength(payload, "utf-8");
    const what = wantCode ? "代码块" : "助手回复";
    return {
      type: "text",
      value: `✓ 已复制${what}到剪贴板（${bytes} 字节）`,
    };
  },
};

export default mod;
