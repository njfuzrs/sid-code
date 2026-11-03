import type { UnifiedCommand } from "../../types.ts";

/** /exit 命令定义（轻量，启动时加载）。实现在 ./exit.ts。 */
const exit: UnifiedCommand = {
  type: "local",
  name: "exit",
  aliases: ["quit", "q"],
  description: "退出程序",
  source: "builtin",
  load: () => import("./exit.ts").then((m) => new m.ExitCommand()),
};

export default exit;
