/**
 * Tmux 集成（P2-1）
 *
 * 在独立 tmux pane / window 中运行 worktree 会话，便于并行多个 worktree。
 * iTerm2 下用 -CC control mode（原生 tab 集成）。
 *
 * 全部命令失败均静默降级（tmux 未安装 / 不在 tmux 环境都不应阻断 worktree 流程）。
 */

import { execFileSync } from "child_process";
import { getLogger } from "../debug/logger.ts";

/** tmux session 名最大长度 */
const MAX_SESSION_NAME = 50;

/**
 * 生成 tmux session 名：sid-<repo>-<branch>，"/" 和 "." 替换为 "_"。
 */
export function generateTmuxSessionName(repoName: string, branch: string): string {
  const safe = (s: string) => s.replace(/[/.]/g, "_").replace(/[^a-zA-Z0-9_-]/g, "");
  const name = `sid-${safe(repoName)}-${safe(branch)}`;
  return name.slice(0, MAX_SESSION_NAME);
}

/** tmux 是否可用 */
export function isTmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

/** 检测是否在 iTerm2 中（用于 control mode 决策） */
function isITerm2(): boolean {
  return process.env.TERM_PROGRAM === "iTerm.app";
}

/** session 是否已存在 */
export function tmuxSessionExists(sessionName: string): boolean {
  try {
    execFileSync("tmux", ["has-session", "-t", sessionName], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 为 worktree 创建 detached tmux session（cwd 指向 worktree）。
 * 返回实际使用的 session 名；失败返回 null。
 */
export function createTmuxSessionForWorktree(
  worktreePath: string,
  sessionName: string,
): string | null {
  const log = getLogger();
  if (!isTmuxAvailable()) {
    log.debug("WORKTREE", "tmux 不可用，跳过 session 创建");
    return null;
  }
  if (tmuxSessionExists(sessionName)) {
    log.debug("WORKTREE", `tmux session ${sessionName} 已存在，复用`);
    return sessionName;
  }
  try {
    execFileSync(
      "tmux",
      ["new-session", "-d", "-s", sessionName, "-c", worktreePath],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    log.info(
      "WORKTREE",
      `已创建 tmux session: ${sessionName}${isITerm2() ? "（iTerm2，可用 tmux -CC attach 接入）" : ""}`,
    );
    return sessionName;
  } catch (err: any) {
    log.warn("WORKTREE", `创建 tmux session 失败: ${err.message}`);
    return null;
  }
}

/**
 * 杀掉 tmux session。静默忽略 "session not found"。
 */
export function killTmuxSession(sessionName: string): void {
  const log = getLogger();
  try {
    execFileSync("tmux", ["kill-session", "-t", sessionName], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    log.info("WORKTREE", `已杀掉 tmux session: ${sessionName}`);
  } catch {
    // session 不存在或 tmux 不可用，静默忽略
  }
}
