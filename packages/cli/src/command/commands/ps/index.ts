import type { UnifiedCommand } from "../../types.ts";

/** /ps 命令定义（轻量，启动时加载）。实现在 ./ps.ts。 */
const ps: UnifiedCommand = {
  type: "local",
  name: "ps",
  aliases: ["tasks"],
  description: "列出后台任务和活跃会话",
  source: "builtin",
  headless: true,
  outputPanel: true,
  load: () => import("./ps.ts").then((m) => new m.PsCommand()),
};

export default ps;
