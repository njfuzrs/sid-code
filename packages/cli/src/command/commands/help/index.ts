import type { UnifiedCommand } from "../../types.ts";

/** /help 命令定义（轻量，启动时加载）。实现在 ./help.ts。 */
const help: UnifiedCommand = {
  type: "local",
  name: "help",
  aliases: ["h", "?"],
  description: "显示帮助信息",
  source: "builtin",
  outputPanel: true,
  load: () => import("./help.ts").then((m) => new m.HelpCommand()),
};

export default help;
