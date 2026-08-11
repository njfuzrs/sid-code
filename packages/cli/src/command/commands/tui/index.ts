import type { UnifiedCommand } from "../../types.ts";

/**
 * /tui 命令定义（轻量，启动时加载）。对齐 claude-code §4.6。
 *
 * 切换全屏 Alternate Buffer 模式偏好。运行时无法就地切换（alternateBuffer 是启动期
 * 固定的渲染 prop），故做成「持久化偏好 + 提示重启」：写 settings.json，下次启动生效。
 * 无参显示当前模式。实现在 ./tui.ts。
 */
const tui: UnifiedCommand = {
  type: "local",
  name: "tui",
  aliases: ["fullscreen"],
  description: "切换全屏 TUI（Alternate Buffer）模式偏好（重启生效）",
  argumentHint: "[on|off]",
  source: "builtin",
  userInvocable: true,
  disableModelInvocation: true,
  immediate: true,
  load: () => import("./tui.ts").then((m) => m.default),
};

export default tui;
