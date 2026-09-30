/**
 * Tmux 集成（P2-1）
 *
 * 在独立 tmux pane / window 中运行 worktree 会话，便于并行多个 worktree。
 * iTerm2 下用 -CC control mode（原生 tab 集成）。
 *
 * 全部命令失败均静默降级（tmux 未安装 / 不在 tmux 环境都不应阻断 worktree 流程）。
 */

import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { getLogger } from "../debug/logger.ts";

/** tmux session 名最大长度 */
const MAX_SESSION_NAME = 50;

/**
 * 生成 tmux session 名：sid-<repo>-<branch>，"/" 和 "." 替换为 "_"。
 */
export function generateTmuxSessionName(repoName: string, branch: string): string {
  const safe = (s: string) => s.replace(/[/.]/g, "_").replace(/[^a-zA-Z0-9_-]/g, "");
  return capSessionName(`sid-${safe(repoName)}-${safe(branch)}`);
}

/**
 * W25：把 session 名封顶到 MAX_SESSION_NAME，且**不同的全名永远得到不同的结果**。
 *
 * 旧实现是裸 `slice(0, 50)`：两个只在第 50 位之后不同的 worktree 截出同一个名字，
 * createTmuxSessionForWorktree 见「已存在」就复用 —— 用户 attach 进的是别人的 shell，
 * exit_worktree remove 的 kill-session 还会把另一个 worktree 在用的 session 一起杀掉。
 * 超长时保留可读前缀 + 全名的短哈希；不超长时原样返回（已有 session 名不变，不打断存量）。
 * 同一个全名仍映射到同一个名字，所以「同一 worktree 再次 tmux: true 复用自己的 session」不受影响。
 */
function capSessionName(full: string): string {
  if (full.length <= MAX_SESSION_NAME) return full;
  const hash = createHash("sha256").update(full).digest("hex").slice(0, 8);
  return `${full.slice(0, MAX_SESSION_NAME - hash.length - 1)}-${hash}`;
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

/** session 的起始目录（`#{session_path}`）；读不到返回 null。 */
function tmuxSessionPath(sessionName: string): string | null {
  try {
    return execFileSync("tmux", ["display-message", "-p", "-t", sessionName, "#{session_path}"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
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
    // W25：同名只说明名字撞上了，不说明这是「我这个 worktree」的 session。
    // 起始目录对不上就不复用 —— 复用等于把用户送进别人的 shell。
    const path = tmuxSessionPath(sessionName);
    if (path !== null && path !== worktreePath) {
      log.warn("WORKTREE", `tmux session ${sessionName} 已存在但属于另一个目录（${path}），不复用`);
      return null;
    }
    log.debug("WORKTREE", `tmux session ${sessionName} 已存在，复用`);
    return sessionName;
  }
  try {
    execFileSync("tmux", ["new-session", "-d", "-s", sessionName, "-c", worktreePath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
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

// ============================================================
// P3-2：Agent Teams 的 teammate pane（对齐 CC teammateMode: "tmux"）
//
// 与上面的 worktree session 不同：teammate pane 不是给用户交互用的 shell，
// 而是**实时观察窗**——每个成员一个 pane，`tail -F` 该成员任务的落盘输出。
// 成员本就把输出流式写盘（task/disk-output.ts），所以 tail 就能拿到实时进度，
// 无需把子代理搬进 tmux 进程（那会破坏进程内并发、worktree ALS 隔离等既有机制）。
// ============================================================

/** teammate 观察 session 名：sid-team-<团队名>。 */
export function generateTeamTmuxSessionName(teamName: string): string {
  const safe = teamName.replace(/[/.]/g, "_").replace(/[^a-zA-Z0-9_-]/g, "");
  return capSessionName(`sid-team-${safe}`);
}

/**
 * 为团队创建观察 session（detached）。失败/无 tmux 返回 null（调用方降级 in-process）。
 */
export function createTeamTmuxSession(sessionName: string, cwd: string): string | null {
  const log = getLogger();
  if (!isTmuxAvailable()) {
    log.debug("SWARM", "tmux 不可用，teammateMode=tmux 降级为 in-process");
    return null;
  }
  if (tmuxSessionExists(sessionName)) return sessionName;
  try {
    execFileSync("tmux", ["new-session", "-d", "-s", sessionName, "-c", cwd], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    log.info(
      "SWARM",
      `已创建 teammate 观察 session: ${sessionName}（${isITerm2() ? "iTerm2 可 tmux -CC attach" : "tmux attach -t " + sessionName}）`,
    );
    return sessionName;
  } catch (err: any) {
    log.warn("SWARM", `创建 teammate tmux session 失败（降级 in-process）: ${err.message}`);
    return null;
  }
}

/**
 * 给某成员开一个 pane，实时 tail 其输出文件。
 *
 * 用 `tail -F`（大写 F）：文件尚未创建时会等待并在创建后跟上，
 * 避免成员还没产出первый字节就因文件不存在而 pane 退出。
 * 失败静默返回 false——观察窗是增益，绝不能阻断团队执行。
 */
export function createTeammatePane(
  sessionName: string,
  memberName: string,
  outputFile: string,
): boolean {
  try {
    execFileSync(
      "tmux",
      [
        "new-window",
        "-t",
        sessionName,
        "-n",
        memberName.slice(0, 20),
        // sh -c 里只拼固定命令 + execFileSync 传参（非 shell 拼接用户串），
        // outputFile 由内部生成（taskId 派生），不含用户可控内容。
        "tail",
        "-F",
        outputFile,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    return true;
  } catch (err: any) {
    getLogger().debug("SWARM", `创建 teammate pane 失败 (${memberName}): ${err?.message ?? err}`);
    return false;
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
