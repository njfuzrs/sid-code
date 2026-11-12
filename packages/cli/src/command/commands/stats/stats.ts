import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";

/**
 * token 数千分位（D19）。
 *
 * `/debug` 一直有、`/cost` 与 `/stats text` 没有 —— 同一个数字在三个入口长得不一样，
 * 大数（累计发送常到 7 位）肉眼根本数不清位数。这里与 `/debug` 用同一种写法
 * （`toLocaleString("en-US")`），不引第三方格式化库。
 */
function fmtTok(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** /stats 命令 — 会话统计 */
export class StatsCommand implements LocalCommandModule {
  async call(_args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    // 无参数 → 打开结构化统计面板（交互式）
    if (!_args.trim()) {
      return { type: "dialog", dialog: "stats" };
    }

    // 有参数（如 /stats text）→ 文本模式（向后兼容脚本化场景）
    const { SessionState } = await import("@sid-code/core/session/state.ts");
    const ss = ctx.sessionState;
    const totalUsage = ss.getTotalUsage();
    const totalRequests = ss.getTotalRequests();

    const lines = [
      "会话统计",
      "─────────────────────",
      `对话轮数：${ctx.ctxMgr.getTurnCount()}`,
      `消息总数：${ctx.ctxMgr.messageCount()}`,
      // D19：标口径 + 千分位。这里是 **flow（累计发送）** 口径（getTotalUsage().inputTokens
      // = ΣcumulativePromptTokens），与 `/cost`、`/debug` 的「输入」同源；状态栏 `↑`
      // 是另一个口径（stock：末次请求的完整 prompt），两个数在同一个会话里必然不等，
      // 不标口径用户会以为其中一个算错了（D3）。
      `Token 用量：输入 ${fmtTok(totalUsage.inputTokens)}（累计发送，flow）/ 输出 ${fmtTok(totalUsage.outputTokens)}（累计）`,
      // 把 stock 口径摆在同一处，和 `/cost`、`/debug` 的「当前上下文」行对齐：
      // /stats 虽然更精简，但少了这一行就无法解释「为什么 Footer 的 ↑ 和这里的输入差很多」。
      `当前上下文：${fmtTok(ss.getStockPromptTokens())}（stock，末次请求的完整 prompt；状态栏 ↑ 同一口径）`,
      `API 请求：${totalRequests} 次`,
      `预估费用：$${ss.getEffectiveTotalCostUSD().toFixed(4)}`,
      `会话时长：${SessionState.formatDuration(ss.getElapsedMs())}`,
    ];

    // P2-3：git 操作度量（commit/push/PR 创建等），有计数才展示，避免空行噪音。
    const { getGitOperationStats } = await import("@sid-code/core/tool/git-operation-tracking.ts");
    const git = getGitOperationStats();
    if (git.total > 0) {
      const detail = Object.entries(git.byKind)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k} ${n}`)
        .join(" / ");
      lines.push(`Git 操作：${git.total} 次（${detail}）`);
    }
    return { type: "text", value: lines.join("\n") };
  }
}
