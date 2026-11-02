import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";

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
      `Token 用量：输入 ${totalUsage.inputTokens} / 输出 ${totalUsage.outputTokens}`,
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
