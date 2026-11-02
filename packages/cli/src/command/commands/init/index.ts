import type { UnifiedCommand } from "../../types.ts";

/** /init 命令定义（轻量，启动时加载）。实现在 ./init.ts。 */
const init: UnifiedCommand = {
  type: "local",
  name: "init",
  aliases: [],
  description: "分析代码库并生成 CLAUDE.md（--dirs-only 仅初始化 .sid-code/ 目录）",
  source: "builtin",
  headless: true,
  load: () => import("./init.ts").then((m) => new m.InitCommand()),
};

export default init;
