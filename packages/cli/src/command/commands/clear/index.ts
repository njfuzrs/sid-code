import type { UnifiedCommand } from "../../types.ts";

/** /clear 命令定义（轻量，启动时加载）。实现在 ./clear.ts。 */
const clear: UnifiedCommand = {
  type: "local",
  name: "clear",
  aliases: ["reset", "new"],
  description: "清空对话历史",
  source: "builtin",
  load: () => import("./clear.ts").then((m) => new m.ClearCommand()),
};

export default clear;
