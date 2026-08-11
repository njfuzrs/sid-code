/**
 * /theme 命令 — 切换主题
 *
 * 用法：
 *   /theme          — 打开交互式主题选择对话框
 *   /theme list     — 显示当前主题和可用主题列表
 *   /theme <name>   — 切换到指定主题（仅当前会话）
 *   /theme <name> -p — 切换并持久化到 settings.json（跨会话生效，别名 --persist / save）
 *
 * 持久化语义与 /model、/effort 对齐：默认仅当会话生效，加 -p 才写盘。
 * 交互对话框选择（无参 /theme）视为用户主动选择，自动持久化（见 App.tsx handleThemeSelect）。
 */

import type { Command, AppContext, CommandResult } from "./types.ts";
import { themeManager } from "../ui/themes/theme-manager.ts";

export class ThemeCommand implements Command {
  name() { return "theme"; }
  aliases() { return []; }
  description() { return "显示或切换主题（-p 持久化）"; }
  argumentHint() { return "[name|list] [-p]"; }

  async execute(args: string, _ctx: AppContext): Promise<CommandResult> {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    // 剥离持久化标志（-p / --persist / save），其余 token 拼回主题名。
    // 注意：主题名含空格（如 "Default Light"、"GitHub Light"），不能只取首 token，
    // 必须把剩余 token 用空格拼回，否则多词主题名会被截断（只切到第一个词）。
    const persist = tokens.some((t) => t === "-p" || t === "--persist" || t === "save");
    const rest = tokens.filter((t) => t !== "-p" && t !== "--persist" && t !== "save");
    const themeName = rest.join(" ");

    if (themeName === "list" || themeName === "ls") {
      return this.showThemes();
    }

    if (rest.length === 0) {
      // 无参数（可能只带了 -p）时打开交互式主题选择对话框。
      return { kind: "dialog", dialog: "theme" };
    }

    return this.switchTheme(themeName, persist);
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

    lines.push("", "使用 /theme <name> 切换主题（加 -p 持久化）");

    return { kind: "message", message: lines.join("\n") };
  }

  private switchTheme(themeName: string, persist: boolean): CommandResult {
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

    // -p 持久化：写 settings.json theme 字段。必用 patchSettingsFile（禁整体覆盖，
    // 见 settings 有损 round-trip 陷阱）。启动时 App 构造函数会从 config.theme 恢复。
    if (persist) {
      try {
        const { patchSettingsFile } = require("@sid-code/core/config/settings/index.ts");
        patchSettingsFile("userSettings", "theme", themeName);
      } catch (e) {
        // 持久化失败不阻断运行时切换，仅提示。
        return {
          kind: "message",
          message: `主题已切换为: ${themeName}（⚠ 持久化失败: ${(e as Error)?.message}，仅当前会话生效）`,
        };
      }
    }

    return {
      kind: "message",
      message: `主题已切换为: ${themeName}${persist ? "，并已保存到 settings.json（跨会话生效）" : "（仅当前会话，加 -p 可持久化）"}`,
    };
  }
}
