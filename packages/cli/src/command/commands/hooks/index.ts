import type { UnifiedCommand } from "../../types.ts";

/** /hooks 命令定义（轻量，启动时加载）。实现在 ./hooks.ts。 */
const hooks: UnifiedCommand = {
  type: "local",
  name: "hooks",
  aliases: [],
  description: "管理 Hook (list/enable/disable/enable-all/disable-all，-p 持久化)",
  argumentHint: "[list|enable|disable|enable-all|disable-all] [name] [-p]",
  source: "builtin",
  outputPanel: true,
  load: () => import("./hooks.ts").then((m) => new m.HooksCommand()),
};

export default hooks;
