import type { UnifiedCommand } from "../../types.ts";

/** /stats 命令定义（轻量，启动时加载）。实现在 ./stats.ts。 */
const stats: UnifiedCommand = {
  type: "local",
  name: "stats",
  aliases: [],
  description: "显示当前会话统计信息",
  source: "builtin",
  headless: true,
  immediate: true,
  outputPanel: true,
  load: () => import("./stats.ts").then((m) => new m.StatsCommand()),
};

export default stats;
