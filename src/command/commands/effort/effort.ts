import type { LocalCommandModule, LocalCommandResult, CommandContext } from "../../types.ts";
import {
  EFFORT_LEVELS,
  isEffortLevel,
  previewWireEffort,
  getSelectableEfforts,
  getEffortEnvOverride,
  type EffortCapability,
  type EffortLevel,
} from "../../../llm/effort.ts";

/**
 * /effort 命令实现（按需加载）
 *
 * 用法:
 *   /effort              - 显示当前推理强度档位 + 模型能力
 *   /effort <level>      - 切换档位：low / medium / high / max
 *   /effort auto         - 恢复 auto（跟随模型默认，不显式下发）
 *   /effort <level> -p   - 切换并持久化到 settings.json（跨会话生效，别名 --persist / save）
 *   /effort help         - 显示用法
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

    // help 子命令：显式用法说明。
    if (levelArg && levelArg.toLowerCase() === "help") {
      return { type: "text", value: buildHelp() };
    }

    const state = ctx.getEffortState?.();
    // 能力门控：当前模型不支持档位切换时，直接说明（避免静默无效切换）。
    if (state && !state.capability.supportsEffort) {
      return {
        type: "text",
        value: "当前模型不支持推理强度档位切换（无 reasoning_effort / thinking budget 能力）。",
      };
    }

    // 无参数 → 打开快捷切换面板（交互式）。
    if (!levelArg) {
      return { type: "dialog", dialog: "effort" };
    }

    const norm = levelArg.toLowerCase();
    if (norm === "auto" || norm === "unset") {
      ctx.setEffort?.(undefined, persist);
      const envNote = buildEnvOverrideNote();
      return {
        type: "text",
        value: `推理强度已设为 auto（跟随模型默认）${persist ? "，并已保存到 settings.json" : ""}${envNote}`,
      };
    }

    if (!isEffortLevel(norm)) {
      // 可选档位按**当前模型**列举（拿不到能力时退回全量标度）——报错信息里列出模型
      // 压根不支持的档，只会引导用户去选一个随后被静默钳制的值。
      const usable = state ? getSelectableEfforts(state.capability) : EFFORT_LEVELS;
      return {
        type: "text",
        value: `错误: 无效档位 "${levelArg}"\n当前模型可选: ${usable.join(" / ")} / auto`,
      };
    }

    // 钳制提示：对比「请求档 vs 经能力层映射后实际下发档」，被服务端钳制时诚实告知。
    // 通用做法（不写死 provider）：DeepSeek low/medium→high、o-series max→high 都由此覆盖。
    const note = state ? buildClampNote(state.capability, norm) : "";

    ctx.setEffort?.(norm, persist);
    const envNote = buildEnvOverrideNote();
    return {
      type: "text",
      value: `推理强度已切换为: ${norm}${note}${persist ? "，并已保存到 settings.json" : ""}${envNote}`,
    };
  },
};

/**
 * 构建钳制提示：若请求档位经能力层映射后实际下发档位不同，告知用户被钳制。
 * 通用——直接预演 applyToSendParams 的线格式输出，不针对具体 provider 写死规则。
 */
function buildClampNote(cap: EffortCapability, requested: EffortLevel): string {
  const wire = previewWireEffort(cap, requested);
  if (wire === requested) return "";
  // 当前模型仅支持有限档位，请求档被钳制到 wire。
  return `（注意：当前模型不支持 ${requested} 档，实际下发时将按 ${wire} 处理）`;
}

/**
 * env 覆盖提示：若 SID_CODE_EFFORT_LEVEL / CLAUDE_CODE_EFFORT_LEVEL 已设，
 * 则运行时切换不会改变实际下发值，诚实告知用户当前由 env 覆盖。
 */
function buildEnvOverrideNote(): string {
  const env = getEffortEnvOverride();
  if (env === null) return ""; // env 未设，无覆盖
  const which =
    process.env.SID_CODE_EFFORT_LEVEL !== undefined
      ? "SID_CODE_EFFORT_LEVEL"
      : "CLAUDE_CODE_EFFORT_LEVEL";
  const envVal = env === undefined ? "auto" : env;
  return `\n⚠ 环境变量 ${which}=${envVal} 正在覆盖本会话，运行时切换不会改变实际下发的档位（取消请 unset 该变量）。`;
}

/** 构建 /effort help 用法文本。 */
function buildHelp(): string {
  return [
    "/effort —— 推理强度档位（统一标度，与底层模型无关）",
    "",
    "  /effort              显示当前档位 + 模型能力",
    `  /effort <level>      切换档位：${EFFORT_LEVELS.join(" / ")}（当会话生效）`,
    "  /effort auto         恢复 auto（跟随模型默认，不显式下发）",
    "  /effort <level> -p   切换并持久化到 settings.json（别名 --persist / save）",
    "  /effort help         显示本用法",
    "",
    "说明：",
    "  · 模型不支持某档位时（如 DeepSeek 仅 high/max），切换仍接受但会提示实际下发档。",
    "  · 环境变量 SID_CODE_EFFORT_LEVEL（兼容 CLAUDE_CODE_EFFORT_LEVEL）会覆盖运行时切换。",
  ].join("\n");
}

export default mod;
