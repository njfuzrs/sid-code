import type { LocalCommandModule, CommandContext } from "../../types.ts";

/**
 * /compact 命令实现（按需加载）
 *
 * 三种模式（参数分流）：
 *   1. 无参 `/compact`：全量摘要式压缩——提取所有消息文本摘要后用
 *      ctxMgr.compactWithSummary 替换（历史稳定行为，保持不变）。
 *   2. 数字参数 `/compact <比例|下标>`（G22 接线）：部分压缩（partial-compact）——
 *      只把对话**前半段**压成一份 LLM 背景摘要，保留后半段原文不动，语义边界更清晰。
 *      - `0<小数<1`（如 `/compact 0.5`）：压缩最早的 ~50%
 *      - `整数>=1`（如 `/compact 20`）：压缩到第 20 条消息为止
 *   3. 文本参数 `/compact <focus 指令>`（对齐 claude-code 语义）：focus 压缩——
 *      把对话压成一份 LLM 摘要，并**指导摘要器重点保留与该 focus 相关的信息**。
 *      如 `/compact focus on auth errors` → 生成偏向 auth 的摘要。
 *      复用 partialCompact 的安全边界 + LLM 摘要链路，保留最近少量原文，
 *      focus 文本作为 customInstructions 注入摘要 prompt。
 *
 *   partialCompact 走安全 round 边界 + 完整性双校验，绝不切碎 tool_use/tool_result 对；
 *   失败时回退提示并保持消息历史不变。
 *
 * 超越 CC 点：我们同时支持"数字部分压缩"与"文本 focus"，CC 只有 focus。
 */

/** focus 模式保留的最近原文条数（摘要偏向 focus，但最近对话仍完整可见） */
const FOCUS_KEEP_RECENT = 2;

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
      const arg = args.trim();

      if (arg) {
        const upTo = Number(arg);
        const isNumeric = Number.isFinite(upTo) && upTo > 0;

        // ── 数字参数：G22 部分压缩（压前半段，保留后半段原文）──
        if (isNumeric) {
          return await runPartial(ctx, {
            upTo,
            before,
            tokensBefore,
            successPrefix: (compacted, saved, after) =>
              `部分压缩完成：压缩最早 ${compacted} 条为摘要，` +
              `节省 ~${saved} token（${before} → ${after} 条消息）`,
          });
        }

        // ── 文本参数：focus 压缩（对齐 CC）——压缩整段但重点保留 focus 相关 ──
        // upTo 用一个大值（partialCompact 内部 clamp 到 messageCount-2），
        // 保留最近 FOCUS_KEEP_RECENT 条原文；focus 文本注入摘要 prompt。
        return await runPartial(ctx, {
          // desired 下标 = 尽量多压，保留最近 FOCUS_KEEP_RECENT 条
          upTo: Math.max(1, before - FOCUS_KEEP_RECENT),
          customInstructions:
            `请在总结时**重点保留与「${arg}」相关的信息**：` +
            `与之相关的用户意图、已做决策、涉及的文件与代码片段、错误与纠正都要完整保留，` +
            `其它内容可以更简略。`,
          before,
          tokensBefore,
          successPrefix: (_compacted, saved, after) =>
            `focus 压缩完成：已生成偏向「${arg}」的摘要，` +
            `节省 ~${saved} token（${before} → ${after} 条消息）`,
        });
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

/**
 * 数字部分压缩 / focus 压缩共享的执行体（都走 partialCompact 的安全 LLM 摘要链路）。
 * 差异只在 upTo、customInstructions 与成功文案。
 */
async function runPartial(
  ctx: CommandContext,
  opts: {
    upTo: number;
    customInstructions?: string;
    before: number;
    tokensBefore: number;
    successPrefix: (compactedCount: number, savedTokens: number, after: number) => string;
  },
): Promise<{ type: "text"; value: string }> {
  const { partialCompact } = await import("../../../query/compact/index.ts");
  // 摘要用低成本模型优先（子代理 summarize 档），否则回退主模型
  const compactModel =
    ctx.providerRegistry?.getModelForSubAgent("summarize") ?? ctx.config.model;

  const result = await partialCompact(ctx.ctxMgr.getMessages(), opts.upTo, {
    provider: ctx.provider,
    model: compactModel,
    customInstructions: opts.customInstructions,
  });

  if (!result.success) {
    return { type: "text", value: `压缩未执行：${result.reason ?? "未知原因"}` };
  }

  ctx.ctxMgr.setMessages(result.messages);
  const after = ctx.ctxMgr.messageCount();

  // §3.2：手动压缩也触发 PostCompact hook（trigger=manual）
  try {
    const tokensAfter = ctx.ctxMgr.estimateTokens();
    await ctx.hookSystem?.firePostCompactEvent("manual", opts.before, after, Math.max(0, opts.tokensBefore - tokensAfter));
  } catch {
    // hook 异常不影响压缩结果
  }

  return {
    type: "text",
    value: opts.successPrefix(result.compactedCount, result.savedTokens, after),
  };
}

export default mod;
