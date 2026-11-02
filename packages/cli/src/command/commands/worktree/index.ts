import type { UnifiedCommand } from "../../types.ts";

/** /worktree 命令定义（轻量，启动时加载）。实现在 ./worktree.ts。 */
const worktree: UnifiedCommand = {
  type: "local",
  name: "worktree",
  aliases: ["wt"],
  description: "管理 Git Worktree (list/clean)",
  source: "builtin",
  outputPanel: true,
  load: () => import("./worktree.ts").then((m) => new m.WorktreeCommand()),
};

export default worktree;
