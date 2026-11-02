import type { UnifiedCommand } from "../../types.ts";

/** /restore 命令定义（轻量，启动时加载）。实现在 ./restore.ts。 */
const restore: UnifiedCommand = {
  type: "local",
  name: "restore",
  aliases: [],
  description: "恢复到指定快照点",
  source: "builtin",
  outputPanel: true,
  load: () => import("./restore.ts").then((m) => new m.RestoreCommand()),
};

export default restore;
