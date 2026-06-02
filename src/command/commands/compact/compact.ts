import type { LocalCommandModule } from "../../types.ts";

/**
 * /compact 命令实现（按需加载）
 * 压缩对话历史：提取消息摘要后用 ctxMgr.compactWithSummary 替换
 */
const mod: LocalCommandModule = {
  async call(_args, ctx) {
    const before = ctx.ctxMgr.messageCount();
    if (before <= 4) {
      return { type: "text", value: "对话历史太短，无需压缩" };
    }

    const messages = ctx.ctxMgr.getMessages();
    const summaryText = messages
      .map((m) => {
        const text = m.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { text: string }).text)
          .join("\n");
        return `[${m.role}] ${text.slice(0, 200)}`;
      })
      .join("\n");

    ctx.ctxMgr.compactWithSummary(summaryText.slice(0, 2000));
    const after = ctx.ctxMgr.messageCount();
    return { type: "text", value: `对话已压缩: ${before} → ${after} 条消息` };
  },
};

export default mod;
