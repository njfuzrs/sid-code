import type { LocalCommandModule, LocalCommandResult, CommandContext } from "../../types.ts";
import { getThinkingEnvOverride, type ThinkingSetting } from "@sid-code/core/llm/effort.ts";

/**
 * /think 命令实现（按需加载）
 *
 * 用法:
 *   /think           - 显示当前思考开关状态 + 模型能力
 *   /think on        - 开启思考
 *   /think off       - 关闭思考
 *   /think auto      - 恢复 auto（跟随模型/provider 默认）
 *   /think on -p     - 切换并持久化到 settings.json（别名 --persist / save）
 *   /think help      - 显示用法
 *
 * 思考开关与「推理强度」（/effort）正交：开关控制是否思考，强度控制思考多深。
 * 当前模型不支持显式思考开关（如 OpenAI o-series 内置推理）时，本命令会提示而不下发。
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
    // 能力门控：模型没有独立思考开关时直接说明（推理深度由 /effort 决定）。
    if (state && !state.capability.supportsThinkingToggle) {
      return { type: "text", value: NO_TOGGLE_NOTE };
    }

    if (!arg) {
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
    const label = setting === undefined ? "auto（跟随默认）" : setting;
    const envNote = buildEnvOverrideNote();
    // 恒思考模型：意图照存（切回可关闭的模型时自动生效），但如实说这个模型上不生效。
    // 此前只打一条 warn 日志，状态栏显示「关」、模型照样在想（20261016 排查 D5）。
    const lockedNote =
      state?.capability.thinkingControl === "locked-on" && setting === "off"
        ? `\n${LOCKED_ON_NOTE}`
        : "";
    return {
      type: "text",
      value: `思考开关已设为: ${label}${persist ? "，并已保存到 settings.json" : ""}${envNote}${lockedNote}`,
    };
  },
};

/** 无独立开关族（kimi / gpt-5.x / grok / o 系 / 未知族）的提示：说清楚由什么控制。 */
export const NO_TOGGLE_NOTE =
  "当前模型没有独立的思考开关，推理深度由 /effort 控制（思考行为由模型自身决定）。";

/** 恒思考模型（Opus 5.5 / Sonnet 5.5 / Fable / Mythos / GLM-5.3 等）关闭时的提示。 */
export const LOCKED_ON_NOTE =
  "⚠ 当前模型恒思考，服务端不接受关闭，本模型上仍会思考；切到可关闭思考的模型后 off 自动生效。";

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
    "  /think auto       恢复 auto（跟随模型/provider 默认）",
    "  /think on -p      切换并持久化到 settings.json（别名 --persist / save）",
    "  /think help       显示本用法",
    "",
    "说明：",
    "  · 模型不支持显式思考开关时（如 OpenAI o-series 内置推理），本命令仅提示不下发，推理深度用 /effort 调。",
    "  · 恒思考模型（状态栏显示 ✻·不可关）上 off 不生效，切到可关闭的模型后自动生效。",
    "  · 环境变量 SID_CODE_THINKING 会覆盖运行时切换。",
  ].join("\n");
}

export default mod;
