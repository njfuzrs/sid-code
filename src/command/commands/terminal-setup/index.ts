import type { UnifiedCommand } from "../../types.ts";

/**
 * /terminal-setup 命令定义（轻量，启动时加载）。P2-3，对标 claude-code。
 *
 * 为不原生支持 Shift+Enter 换行的终端安装键绑定：
 * - VSCode 系（VSCode/Cursor/Windsurf）：往 keybindings.json 注入 shift+enter → 发送 ESC+CR 序列。
 * - 原生支持 CSI-u / Kitty 键盘协议的终端（iTerm2/WezTerm/Ghostty/Kitty/Warp）：无需配置，直接提示。
 * - 其它终端：给出 `\`+Enter 兜底换行说明。
 */
const terminalSetup: UnifiedCommand = {
  type: "local",
  name: "terminal-setup",
  aliases: [],
  description: "为当前终端安装 Shift+Enter 换行键绑定（VSCode/Cursor/Windsurf 等）",
  source: "builtin",
  userInvocable: true,
  disableModelInvocation: true,
  immediate: true,
  load: () => import("./terminal-setup.ts").then((m) => m.default),
};

export default terminalSetup;
