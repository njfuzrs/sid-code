/**
 * /language 命令 — 切换输出语言偏好
 *
 * 用法：
 *   /language              — 显示当前语言偏好
 *   /language zh           — 切换为中文优先（仅当前会话）
 *   /language en           — 切换为英文优先（仅当前会话）
 *   /language auto         — 回退默认（删除偏好，系统提示词默认中文）
 *   /language <lang> -p    — 切换并持久化到 settings.json（跨会话，别名 --persist / save）
 *
 * 持久化语义与 /model、/effort、/theme 对齐：默认仅当会话生效，加 -p 才写盘。
 * 切换后立即重建系统提示词，下一轮 LLM 调用即用新语言（不必等重开会话）。
 * 别名 /lang。
 */

import type { Command, AppContext, CommandResult } from "./types.ts";

const VALID_LANGS = ["zh", "en"] as const;
type Lang = (typeof VALID_LANGS)[number];

export class LanguageCommand implements Command {
  name() { return "language"; }
  aliases() { return ["lang"]; }
  description() { return "显示或切换输出语言偏好（-p 持久化）"; }
  argumentHint() { return "[zh|en|auto] [-p]"; }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const persist = tokens.some((t) => t === "-p" || t === "--persist" || t === "save");
    const langArg = tokens.find((t) => t !== "-p" && t !== "--persist" && t !== "save");

    // 无参数 → 显示当前语言 + 用法。
    if (!langArg) {
      return { kind: "message", message: this.buildStatus(ctx) };
    }

    const norm = langArg.toLowerCase();

    // auto / unset / default → 回退默认（删除偏好字段）。
    if (norm === "auto" || norm === "unset" || norm === "default") {
      await ctx.setLanguage?.(undefined, persist);
      return {
        kind: "message",
        message: `输出语言已恢复默认（系统提示词默认中文）${persist ? "，并已保存到 settings.json" : "（仅当前会话，加 -p 可持久化）"}`,
      };
    }

    if (!this.isValidLang(norm)) {
      return {
        kind: "error",
        message: `无效的语言 "${langArg}"\n\n可用值:\n  zh    — 中文优先\n  en    — 英文优先\n  auto  — 回退默认\n\n用法: /language <zh|en|auto> [-p]`,
      };
    }

    await ctx.setLanguage?.(norm, persist);
    const label = norm === "zh" ? "中文优先" : "英文优先";
    return {
      kind: "message",
      message: `输出语言已切换为: ${norm}（${label}）${persist ? "，并已保存到 settings.json（跨会话生效）" : "（仅当前会话，加 -p 可持久化）"}`,
    };
  }

  private buildStatus(ctx: AppContext): string {
    const cur = ctx.config.language;
    const label = cur === "zh" ? "中文优先" : cur === "en" ? "英文优先" : "默认（中文）";
    return [
      `当前输出语言: ${cur ?? "auto"}（${label}）`,
      "",
      "可用值:",
      "  zh    — 中文优先",
      "  en    — 英文优先",
      "  auto  — 回退默认",
      "",
      "用法: /language <zh|en|auto> [-p]（-p 持久化到 settings.json）",
    ].join("\n");
  }

  private isValidLang(v: string): v is Lang {
    return (VALID_LANGS as readonly string[]).includes(v);
  }
}
