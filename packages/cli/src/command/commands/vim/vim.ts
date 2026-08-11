import type { LocalCommandModule, LocalCommandResult, CommandContext } from "../../types.ts";

/**
 * /vim 命令实现（按需加载）
 *
 * 用法：
 *   /vim          — toggle（在编辑/普通模式间翻转当前会话）
 *   /vim on|off   — 显式开/关
 *   /vim on -p    — 开并持久化到 settings.json（跨会话生效，别名 --persist / save）
 *
 * 状态由 ctx.setVimMode 推送到 TUIState.vimMode → 状态栏 ·v 标记即时反映。
 * 持久化语义与 /theme、/effort 对齐：默认仅当会话生效，加 -p 才落盘。
 */
const mod: LocalCommandModule = {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const persist = tokens.some((t) => t === "-p" || t === "--persist" || t === "save");
    const rest = tokens.filter((t) => t !== "-p" && t !== "--persist" && t !== "save");
    const arg = rest[0]?.toLowerCase();

    if (!ctx.setVimMode) {
      return { type: "text", value: "当前环境不支持切换 Vim 模式（无 TUI）。" };
    }

    // 解析目标态：显式 on/off，否则 toggle（基于当前值）。
    let target: boolean;
    if (arg === "on" || arg === "true" || arg === "enable") {
      target = true;
    } else if (arg === "off" || arg === "false" || arg === "disable") {
      target = false;
    } else if (!arg) {
      const current = ctx.getVimMode?.() ?? false;
      target = !current;
    } else {
      return {
        type: "text",
        value: `错误: 无效参数 "${rest[0]}"\n用法: /vim [on|off] [-p]（无参 = 切换）`,
      };
    }

    ctx.setVimMode(target, persist);

    const stateText = target ? "已开启 Vim 输入模式" : "已关闭 Vim 输入模式";
    const persistText = persist
      ? "，并已保存到 settings.json（跨会话生效）"
      : "（仅当前会话，加 -p 可持久化）";
    return { type: "text", value: `${stateText}${persistText}` };
  },
};

export default mod;
