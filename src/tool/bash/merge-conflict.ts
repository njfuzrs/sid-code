/**
 * 合并冲突检测（P1-3，运行时增强）
 *
 * git merge / rebase / cherry-pick / pull 执行后，若输出报告冲突，附一条提示引导模型
 * 按「合并冲突处理协议」逐个解决——理解双方意图、保留双方需要的逻辑、双方都对时问用户，
 * 而不是盲目 checkout --theirs/--ours 丢一侧。
 *
 * 纯追加提示、不改退出码语义（冲突时 git 退出码非 0，但那不是"命令执行失败"，
 * 而是需要人/模型介入解决——interpretExitCode 已把 git 归为非一刀切）。
 */

/** 是否为可能产生合并冲突的 git 命令 */
function isMergeLikeGitCommand(command: string): boolean {
  return /\bgit\s+(merge|rebase|cherry-pick|pull|stash\s+(pop|apply)|revert)\b/.test(command);
}

/**
 * 检测命令输出是否报告了合并冲突，返回引导提示（无冲突返回 null）。
 *
 * @param command 执行的命令
 * @param output 命令合并输出（stdout + stderr）
 */
export function detectMergeConflictHint(command: string, output: string): string | null {
  if (!command || !output) return null;
  if (!isMergeLikeGitCommand(command)) return null;

  // git 冲突的稳定信号：输出含 "CONFLICT"（大小写敏感，git 固定大写输出），
  // 或明确提示 "fix conflicts" / "Unmerged paths" / "needs merge"。
  const hasConflict =
    output.includes("CONFLICT") ||
    /\bUnmerged paths\b/.test(output) ||
    /\bfix conflicts\b/i.test(output) ||
    /\bneeds merge\b/.test(output);
  if (!hasConflict) return null;

  return [
    "⚠️ 检测到合并冲突。按合并冲突处理协议逐个解决：",
    "1. git status 找出所有冲突文件（Unmerged paths）",
    "2. 逐个 read 冲突文件，定位 <<<<<<< / ======= / >>>>>>> 标记",
    "3. 理解双方变更的意图，用 edit 写入正确的合并结果（保留双方都需要的逻辑，不是简单选一边）",
    "4. 双方语义都对、需要取舍时，用 ask_user_question 让用户拍板，不要擅自决定",
    "5. 解决后 git add 冲突文件，按需 git commit / git rebase --continue",
    "放弃可用 git merge --abort / git rebase --abort 回到干净状态。",
  ].join("\n");
}
