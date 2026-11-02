import type { UnifiedCommand } from "../../types.ts";

/** /memory 命令定义（轻量，启动时加载）。实现在 ./memory.ts。 */
const memory: UnifiedCommand = {
  type: "local",
  name: "memory",
  aliases: ["mem"],
  description: "管理记忆（无参打开交互面板）",
  argumentHint: "[auto|external|set|get|delete|list|search|show|reload] [参数]",
  source: "builtin",
  outputPanel: true,
  load: () => import("./memory.ts").then((m) => new m.MemoryCommand()),
};

export default memory;
