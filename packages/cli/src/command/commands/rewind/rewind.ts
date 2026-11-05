import { emitRewind } from "@sid-code/core/session/rewind-telemetry.ts";
import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";

// B2：原 `/mcp` 命令类 MCPCommand 已删除（死代码，从未 new/register）。
// 唯一实现为 commands/mcp/mcp.ts 的 MCPEnhancedCommand；
// 其 usePrompt 逻辑已迁至 MCPPromptRunCommand（/mcp prompt 子命令，见 B3）。

/** /rewind 命令 — 回退最近 n 轮对话 */
export class RewindCommand implements LocalCommandModule {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const trimmed = args.trim();

    // P2-2：无参数 → 打开统一回退选择器（对标 CC 的 Esc+Esc 菜单）。
    // 让用户在交互面板里选「回退点」+「仅对话 / 对话+代码」，实现代码/对话/两者的统一入口。
    if (!trimmed) {
      return { type: "dialog", dialog: "rewind" };
    }

    // 向后兼容：`/rewind <n>` 保留「仅回退 n 轮对话」的脚本化快捷路径（不弹面板、不动文件）。
    const n = Math.max(1, parseInt(trimmed) || 1);
    // G2：抛错也记 error。只记 ok/nothing 会让「回滚失败」的真实形态从分母里消失。
    let removed: number;
    try {
      removed = ctx.ctxMgr.rewindTurns(n);
    } catch (e) {
      emitRewind("rewind_n", "error", {
        requested: n,
        error_name: (e as Error)?.name ?? "Error",
      });
      throw e;
    }
    if (removed === 0) {
      // G2：空转也要记——「敲了回退但没东西可退」和「回退成功」在返工归因里是两件事
      emitRewind("rewind_n", "nothing", { requested: n, turns_removed: 0 });
      return { type: "text", value: "没有可回退的对话" };
    }
    emitRewind("rewind_n", "ok", { requested: n, turns_removed: removed });
    return {
      type: "text",
      value: `已回退 ${removed} 轮对话，当前共 ${ctx.ctxMgr.getTurnCount()} 轮`,
    };
  }
}
