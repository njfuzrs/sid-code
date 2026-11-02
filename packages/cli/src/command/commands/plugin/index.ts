import type { UnifiedCommand } from "../../types.ts";

/** /plugin 命令定义（轻量，启动时加载）。实现在 ./plugin.ts。 */
const plugin: UnifiedCommand = {
  type: "local",
  name: "plugin",
  aliases: ["plugins"],
  description: "插件管理（无参打开交互面板）",
  argumentHint: "[list|market|marketplaces|info|install|update|uninstall|enable|disable] [插件名]",
  source: "builtin",
  outputPanel: true,
  load: () => import("./plugin.ts").then((m) => new m.PluginCommand()),
};

export default plugin;
