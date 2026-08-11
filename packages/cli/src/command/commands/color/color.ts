import type { LocalCommandModule, LocalCommandResult, CommandContext } from "../../types.ts";
import { getLogger } from "../../../debug/logger.ts";

/**
 * /color（别名 /accent）命令实现（按需加载）。对齐 claude-code §4.3。
 *
 * 设置 UI 强调色/品牌色——覆盖当前主题的 ui.active（及 text.accent/link/ui.focus）。
 * 只点睛品牌色，不动整套配色，保持三状态体系不扩张（遵守 src/ui/CLAUDE.md L1.2/L1.3）。
 *
 * 用法：
 *   /color              — 显示当前强调色（覆盖值 or 主题原值）
 *   /color #89b4fa      — 设为指定色（hex 或 CSS/Ink 命名色，命名色归一化为 hex）
 *   /color reset        — 清除覆盖，回退主题原品牌色
 *   末尾加 -p / --persist / save 持久化到 settings.json（跨会话生效）
 *
 * 持久化语义与 /theme、/vim 对齐：默认仅当会话生效，加 -p 才写盘。
 * 运行时切换即时生效（themeManager 的 semantic-colors 是 getter 代理，下次渲染读到新值）。
 */
const mod: LocalCommandModule = {
  async call(args: string, _ctx: CommandContext): Promise<LocalCommandResult> {
    const { themeManager } = await import("../../../ui/themes/theme-manager.ts");
    const { isValidColor, resolveColor } = await import("../../../ui/themes/color-utils.ts");

    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const persist = tokens.some((t) => t === "-p" || t === "--persist" || t === "save");
    const rest = tokens.filter((t) => t !== "-p" && t !== "--persist" && t !== "save");
    const arg = rest[0];

    // ── 无参：展示当前强调色 ──
    if (!arg) {
      const override = themeManager.getAccentOverride();
      const active = themeManager.getSemanticColors().ui.active;
      const lines = [
        `当前强调色: ${active}${override ? "（自定义覆盖）" : "（主题默认）"}`,
        "用法: /color <#hex|命名色|reset> [-p]",
      ];
      return { type: "text", value: lines.join("\n") };
    }

    // ── reset：清除覆盖 ──
    if (arg.toLowerCase() === "reset" || arg.toLowerCase() === "default") {
      themeManager.setAccentOverride(undefined);
      if (persist) {
        try {
          const { patchSettingsFile } = await import("../../../config/settings/index.ts");
          // 置 undefined 让 patch 删除该键，回退主题默认。
          patchSettingsFile("userSettings", "accentColor", undefined);
        } catch (e) {
          getLogger().warn("COLOR", `清除 accentColor 持久化失败: ${(e as Error)?.message}`);
        }
      }
      return {
        type: "text",
        value: `已清除强调色覆盖，回退主题默认${persist ? "（并已从 settings.json 移除）" : "（仅当前会话）"}。`,
      };
    }

    // ── 设置：校验 + 归一化为 hex ──
    if (!isValidColor(arg)) {
      return {
        type: "text",
        value: `无效颜色「${arg}」。支持 #RGB / #RRGGBB 十六进制，或 CSS/Ink 命名色（如 blue、cyan）。`,
      };
    }
    // 命名色归一化为 hex 存储，保证跨主题/跨会话稳定（resolveColor 拿不到则回退原值）。
    const hex = resolveColor(arg) ?? arg;

    themeManager.setAccentOverride(hex);
    if (persist) {
      try {
        const { patchSettingsFile } = await import("../../../config/settings/index.ts");
        patchSettingsFile("userSettings", "accentColor", hex);
      } catch (e) {
        getLogger().warn("COLOR", `持久化 accentColor 失败: ${(e as Error)?.message}`);
        return {
          type: "text",
          value: `强调色已设为 ${hex}（⚠ 持久化失败: ${(e as Error)?.message}，仅当前会话生效）`,
        };
      }
    }
    return {
      type: "text",
      value: `强调色已设为 ${hex}${persist ? "，并已保存到 settings.json（跨会话生效）" : "（仅当前会话，加 -p 可持久化）"}。`,
    };
  },
};

export default mod;
