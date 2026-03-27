/**
 * /theme 命令 — 切换主题
 *
 * 用法：
 *   /theme          — 显示当前主题和可用主题列表
 *   /theme <name>   — 切换到指定主题
 */

import type { Command, AppContext, CommandResult } from "./types.ts";
import { themeManager } from "../ui/themes/theme-manager.ts";

export class ThemeCommand implements Command {
  name() { return "theme"; }
  aliases() { return []; }
  description() { return "显示或切换主题"; }

  async execute(args: string, _ctx: AppContext): Promise<CommandResult> {
    const trimmed = args.trim();

    if (!trimmed) {
      // 无参数时打开交互式主题选择对话框
      return { kind: "dialog", dialog: "theme" };
    }

    return this.switchTheme(trimmed);
  }

  private showThemes(): CommandResult {
    const current = themeManager.getActiveTheme();
    const themes = themeManager.getAvailableThemes();

    const lines = [
      `当前主题: ${current.name} (${current.type})`,
      "",
      "可用主题:",
    ];

    for (const t of themes) {
      const marker = t.name === current.name ? " ✓" : "";
      lines.push(`  ${t.name} (${t.type})${marker}`);
    }

    lines.push("", "使用 /theme <name> 切换主题");

    return { kind: "message", message: lines.join("\n") };
  }

  private switchTheme(themeName: string): CommandResult {
    const success = themeManager.setActiveTheme(themeName);
    if (!success) {
      const available = themeManager.getAvailableThemes()
        .map(t => `  ${t.name}`)
        .join("\n");
      return {
        kind: "error",
        message: `未找到主题 "${themeName}"\n\n可用主题:\n${available}`,
      };
    }

    return {
      kind: "message",
      message: `主题已切换为: ${themeName}`,
    };
  }
}
