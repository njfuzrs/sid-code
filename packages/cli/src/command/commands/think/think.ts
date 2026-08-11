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
    // 能力门控：模型不支持思考开关时直接说明。
    if (state && !state.capability.supportsThinkingToggle) {
      return {
        type: "text",
        value: "当前模型不支持显式思考开关（如内置推理模型）。思考行为由模型自身决定。",
      };
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
    return {
      type: "text",
      value: `思考开关已设为: ${label}${persist ? "，并已保存到 settings.json" : ""}${envNote}`,
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
    "  /think auto       恢复 auto（跟随模型/provider 默认）",
    "  /think on -p      切换并持久化到 settings.json（别名 --persist / save）",
    "  /think help       显示本用法",
    "",
    "说明：",
    "  · 模型不支持显式思考开关时（如 OpenAI o-series 内置推理），本命令仅提示不下发。",
    "  · 环境变量 SID_CODE_THINKING 会覆盖运行时切换。",
  ].join("\n");
}

export default mod;
