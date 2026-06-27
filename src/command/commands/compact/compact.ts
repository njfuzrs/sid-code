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

    // §6 压缩互斥锁：避免与自动压缩竞态
    if (!ctx.ctxMgr.acquireCompactLock()) {
      return { type: "text", value: "已有压缩流程在进行中，请稍后再试" };
    }

    try {
      const tokensBefore = ctx.ctxMgr.estimateTokens();
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

      // §3.2：手动压缩也触发 PostCompact hook（trigger=manual）
      try {
        const tokensAfter = ctx.ctxMgr.estimateTokens();
        await ctx.hookSystem?.firePostCompactEvent("manual", before, after, Math.max(0, tokensBefore - tokensAfter));
      } catch {
        // hook 异常不影响压缩结果
      }

      return { type: "text", value: `对话已压缩: ${before} → ${after} 条消息` };
    } finally {
      ctx.ctxMgr.releaseCompactLock();
    }
  },
};

export default mod;
