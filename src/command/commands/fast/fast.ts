import type { LocalCommandModule, LocalCommandResult, CommandContext } from "../../types.ts";
import { getLogger } from "../../../debug/logger.ts";

/**
 * /fast 命令实现（按需加载）。对齐 claude-code §4.3。
 *
 * 设计取舍（重要）：CC 的 Fast Mode 是 Opus 系列专属的输出加速端点。我们走公司网关，
 * 网关当前**没有对等的 fast 端点/服务档位**，fallback 层的 `fastMode` 也标注为「预留，暂未启用」
 * （src/llm/fallback.ts:202），消费点为空。
 *
 * 因此本命令**不造假开关**：它切换的是预留配置 config.fastMode（会透传到 fallback 层），
 * 但会诚实告知「当前网关未提供对等能力，开启暂无实际加速」。待网关支持后，这里无需改动即可生效。
 * 严禁写死「哪些模型支持 fast」的名单（feedback-no-hardcoded-model-tier-rules）——是否真加速
 * 由网关能力决定，不由客户端猜。
 *
 * 用法：
 *   /fast          — 显示当前开关态 + 能力说明
 *   /fast on|off   — 切换预留开关（本会话；加 -p 持久化）
 */
const mod: LocalCommandModule = {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const persist = tokens.some((t) => t === "-p" || t === "--persist" || t === "save");
    const rest = tokens.filter((t) => t !== "-p" && t !== "--persist" && t !== "save");
    const arg = rest[0]?.toLowerCase();

    const cur = ctx.config?.fastMode === true;

    // 网关能力说明（固定尾注，避免用户误以为真加速了）。
    const caveat =
      "注: 当前网关未提供对等 fast 能力，开启暂无实际加速效果（此为预留开关，网关支持后自动生效）。";

    // ── 无参：展示当前态 ──
    if (!arg) {
      return {
        type: "text",
        value: [`Fast Mode: ${cur ? "on" : "off"}`, caveat].join("\n"),
      };
    }

    let target: boolean;
    if (arg === "on" || arg === "true" || arg === "enable") {
      target = true;
    } else if (arg === "off" || arg === "false" || arg === "disable") {
      target = false;
    } else {
      return { type: "text", value: `无效参数「${rest[0]}」。用法: /fast [on|off] [-p]` };
    }

    if (ctx.config) ctx.config.fastMode = target;
    if (persist) {
      try {
        const { patchSettingsFile } = await import("../../../config/settings/index.ts");
        patchSettingsFile("userSettings", "fastMode", target);
      } catch (e) {
        getLogger().warn("FAST", `持久化 fastMode 失败: ${(e as Error)?.message}`);
      }
    }

    const stateText = target ? "已开启 Fast Mode 偏好" : "已关闭 Fast Mode 偏好";
    const persistText = persist ? "（已持久化到 settings.json）" : "（仅当前会话）";
    return { type: "text", value: [`${stateText}${persistText}`, caveat].join("\n") };
  },
};

export default mod;
