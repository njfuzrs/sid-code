import type { LocalCommandModule, CommandContext } from "../../types.ts";
import { mergeInstructions } from "../../../query/compact/merge-instructions.ts";

/**
 * /compact 命令实现（按需加载）
 *
 * 三种模式（参数分流），全部走 partialCompact 的安全 LLM 摘要链路：
 *   1. 无参 `/compact`：全量摘要式压缩——把对话**除最近 KEEP_RECENT 条外**全部压成一份
 *      LLM 背景摘要（§12 P2-4：从旧的「200 字截断拼接」升级为真正的 LLM 摘要，无损语义）。
 *   2. 数字参数 `/compact <比例|下标>`（G22 接线）：部分压缩（partial-compact）——
 *      只把对话**前半段**压成一份 LLM 背景摘要，保留后半段原文不动，语义边界更清晰。
 *      - `0<小数<1`（如 `/compact 0.5`）：压缩最早的 ~50%
 *      - `整数>=1`（如 `/compact 20`）：压缩到第 20 条消息为止
 *   3. 文本参数 `/compact <focus 指令>`（对齐 claude-code 语义）：focus 压缩——
 *      把对话压成一份 LLM 摘要，并**指导摘要器重点保留与该 focus 相关的信息**。
 *      如 `/compact focus on auth errors` → 生成偏向 auth 的摘要。
 *
 *   partialCompact 走安全 round 边界 + 完整性双校验，绝不切碎 tool_use/tool_result 对；
 *   失败时回退提示并保持消息历史不变。
 *
 * §12 P1-3：手动 /compact 与自动压缩一样，压缩**前**触发 PreCompact hook（trigger=manual），
 *   hook 可 block 阻止压缩，其返回的 additionalContext 作为「额外指令」注入摘要 prompt
 *   （与用户 focus 指令合并，对标 CC mergeHookInstructions）。
 *
 * 超越 CC 点：我们同时支持"数字部分压缩"与"文本 focus"，CC 只有 focus。
 */

/** focus / 无参全量模式保留的最近原文条数（摘要偏向 focus，但最近对话仍完整可见） */
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
      // §12 P1-3：手动压缩前触发 PreCompact("manual")——对齐 CC（手动路径也调 executePreCompactHooks）。
      // blocking 时阻止压缩；否则拿 additionalContext 作为摘要额外指令，与用户 focus 合并。
      let hookInstructions: string | undefined;
      try {
        const pre = await ctx.hookSystem?.firePreCompactEvent("manual");
        if (pre?.finalOutput?.isBlockingDecision()) {
          return {
            type: "text",
            value: `压缩被 hook 阻止：${pre.finalOutput.getEffectiveReason()}`,
          };
        }
        hookInstructions = pre?.finalOutput?.getAdditionalContext?.();
      } catch {
        // PreCompact hook 异常不阻断压缩（与 PostCompact 一致的容错策略）
      }

      const tokensBefore = ctx.ctxMgr.estimateTokens();
      const arg = args.trim();

      if (arg) {
        const upTo = Number(arg);
        const isNumeric = Number.isFinite(upTo) && upTo > 0;

        // ── 数字参数：G22 部分压缩（压前半段，保留后半段原文）──
        if (isNumeric) {
          return await runPartial(ctx, {
            upTo,
            customInstructions: hookInstructions,
            before,
            tokensBefore,
            successPrefix: (compacted, saved, after) =>
              `部分压缩完成：压缩最早 ${compacted} 条为摘要，` +
              `节省 ~${saved} token（${before} → ${after} 条消息）`,
          });
        }

        // ── 文本参数：focus 压缩（对齐 CC）——压缩整段但重点保留 focus 相关 ──
        // upTo 用一个大值（partialCompact 内部 clamp 到 messageCount-2），
        // 保留最近 FOCUS_KEEP_RECENT 条原文；focus 文本 + hook 指令合并注入摘要 prompt。
        const focusInstructions =
          `请在总结时**重点保留与「${arg}」相关的信息**：` +
          `与之相关的用户意图、已做决策、涉及的文件与代码片段、错误与纠正都要完整保留，` +
          `其它内容可以更简略。`;
        return await runPartial(ctx, {
          upTo: Math.max(1, before - FOCUS_KEEP_RECENT),
          customInstructions: mergeInstructions(focusInstructions, hookInstructions),
          before,
          tokensBefore,
          successPrefix: (_compacted, saved, after) =>
            `focus 压缩完成：已生成偏向「${arg}」的摘要，` +
            `节省 ~${saved} token（${before} → ${after} 条消息）`,
        });
      }

      // ── 无参模式：全量 LLM 摘要（§12 P2-4：从旧 200 字截断升级为真正的 LLM 摘要）──
      // 复用 partialCompact 的安全边界 + LLM 摘要链路：把除最近 FOCUS_KEEP_RECENT 条外的全部
      // 对话压成一份背景摘要，保留最近少量原文。hook 指令注入摘要 prompt。
      // 若 LLM 摘要失败（网络/超时），回退到旧的本地截断兜底，保证 /compact 永不变成 no-op。
      const result = await runPartial(ctx, {
        upTo: Math.max(1, before - FOCUS_KEEP_RECENT),
        customInstructions: hookInstructions,
        before,
        tokensBefore,
        successPrefix: (compacted, saved, after) =>
          `对话已压缩：已将最早 ${compacted} 条压成 LLM 摘要，` +
          `节省 ~${saved} token（${before} → ${after} 条消息）`,
        // 无参模式失败时走本地截断兜底
        fallbackOnFailure: true,
      });
      return result;
    } finally {
      ctx.ctxMgr.releaseCompactLock();
    }
  },
};

