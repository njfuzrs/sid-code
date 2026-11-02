import type { UnifiedCommand } from "../../types.ts";

/** /ide 命令定义（轻量，启动时加载）。实现在 ./ide.ts。 */
const ide: UnifiedCommand = {
  type: "local",
  name: "ide",
  aliases: [],
  description: "IDE 集成管理",
  argumentHint: "[status|connect|disconnect]",
  source: "builtin",
  outputPanel: true,
  subCommands: () => [
    {
      type: "local",
      name: "status",
      aliases: ["ls"],
      description: "显示 IDE 连接状态",
      source: "builtin",
      load: () => import("./ide.ts").then((m) => new m.IDEStatusCommand()),
    },
    {
      type: "local",
      name: "connect",
      aliases: [],
      description: "手动连接到 IDE",
      source: "builtin",
      load: () => import("./ide.ts").then((m) => new m.IDEConnectCommand()),
    },
    {
      type: "local",
      name: "disconnect",
      aliases: [],
      description: "断开 IDE 连接",
      source: "builtin",
      load: () => import("./ide.ts").then((m) => new m.IDEDisconnectCommand()),
    },
  ],
  load: () => import("./ide.ts").then((m) => new m.IDECommand()),
};

export default ide;
