import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";

/** /config 命令 */
export class ConfigCommand implements LocalCommandModule {
  async call(_args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    // 无参数 → 打开结构化配置浏览面板
    if (!_args.trim()) {
      return { type: "dialog", dialog: "config" };
    }

    // 有参数（向后兼容文本模式）
    const lines = [
      `提供商: ${ctx.config.provider}`,
      `模型: ${ctx.config.model}`,
      `最大 Token: ${ctx.config.maxTokens}`,
      `权限模式: ${ctx.config.permissionMode}`,
      `TUI: 启用`,
      `工具数量: ${ctx.toolRegistry.size()}`,
    ];
    return { type: "text", value: lines.join("\n") };
  }
}