/**
 * 数字部分压缩 / focus 压缩 / 无参全量摘要共享的执行体（都走 partialCompact 的安全 LLM 摘要链路）。
 * 差异只在 upTo、customInstructions 与成功文案。
 *
 * @param opts.fallbackOnFailure 无参全量模式专用：LLM 摘要失败时回退到本地 200 字截断兜底
 *   （保证 /compact 永不变成 no-op）；数字/focus 模式失败则如实报错、保持历史不变。
 */
async function runPartial(
  ctx: CommandContext,
  opts: {
    upTo: number;
    customInstructions?: string;
    before: number;
    tokensBefore: number;
    successPrefix: (compactedCount: number, savedTokens: number, after: number) => string;
    fallbackOnFailure?: boolean;
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
    if (opts.fallbackOnFailure) {
      // §12 P2-4：无参全量模式 LLM 摘要失败 → 本地截断兜底（有损，但保证释放空间）。
      return runLocalTruncationFallback(ctx, opts.before, opts.tokensBefore);
    }
    return { type: "text", value: `压缩未执行：${result.reason ?? "未知原因"}` };
  }

  ctx.ctxMgr.setMessages(result.messages);
  const after = ctx.ctxMgr.messageCount();

  // §3.2：手动压缩也触发 PostCompact hook（trigger=manual）
  await firePostCompact(ctx, opts.before, after, opts.tokensBefore);

  return {
    type: "text",
    value: opts.successPrefix(result.compactedCount, result.savedTokens, after),
  };
}

/**
 * §12 P2-4：无参全量模式的本地截断兜底（LLM 摘要失败时）。
 * 沿用历史行为：把全部消息文本各取前 200 字拼成一份极简摘要，替换消息历史。有损但保证释放空间。
 */
function runLocalTruncationFallback(
  ctx: CommandContext,
  before: number,
  tokensBefore: number,
): { type: "text"; value: string } {
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
  // fire-and-forget PostCompact（兜底路径不 await，避免阻断返回）
  void firePostCompact(ctx, before, after, tokensBefore);
  return {
    type: "text",
    value: `对话已压缩（LLM 摘要失败，已降级为本地截断）：${before} → ${after} 条消息`,
  };
}

/** §3.2：触发 PostCompact hook（trigger=manual）。hook 异常不影响压缩结果。 */
async function firePostCompact(
  ctx: CommandContext,
  before: number,
  after: number,
  tokensBefore: number,
): Promise<void> {
  try {
    const tokensAfter = ctx.ctxMgr.estimateTokens();
    await ctx.hookSystem?.firePostCompactEvent(
      "manual",
      before,
      after,
      Math.max(0, tokensBefore - tokensAfter),
    );
  } catch {
    // hook 异常不影响压缩结果
  }
}

export default mod;
