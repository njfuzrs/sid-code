import type { LocalCommandModule, LocalCommandResult, CommandContext } from "../../types.ts";
import { EFFORT_LEVELS, isEffortLevel } from "../../../llm/effort.ts";

/**
 * /effort 命令实现（按需加载）
 *
 * 用法:
 *   /effort              - 显示当前推理强度档位 + 模型能力
 *   /effort <level>      - 切换档位：low / medium / high / max
 *   /effort auto         - 恢复 auto（跟随模型默认，不显式下发）
 *   /effort <level> -p   - 切换并持久化到 settings.json（跨会话生效，别名 --persist / save）
 *
 * 统一标度（low/medium/high/max/auto）与底层模型无关；由 effort.ts 能力层翻译成各
 * provider 线格式。当前模型不支持档位切换时，本命令会提示而不下发。
 */
const mod: LocalCommandModule = {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    // 解析持久化标志（-p / --persist / save），其余 token 作为档位。
    const persist = tokens.some((t) => t === "-p" || t === "--persist" || t === "save");
    const levelArg = tokens.find((t) => t !== "-p" && t !== "--persist" && t !== "save");

    const state = ctx.getEffortState?.();
    // 能力门控：当前模型不支持档位切换时，直接说明（避免静默无效切换）。
    if (state && !state.capability.supportsEffort) {
      return {
        type: "text",
        value: "当前模型不支持推理强度档位切换（无 reasoning_effort / thinking budget 能力）。",
      };
    }

    // 无参数 → 展示当前状态。
    if (!levelArg) {
      return { type: "text", value: buildStatus(ctx) };
    }

    const norm = levelArg.toLowerCase();
    if (norm === "auto" || norm === "unset") {
      ctx.setEffort?.(undefined, persist);
      return {
        type: "text",
        value: `推理强度已设为 auto（跟随模型默认）${persist ? "，并已保存到 settings.json" : ""}`,
      };
    }

    if (!isEffortLevel(norm)) {
      return {
        type: "text",
        value: `错误: 无效档位 "${levelArg}"\n可选: ${EFFORT_LEVELS.join(" / ")} / auto`,
      };
    }

    // max 但模型不支持 → 提示将被钳为 high（仍允许设置，由 effort.ts 钳制）。
    let note = "";
    if (norm === "max" && state && !state.capability.supportsMaxEffort) {
      note = "（注意：当前模型不支持 max，实际下发时将降为 high）";
    }

    ctx.setEffort?.(norm, persist);
    return {
      type: "text",
      value: `推理强度已切换为: ${norm}${note}${persist ? "，并已保存到 settings.json" : ""}`,
    };
  },
};

/** 构建当前 effort 状态文本（无参时展示）。 */
function buildStatus(ctx: CommandContext): string {
  const state = ctx.getEffortState?.();
  const lines: string[] = [];
  if (!state) {
    lines.push("推理强度: 未知（运行环境未注入 effort 状态）");
    return lines.join("\n");
  }
  const runtimeText = state.runtime ?? "auto";
  lines.push(`当前推理强度: ${runtimeText}`);
  if (state.isAuto) {
    lines.push(`实际档位(auto 解析): ${state.applied}（跟随模型默认）`);
  }
  lines.push(`模型支持 max: ${state.capability.supportsMaxEffort ? "是" : "否（max 将降为 high）"}`);
  lines.push("", `可切换: ${EFFORT_LEVELS.join(" / ")} / auto`);
  lines.push("用 /effort <档位> 切换，加 -p 持久化到 settings.json");
  return lines.join("\n");
}

export default mod;
