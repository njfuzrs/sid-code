import type { UnifiedCommand } from "../../types.ts";

/** /checkpoints 命令定义（轻量，启动时加载）。实现在 ./checkpoints.ts。 */
const checkpoints: UnifiedCommand = {
  type: "local",
  name: "checkpoints",
  aliases: ["cp"],
  description: "查看快照历史",
  source: "builtin",
  headless: true,
  outputPanel: true,
  load: () => import("./checkpoints.ts").then((m) => new m.CheckpointsCommand()),
};

export default checkpoints;
