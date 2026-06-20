import type { LocalCommandModule, LocalCommandResult, CommandContext } from "../../types.ts";
import type { ThinkingSetting } from "../../../llm/effort.ts";

/**
 * /think 命令实现（按需加载）
 *
 * 用法:
 *   /think           - 显示当前思考开关状态 + 模型能力
 *   /think on        - 开启思考
 *   /think off       - 关闭思考
 *   /think auto      - 恢复 auto（跟随模型/provider 默认）
 *   /think on -p     - 切换并持久化到 settings.json（别名 --persist / save）
 *
 * 思考开关与「推理强度」（/effort）正交：开关控制是否思考，强度控制思考多深。
 * 当前模型不支持显式思考开关（如 OpenAI o-series 内置推理）时，本命令会提示而不下发。
 */
const mod: LocalCommandModule = {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const persist = tokens.some((t) => t === "-p" || t === "--persist" || t === "save");
    const arg = tokens.find((t) => t !== "-p" && t !== "--persist" && t !== "save");

    const state = ctx.getThinkingState?.();
    // 能力门控：模型不支持思考开关时直接说明。
    if (state && !state.capability.supportsThinkingToggle) {
      return {
        type: "text",
        value: "当前模型不支持显式思考开关（如内置推理模型）。思考行为由模型自身决定。",
      };
    }

    if (!arg) {
      return { type: "text", value: buildStatus(ctx) };
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
    return {
      type: "text",
      value: `思考开关已设为: ${label}${persist ? "，并已保存到 settings.json" : ""}`,
    };
  },
};

/** 构建当前 thinking 状态文本（无参时展示）。 */
function buildStatus(ctx: CommandContext): string {
  const state = ctx.getThinkingState?.();
  const lines: string[] = [];
  if (!state) {
    lines.push("思考开关: 未知（运行环境未注入 thinking 状态）");
    return lines.join("\n");
  }
  const runtimeText = state.runtime ?? "auto";
  lines.push(`当前思考开关: ${runtimeText}`);
  if (state.runtime === undefined) {
    lines.push(`实际状态(auto 解析): ${state.applied ? "on" : "off"}（跟随默认）`);
  }
  lines.push("", "可切换: on / off / auto");
  lines.push("用 /think <on|off|auto> 切换，加 -p 持久化到 settings.json");
  return lines.join("\n");
}

export default mod;
