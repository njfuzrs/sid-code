import type { UnifiedCommand } from "../../types.ts";

/** /worktree 命令定义（轻量，启动时加载）。实现在 ./worktree.ts。 */
const worktree: UnifiedCommand = {
  type: "local",
  name: "worktree",
  aliases: ["wt"],
  description: "管理 Git Worktree (list/clean)",
  source: "builtin",
  // 只放 list（A2 档，D13）：clean 会删过期 worktree 目录（cleanupStaleWorktrees），
  // 判定依据是 mtime，无头脚本无法先看一眼再决定。无参放行（缺省即 list）。
  headless: { subcommands: ["list"] },
  outputPanel: true,
  load: () => import("./worktree.ts").then((m) => new m.WorktreeCommand()),
};

export default worktree;
