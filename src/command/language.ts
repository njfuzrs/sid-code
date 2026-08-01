/**
 * /language 命令 — 切换输出语言偏好
 *
 * 用法：
 *   /language              — 显示当前语言偏好
 *   /language zh           — 切换为中文优先（仅当前会话）
 *   /language en           — 切换为英文优先（仅当前会话）
 *   /language auto         — 跟随用户输入语言（**不是**"回退默认"，见下）
 *   /language unset        — 删除偏好，回落缺省（缺省 = 中文优先）
 *   /language <lang> -p    — 切换并持久化到 settings.json（跨会话，别名 --persist / save）
 *
 * `auto` 与 `unset` 是**两件不同的事**，这里曾经混为一谈：
 *   - `auto`  = 有偏好，偏好内容是"跟着用户说什么语言就用什么语言"
 *   - `unset` = 没有偏好，回落产品缺省（中文优先）
 * 旧实现把 `auto` 当成 `unset` 的别名，于是三个取值只有两种行为，`auto` 形同虚设；
 * 状态显示还把"未设置"回显成 `auto`，让用户以为自己已经在自动模式了。
 *
 * 持久化语义与 /model、/effort、/theme 对齐：默认仅当会话生效，加 -p 才写盘。
 * 切换后立即重建系统提示词，下一轮 LLM 调用即用新语言（不必等重开会话）。
 * 别名 /lang。
 */

import type { Command, AppContext, CommandResult } from "./types.ts";
import {
  LANGUAGE_PREFS,
  type LanguagePref,
  describeLanguagePref,
  detectSystemLanguage,
  normalizeLanguagePref,
} from "../config/prompt-lang.ts";

/** 显式回退缺省的说法（与 auto 区分开） */
const UNSET_TOKENS = new Set(["unset", "default", "none"]);

export class LanguageCommand implements Command {
  name() { return "language"; }
  aliases() { return ["lang"]; }
  description() { return "显示或切换输出语言偏好（-p 持久化）"; }
  argumentHint() { return "[zh|en|auto|unset] [-p]"; }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const persist = tokens.some((t) => t === "-p" || t === "--persist" || t === "save");
    const langArg = tokens.find((t) => t !== "-p" && t !== "--persist" && t !== "save");

    // 无参数 → 显示当前语言 + 用法。
    if (!langArg) {
      return { kind: "message", message: this.buildStatus(ctx) };
    }

    const raw = langArg.toLowerCase();

    // unset / default / none → 删除偏好字段，回落缺省（中文优先）。
    if (UNSET_TOKENS.has(raw)) {
      await ctx.setLanguage?.(undefined, persist);
      return {
        kind: "message",
        message: `输出语言偏好已清除，回落缺省（中文优先）${this.persistNote(persist)}`,
      };
    }

    // 复用 normalizeLanguagePref：用户写 zh-CN / English / EN_US 都能命中，
    // 不必记住必须写成两字母小写。
    const norm = normalizeLanguagePref(raw);
    if (!norm) {
      return { kind: "error", message: this.buildInvalid(langArg) };
    }

    await ctx.setLanguage?.(norm, persist);

    // auto 档额外回显"当前会落到哪种语言"——否则用户切了 auto 却看不出效果，
    // 无从判断系统 locale 探测是否如他所愿。
    const detail = norm === "auto"
      ? `（跟随用户输入语言；判断不出时用${detectSystemLanguage() === "en" ? "英文" : "中文"}）`
      : `（${describeLanguagePref(norm)}）`;

    return {
      kind: "message",
      message: `输出语言已切换为: ${norm}${detail}${this.persistNote(persist)}`,
    };
  }

  private persistNote(persist: boolean): string {
    return persist
      ? "，并已保存到 settings.json（跨会话生效）"
      : "（仅当前会话，加 -p 可持久化）";
  }

  private buildStatus(ctx: AppContext): string {
    const cur = ctx.config.language as LanguagePref | undefined;
    // 「未设置」必须显示成"未设置（缺省中文优先）"，不能回显成 auto——
    // 那会让用户以为已经在自动模式，而实际行为是强制中文。
    const shown = cur ?? "(未设置)";
    return [
      `当前输出语言: ${shown} — ${describeLanguagePref(cur)}`,
      ...(cur === "auto"
        ? [`  判断不出用户语言时回落: ${detectSystemLanguage() === "en" ? "英文" : "中文"}（按系统 locale）`]
        : []),
      "",
      "可用值:",
      "  zh     — 中文优先",
      "  en     — 英文优先",
      "  auto   — 跟随用户输入语言（每轮按用户所用语言应答）",
      "  unset  — 清除偏好，回落缺省（中文优先）",
      "",
      "用法: /language <zh|en|auto|unset> [-p]（-p 持久化到 settings.json）",
      "也可用 --language 启动参数或 SID_LANGUAGE 环境变量（优先级：参数 > 环境变量 > settings.json）",
    ].join("\n");
  }

  private buildInvalid(input: string): string {
    return [
      `无效的语言 "${input}"`,
      "",
      "可用值:",
      "  zh     — 中文优先",
      "  en     — 英文优先",
      "  auto   — 跟随用户输入语言",
      "  unset  — 清除偏好，回落缺省（中文优先）",
      "",
      `用法: /language <${LANGUAGE_PREFS.join("|")}|unset> [-p]`,
    ].join("\n");
  }
}
