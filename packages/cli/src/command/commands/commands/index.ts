import type { UnifiedCommand } from "../../types.ts";

/** /commands 命令定义（轻量，启动时加载）。实现在 ./commands.ts。 */
const commandsCmd: UnifiedCommand = {
  type: "local",
  name: "commands",
  aliases: ["cmds"],
  description: "列出所有自定义命令",
  source: "builtin",
  outputPanel: true,
  load: () => import("./commands.ts").then((m) => new m.CommandsListCommand()),
};

export default commandsCmd;
