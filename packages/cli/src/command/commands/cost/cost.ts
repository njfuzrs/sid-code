import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";

/** /cost 命令 */
export class CostCommand implements LocalCommandModule {
  async call(_args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const { SessionState } = await import("@sid-code/core/session/state.ts");
    const ss = ctx.sessionState;
    const totalUsage = ss.getTotalUsage();

    // D7：`≈` 表示「金额由非 USD 币种按固定汇率折算成 USD」（估算值），判据看价格数据本身
    // （SessionState.isCostFxConverted），不看模型名。同一笔钱在 Footer / /cost / /debug
    // 三处必须同一写法，否则用户会误以为三处口径不同。
    const fxConverted = ss.isCostFxConverted();
    const cur = fxConverted ? "≈$" : "$";

    const lines = [
      `会话时长: ${SessionState.formatDuration(ss.getElapsedMs())}`,
      `总费用: ${cur}${ss.getEffectiveTotalCostUSD().toFixed(4)}`,
      ...(ss.sideCostUSD > 0
        ? [`  其中辅助调用: ${cur}${ss.sideCostUSD.toFixed(4)}（标题/记忆/分类/摘要等）`]
        : []),
      `API 耗时: ${SessionState.formatDuration(ss.totalAPIDuration)}`,
      `工具耗时: ${SessionState.formatDuration(ss.totalToolDuration)}`,
      "",
      "Token 用量（汇总）:",
      `  输入: ${totalUsage.inputTokens}`,
      `  输出: ${totalUsage.outputTokens}`,
    ];

    if (totalUsage.cacheCreationInputTokens) {
      lines.push(`  缓存创建: ${totalUsage.cacheCreationInputTokens}`);
    }
    if (totalUsage.cacheReadInputTokens) {
      lines.push(`  缓存读取: ${totalUsage.cacheReadInputTokens}`);
    }

    // 模块 B：本会话缓存命中率 + 省钱（经归一化单一事实源）
    const cacheView = ss.getNormalizedCacheUsage();
    if (cacheView.cacheHitTokens > 0 && cacheView.promptTotal > 0) {
      const rate = ((cacheView.cacheHitTokens / cacheView.promptTotal) * 100).toFixed(1);
      const savings = ss.getTotalCacheSavings();
      lines.push("", `缓存命中率: ${rate}%   省钱: ${cur}${savings.toFixed(4)}`);
      // P2-2：openai 协议路径为服务端隐式缓存（无客户端主动写入 cache_control，
      // cacheCreation 恒 0），命中率结构性上限约 60-70%，不同于 anthropic 族显式缓存的 90%+。
      // 对该族标注正常上限，避免用户把 60-70% 误判为 harness bug。以协议路径为准，非按模型名单。
      //
      // 判据必须与命中率同源：上面的命中率是全会话跨模型聚合（getNormalizedCacheUsage 遍历
      // modelUsage），所以这里也遍历 modelUsage，按每条记账时的 provider 判断。
      // 不能用 ctx.config.provider（当前模型）+ 全会话 cacheCreation：先 anthropic 后 /model 切
      // openai、或主模型 openai + anthropic 子代理时，anthropic 那部分的写入量会让条件恒假，
      // 提示要防的「60-70% 误判成 bug」恰好在多协议会话里重新暴露。
      // 写入量也只看 openai 族自己的那几条：该族恒 0（见 llm/openai-usage.ts），
      // 非 0 说明走了显式缓存，结构性上限的解释不再适用。
      const usageList = Object.values(ss.modelUsage);
      const implicitCacheUsage = usageList.filter(
        (s) => s.provider === "openai" && s.cacheReadInputTokens > 0,
      );
      const hasImplicitOnly =
        implicitCacheUsage.length > 0 &&
        implicitCacheUsage.every((s) => s.cacheCreationInputTokens === 0);
      if (hasImplicitOnly) {
        // 混了别的协议族时，整体命中率是两族加权的结果，不能直接拿 60-70% 去套
        const mixed = usageList.some((s) => s.provider !== "openai" && s.cacheReadInputTokens > 0);
        lines.push(
          mixed
            ? "  （本会话混用多个协议族：openai 协议部分为隐式缓存，60-70% 属正常上限；上面的命中率是各族加权结果，不能直接套单一族的标准）"
            : "  （openai 协议为隐式缓存，60-70% 属正常上限；90%+ 需 anthropic 族显式缓存）",
        );
      }
    }

    const models = Object.entries(ss.modelUsage);
    if (models.length > 1) {
      lines.push("", "按模型统计（input 为 flow 累计口径，与上方汇总一致）:");
      for (const [model, stats] of models) {
        // ⚠️ 必须用 cumulativePromptTokens（flow 累计）而非 inputTokens（stock 末次值）。
        // 汇总 input 走 getTotalUsage() = ΣcumulativePromptTokens（flow），若此处用末次 stock，
        // 两者口径不一致：分模型之和 ≪ 汇总（末次值只保留最后一次请求的 prompt 长度），
        // 用户会看到"汇总 input 远大于分模型 input 之和"的诡异对不上。统一为 flow 口径。
        lines.push(
          `  ${model}: ${stats.requests} 次请求, ${cur}${stats.costUSD.toFixed(4)}, input=${stats.cumulativePromptTokens}, output=${stats.outputTokens}`,
        );
      }
    }

    // D7：金额带 `≈` 时给出换算依据，让用户能自己验算「这个数怎么来的」。
    // 汇率取入账时的原始 fxToUSD（1/fx = 每 1 USD 折多少本币），不写死 7.1：
    // 用户配置或网关价可能用别的汇率，写死会和实际计价的汇率不一致。
    if (fxConverted) {
      const conv = ss.getCurrencyConversions();
      if (conv.length > 0) {
        const desc = conv
          .map((c) => `1 USD = ${Number(c.perUSD.toFixed(4))} ${c.currency}`)
          .join("，");
        lines.push("", `币种换算: ${desc}（固定汇率；≈ 表示按此折算的估算值）`);
      }
    }

    return { type: "text", value: lines.join("\n") };
  }
}
