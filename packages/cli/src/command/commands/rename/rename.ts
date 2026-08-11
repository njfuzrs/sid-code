import type { LocalCommandModule, LocalCommandResult, CommandContext } from "../../types.ts";

/**
 * /rename 命令实现（按需加载）
 *
 * 用法：
 *   /rename <名字>  — 重命名当前会话为指定名字
 *   /rename         — 基于最近用户消息启发式生成一个名字
 *
 * 名字写入 session_name 元数据（与 --name 同字段），resume 后仍显示、会话列表可见，
 * 并即时刷新状态栏/终端标题。持久化由 App.renameSession 落 sessionStore 元数据完成。
 */
const mod: LocalCommandModule = {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    if (!ctx.renameSession) {
      return { type: "text", value: "当前环境不支持重命名会话（无会话持久化）。" };
    }
    const name = args.trim();
    const finalName = await ctx.renameSession(name || undefined);
    const note = name ? "" : "（据上下文自动生成）";
    return { type: "text", value: `✓ 会话已重命名为「${finalName}」${note}` };
  },
};

export default mod;
