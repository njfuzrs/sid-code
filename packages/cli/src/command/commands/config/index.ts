import type { UnifiedCommand } from "../../types.ts";

/** /config 命令定义（轻量，启动时加载）。实现在 ./config.ts。 */
const config: UnifiedCommand = {
  type: "local",
  name: "config",
  aliases: ["settings"],
  description: "显示当前配置",
  source: "builtin",
  outputPanel: true,
  load: () => import("./config.ts").then((m) => new m.ConfigCommand()),
};

export default config;
