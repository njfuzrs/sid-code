import type { UnifiedCommand } from "../../types.ts";

/** /reload-plugins 命令定义（轻量，启动时加载）。实现在 ./reload-plugins.ts。 */
const reloadPlugins: UnifiedCommand = {
  type: "local",
  name: "reload-plugins",
  aliases: ["reload-plugin"],
  description: "重新加载所有插件组件（命令/Skills/Hooks/MCP）",
  source: "builtin",
  outputPanel: true,
  load: () => import("./reload-plugins.ts").then((m) => new m.ReloadPluginsCommand()),
};

export default reloadPlugins;
