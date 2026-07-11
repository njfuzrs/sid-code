import type { LocalCommandModule } from "../../types.ts";

/**
 * /compact 命令实现（按需加载）
 *
 * 两种模式：
 *   1. 无参 `/compact`：全量摘要式压缩——提取所有消息文本摘要后用
 *      ctxMgr.compactWithSummary 替换（历史稳定行为，保持不变）。
 *   2. 带参 `/compact <比例|下标>`（G22 接线）：部分压缩（partial-compact）——
 *      只把对话**前半段**压成一份 LLM 背景摘要，保留后半段原文不动，语义边界更清晰。
 *      - `0<小数<1`（如 `/compact 0.5`）：压缩最早的 ~50%
 *      - `整数>=1`（如 `/compact 20`）：压缩到第 20 条消息为止
 *      partialCompact 走安全 round 边界 + 完整性双校验，绝不切碎 tool_use/tool_result 对；
 *      失败时回退提示并保持消息历史不变。
 */
const mod: LocalCommandModule = {
  async call(args, ctx) {
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

      // ── 带参模式：G22 部分压缩 ──
      const upToArg = args.trim();
      if (upToArg) {
        const upTo = Number(upToArg);
        if (!Number.isFinite(upTo) || upTo <= 0) {
          return {
            type: "text",
            value:
              "用法：/compact [比例|下标]\n" +
              "  · /compact           全量压缩整段历史\n" +
              "  · /compact 0.5       部分压缩最早的 ~50%，保留后半段原文\n" +
              "  · /compact 20        部分压缩到第 20 条消息为止",
          };
        }

        const { partialCompact } = await import("../../../query/compact/index.ts");
        // 摘要用低成本模型优先（子代理 summarize 档），否则回退主模型
        const compactModel =
          ctx.providerRegistry?.getModelForSubAgent("summarize") ?? ctx.config.model;
        const result = await partialCompact(ctx.ctxMgr.getMessages(), upTo, {
          provider: ctx.provider,
          model: compactModel,
        });

        if (!result.success) {
          return { type: "text", value: `部分压缩未执行：${result.reason ?? "未知原因"}` };
        }

        // 用部分压缩后的消息序列整体替换
        ctx.ctxMgr.setMessages(result.messages);
        const after = ctx.ctxMgr.messageCount();

        // §3.2：手动压缩也触发 PostCompact hook（trigger=manual）
        try {
          const tokensAfter = ctx.ctxMgr.estimateTokens();
          await ctx.hookSystem?.firePostCompactEvent("manual", before, after, Math.max(0, tokensBefore - tokensAfter));
        } catch {
          // hook 异常不影响压缩结果
        }

        return {
          type: "text",
          value:
            `部分压缩完成：压缩最早 ${result.compactedCount} 条为摘要，` +
            `节省 ~${result.savedTokens} token（${before} → ${after} 条消息）`,
        };
      }

      // ── 无参模式：全量摘要式压缩（历史行为）──
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
