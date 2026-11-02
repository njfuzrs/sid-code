import type { UnifiedCommand } from "../../types.ts";

/** /agents 命令定义（轻量，启动时加载）。实现在 ./agents.ts。 */
const agents: UnifiedCommand = {
  type: "local",
  name: "agents",
  aliases: [],
  description: "自定义 Agents 管理",
  source: "builtin",
  outputPanel: true,
  subCommands: () => [
    {
      type: "local",
      name: "list",
      aliases: ["ls"],
      description: "列出所有自定义 agents",
      source: "builtin",
      load: () => import("./agents.ts").then((m) => new m.AgentsListCommand()),
    },
  ],
  load: () => import("./agents.ts").then((m) => new m.AgentsCommand()),
};

export default agents;
