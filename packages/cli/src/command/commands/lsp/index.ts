import type { UnifiedCommand } from "../../types.ts";

/** /lsp 命令定义（轻量，启动时加载）。实现在 ./lsp.ts。 */
const lsp: UnifiedCommand = {
  type: "local",
  name: "lsp",
  aliases: [],
  description: "LSP 代码智能管理",
  argumentHint: "[status|reload]",
  source: "builtin",
  outputPanel: true,
  subCommands: () => [
    {
      type: "local",
      name: "status",
      aliases: ["ls"],
      description: "显示 LSP 系统与各语言服务器状态",
      source: "builtin",
      load: () => import("./lsp.ts").then((m) => new m.LSPStatusCommand()),
    },
    {
      type: "local",
      name: "reload",
      aliases: [],
      description: "重新加载 lsp.json 配置并重启语言服务器",
      source: "builtin",
      load: () => import("./lsp.ts").then((m) => new m.LSPReloadCommand()),
    },
  ],
  load: () => import("./lsp.ts").then((m) => new m.LSPCommand()),
};

export default lsp;
