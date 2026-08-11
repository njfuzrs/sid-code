import type { LocalCommandModule, LocalCommandResult, CommandContext } from "../../types.ts";
import { getLogger } from "@sid-code/core/debug/logger.ts";

/**
 * /tui（别名 /fullscreen）命令实现（按需加载）。对齐 claude-code §4.6。
 *
 * 运行时无法就地切全屏：alternateBuffer 是 render 时一次性决定的 prop，链路（MouseProvider/
 * 渲染分支/换行控制）全按它一次成型，无运行时 setState 通道。故做成持久化偏好开关——
 * 写 settings.json 的 alternateBuffer 字段，下次启动生效。
 *
 * 用法：
 *   /tui          — 显示当前模式 + toggle 目标态提示
 *   /tui on|off   — 显式设置并持久化（重启生效）
 */
const mod: LocalCommandModule = {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const cur = ctx.config?.alternateBuffer === true;
    const arg = args.trim().toLowerCase();

    // 无参：仅展示当前模式，不改动。
    if (!arg) {
      return {
        type: "text",
        value: [
          `当前渲染模式: ${cur ? "全屏 Alternate Buffer（默认）" : "主屏 Static（--inline 逃生舱）"}`,
          `切换: /tui ${cur ? "off" : "on"}（写入 settings.json，重启后生效）`,
        ].join("\n"),
      };
    }

    let target: boolean;
    if (arg === "on" || arg === "true" || arg === "enable") {
      target = true;
    } else if (arg === "off" || arg === "false" || arg === "disable") {
      target = false;
    } else {
      return { type: "text", value: `无效参数「${arg}」。用法: /tui [on|off]` };
    }

    // 持久化到 settings.json（禁 getSettings→改→write，用 patchSettingsFile）。
    try {
      const { patchSettingsFile } = await import("@sid-code/core/config/settings/index.ts");
      patchSettingsFile("userSettings", "alternateBuffer", target);
    } catch (e) {
      getLogger().warn("TUI", `持久化 alternateBuffer 失败: ${(e as Error)?.message}`);
      return { type: "text", value: `写入 settings 失败: ${(e as Error)?.message ?? e}` };
    }
    // 同步运行时 config，便于本会话内再次 /tui 查询显示新值（渲染仍需重启才切）。
    if (ctx.config) ctx.config.alternateBuffer = target;

    const modeText = target ? "全屏 Alternate Buffer" : "主屏 Static";
    return {
      type: "text",
      value:
        `已将渲染模式设为「${modeText}」并保存到 settings.json。\n` +
        `重启 sid-code 后生效（运行时无法就地切换）。`,
    };
  },
};

export default mod;
