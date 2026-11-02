import type { UnifiedCommand } from "../../types.ts";

/** /add-dir 命令定义（轻量，启动时加载）。实现在 ./add-dir.ts。 */
const addDir: UnifiedCommand = {
  type: "local",
  name: "add-dir",
  aliases: [],
  description: "运行时把目录加入当前会话可访问白名单（用户级授权，仅本会话）",
  argumentHint: "<目录路径> | --list | --remove <目录>",
  source: "builtin",
  load: () => import("./add-dir.ts").then((m) => new m.AddDirCommand()),
};

export default addDir;
