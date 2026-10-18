import type { LocalCommandModule, LocalCommandResult, CommandContext } from "../../types.ts";
import { getThinkingEnvOverride, type ThinkingSetting } from "@sid-code/core/llm/effort.ts";
import {
  thinkingLabelForSetting,
  thinkingIntentOverriddenNote,
  NO_TOGGLE_NOTE,
  LOCKED_ON_NOTE,
} from "../../../ui/utils/thinking-label.ts";

// 文案的事实源在 thinking-label.ts（切模型 / 启动期提示与本命令共用），此处转导出保持旧引用可用。
export { NO_TOGGLE_NOTE, LOCKED_ON_NOTE };

/**
 * /think 命令实现（按需加载）
 *
 * 用法:
 *   /think           - 显示当前思考开关状态 + 模型能力
 *   /think on        - 开启思考
 *   /think off       - 关闭思考
 *   /think auto      - 恢复 auto（跟随模型默认）
 *   /think on -p     - 切换并持久化到 settings.json（别名 --persist / save）
 *   /think help      - 显示用法
 *
 * 思考开关与「推理强度」（/effort）正交：开关控制是否思考，强度控制思考多深。
 * 当前模型不支持显式思考开关（如 OpenAI o-series 内置推理）时，意图照存但如实提示本模型不生效。
 */
const mod: LocalCommandModule = {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const persist = tokens.some((t) => t === "-p" || t === "--persist" || t === "save");
    const arg = tokens.find((t) => t !== "-p" && t !== "--persist" && t !== "save");

    // help 子命令：显式用法说明。
    if (arg && arg.toLowerCase() === "help") {
      return { type: "text", value: buildHelp() };
    }

    const state = ctx.getThinkingState?.();
    const noToggle = !!state && !state.capability.supportsThinkingToggle;

    if (!arg) {
      // 无开关族没有可选项，面板打开也是空的，直接说明（推理深度由 /effort 决定）。
      if (noToggle) return { type: "text", value: NO_TOGGLE_NOTE };
      return { type: "dialog", dialog: "think" };
    }

    const norm = arg.toLowerCase();
    let setting: ThinkingSetting;
    if (norm === "on" || norm === "true" || norm === "1") setting = "on";
    else if (norm === "off" || norm === "false" || norm === "0") setting = "off";
    else if (norm === "auto" || norm === "unset") setting = undefined;
    else {
      return { type: "text", value: `错误: 无效参数 "${arg}"\n可选: on / off / auto` };
    }

    ctx.setThinking?.(setting, persist);
    // 回执带上 Footer 会显示的词（与 Footer、/think 面板同源），三处说法一致。
    const shown = state ? thinkingLabelForSetting(state.capability, setting).text : null;
    const base = setting === undefined ? "auto（跟随模型默认）" : setting;
    const label = shown && shown !== base ? `${base}，状态栏显示 ${shown}` : base;
    const envNote = buildEnvOverrideNote();
    // 恒思考 / 无开关族：意图照存（切到可关闭的模型时自动生效），但如实说这个模型上不生效。
    // 无开关族此前在解析参数前就 return、不保存意图，与 locked-on 的「粘性」不一致——
    // 切到可关模型后 off 不生效（20261018 复审 R9）。
    // 无开关族的 on / auto 同样不改变本模型行为，也要说；locked-on 只有 off 与实际不符。
    const control = state?.capability.thinkingControl;
    const note =
      control === "none"
        ? NO_TOGGLE_NOTE
        : control
          ? thinkingIntentOverriddenNote(control, setting ?? "auto")
          : null;
    return {
      type: "text",
      value: `思考开关已设为: ${label}${persist ? "，并已保存到 settings.json" : ""}${envNote}${note ? `\n${note}` : ""}`,
    };
  },
};

/**
 * env 覆盖提示：若 SID_CODE_THINKING 已设，运行时切换不会改变实际行为，诚实告知。
 */
function buildEnvOverrideNote(): string {
  const env = getThinkingEnvOverride();
  if (env === null) return ""; // env 未设或为 auto，无强制覆盖
  return `\n⚠ 环境变量 SID_CODE_THINKING=${env ? "on" : "off"} 正在覆盖本会话，运行时切换不会改变实际思考开关（取消请 unset 该变量）。`;
}

/** 构建 /think help 用法文本。 */
function buildHelp(): string {
  return [
    "/think —— 思考开关（与 /effort 推理强度正交：开关控制是否思考，强度控制思考多深）",
    "",
    "  /think            显示当前思考开关状态",
    "  /think on         开启思考",
    "  /think off        关闭思考",
    "  /think auto       恢复 auto（跟随模型默认）",
    "  /think on -p      切换并持久化到 settings.json（别名 --persist / save）",
    "  /think help       显示本用法",
    "",
    "说明：",
    "  · 模型不支持显式思考开关时（如 OpenAI o-series 内置推理），意图照存但本模型不生效，推理深度用 /effort 调。",
    "  · 状态栏显示：on / off（手动）、auto·on / auto·off（跟随模型默认）、",
    "    always（恒思考模型，关不掉）、by-model（无独立开关，由模型与 /effort 决定）。",
    "  · 恒思考模型（状态栏 always）上 off 不生效，切到可关闭的模型后自动生效。",
    "  · 环境变量 SID_CODE_THINKING 会覆盖运行时切换。",
  ].join("\n");
}

export default mod;
