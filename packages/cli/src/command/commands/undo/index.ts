import type { UnifiedCommand } from "../../types.ts";

/** /undo 命令定义（轻量，启动时加载）。实现在 ./undo.ts。 */
const undo: UnifiedCommand = {
  type: "local",
  name: "undo",
  aliases: [],
  description: "撤销最近一次文件修改（回滚到上一个 checkpoint）",
  source: "builtin",
  outputPanel: true,
  load: () => import("./undo.ts").then((m) => new m.UndoCommand()),
};

export default undo;
