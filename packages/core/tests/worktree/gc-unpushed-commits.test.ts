/**
 * W3：GC 的「有工作」判据不再在无 remote 的仓库里恒为真。
 *
 * 旧口径 `rev-list --count HEAD --not --remotes` 在**没有任何 remote** 的仓库里
 * 退出码 0，但 `--remotes` 展开为空 → 输出等于 HEAD 的**全部** commit 数。
 * 于是「刚从主仓 HEAD 切出、一个新 commit 都没产生的干净 worktree」也被判成
 * 「有未推送 commit」，cleanup.ts 看到 commits > 0 就 continue —— GC 在这类仓库上
 * **结构性零触发**：6 小时宽限、锁检查、白名单全都走不到删除那一步。
 * 而无 remote 是正常的仓库形态（本地实验仓、还没加 origin 的新仓），不是检测失败。
 *
 * 这些用例直接走 countChanges(fast:true)（GC 的真实入口，cleanup.ts:170 的调用口径），
 * 不复刻 git 命令——复刻只能证明"我写的命令按我想的跑"，证不到生产路径。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WorktreeManager } from "@sid-code/core/worktree/manager.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function commit(dir: string, file: string, body: string): void {
  writeFileSync(join(dir, file), body);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", `add ${file}`], dir);
}

let base: string;
let repo: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "sid-gc-unpushed-")));
  repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  git(["init", "-q", "."], repo);
  git(["config", "user.email", "t@t.com"], repo);
  git(["config", "user.name", "t"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  commit(repo, "a.txt", "a\n");
  commit(repo, "b.txt", "b\n");
});

afterEach(() => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

function addWorktree(name: string, extraArgs: string[] = []): string {
  const wtRoot = join(repo, ".sid-code", "worktrees");
  mkdirSync(wtRoot, { recursive: true });
  const wt = join(wtRoot, name);
  git(["worktree", "add", "-q", ...extraArgs, wt, ...(extraArgs.length ? [] : ["-b", name])], repo);
  return wt;
}

describe("countChanges(fast) 在无 remote 的仓库里（W3）", () => {
  it("刚切出的干净 worktree：commits=0，GC 可以删", () => {
    const wt = addWorktree("agent-deadbeef");
    expect(git(["remote"], repo)).toBe(""); // 前提：确无 remote

    const changes = new WorktreeManager(repo).countChanges(wt, "", { fast: true });
    expect(changes).not.toBeNull();
    expect(changes!.changedFiles).toBe(0);
    // 旧口径在这里返回 2（仓库的全部 commit 数），于是永不删 —— 这就是 W3。
    expect(changes!.commits).toBe(0);
  });

  it("worktree 里产生了自己的 commit：commits>=1，GC 必须保护", () => {
    const wt = addWorktree("agent-cafebabe");
    commit(wt, "work.txt", "real work\n");

    const changes = new WorktreeManager(repo).countChanges(wt, "", { fast: true });
    expect(changes!.commits).toBeGreaterThanOrEqual(1);
  });

  it("未提交的新文件仍照常算改动（fail-closed 底线不动）", () => {
    const wt = addWorktree("agent-12345678");
    writeFileSync(join(wt, "untracked.txt"), "not added yet\n");

    const changes = new WorktreeManager(repo).countChanges(wt, "", { fast: true });
    expect(changes!.changedFiles).toBeGreaterThanOrEqual(1);
  });

  it("detached HEAD 且有独有 commit：仍然保护", () => {
    const wtRoot = join(repo, ".sid-code", "worktrees");
    mkdirSync(wtRoot, { recursive: true });
    const wt = join(wtRoot, "agent-abcdef01");
    git(["worktree", "add", "-q", "--detach", wt, "HEAD"], repo);
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], wt)).toBe("HEAD"); // 确认 detached
    commit(wt, "detached-work.txt", "work\n");

    const changes = new WorktreeManager(repo).countChanges(wt, "", { fast: true });
    expect(changes!.commits).toBeGreaterThanOrEqual(1);
  });

  it("detached HEAD 且干净：可以删", () => {
    const wtRoot = join(repo, ".sid-code", "worktrees");
    mkdirSync(wtRoot, { recursive: true });
    const wt = join(wtRoot, "agent-0badf00d");
    git(["worktree", "add", "-q", "--detach", wt, "HEAD"], repo);

    const changes = new WorktreeManager(repo).countChanges(wt, "", { fast: true });
    expect(changes!.commits).toBe(0);
  });
});

describe("countChanges(fast) 在有 remote 的仓库里（W3 不回退）", () => {
  it("commit 已在 remote-tracking ref 里：可以删", () => {
    const bare = join(base, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", bare], { stdio: ["pipe", "pipe", "pipe"] });
    git(["remote", "add", "origin", bare], repo);
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], repo);
    git(["push", "-q", "origin", branch], repo);

    const wt = addWorktree("agent-feedface");
    const changes = new WorktreeManager(repo).countChanges(wt, "", { fast: true });
    expect(changes!.commits).toBe(0);
  });

  it("worktree 的 commit 尚未推送：保护", () => {
    const bare = join(base, "origin2.git");
    execFileSync("git", ["init", "-q", "--bare", bare], { stdio: ["pipe", "pipe", "pipe"] });
    git(["remote", "add", "origin", bare], repo);
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], repo);
    git(["push", "-q", "origin", branch], repo);

    const wt = addWorktree("agent-99887766");
    commit(wt, "unpushed.txt", "not pushed\n");

    const changes = new WorktreeManager(repo).countChanges(wt, "", { fast: true });
    expect(changes!.commits).toBeGreaterThanOrEqual(1);
  });
});

describe("countChanges 的 fail-closed 出口不变", () => {
  it("worktree 路径不是 git 工作区 → 返回 null（调用方视为不安全）", () => {
    const notGit = join(base, "plain-dir");
    mkdirSync(notGit, { recursive: true });
    expect(new WorktreeManager(repo).countChanges(notGit, "", { fast: true })).toBeNull();
  });

  it("非 fast 模式仍按 originalHeadCommit..HEAD 计数", () => {
    const wt = addWorktree("agent-55443322");
    const baseHead = git(["rev-parse", "HEAD"], wt);
    commit(wt, "two.txt", "2\n");

    const changes = new WorktreeManager(repo).countChanges(wt, baseHead);
    expect(changes!.commits).toBe(1);
  });
});
