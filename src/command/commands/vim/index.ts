import type { UnifiedCommand } from "../../types.ts";

/**
 * /vim 命令定义（轻量，启动时加载）。
 *
 * 切换 Vim 输入模式（编辑/普通模式）。对齐 claude-code /vim。
 * 无参 = toggle；on/off 显式开关；-p 持久化到 settings.json。实现在 ./vim.ts。
 *
 * 说明：本命令负责开关状态与状态栏 ·v 标记；完整的 Vim 键位状态机（hjkl/dd/等）
 * 为后续增量，本期只做模式开关 + 持久化 + 状态栏反映。
 */
const vim: UnifiedCommand = {
  type: "local",
  name: "vim",
  aliases: [],
  description: "切换 Vim 输入模式（无参 toggle；on/off；-p 持久化）",
  argumentHint: "[on|off] [-p]",
  source: "builtin",
  userInvocable: true,
  disableModelInvocation: true,
  immediate: true,
  load: () => import("./vim.ts").then((m) => m.default),
};

export default vim;
