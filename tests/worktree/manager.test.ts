/**
 * Spec 18 §3：Worktree 隔离系统单测
 * 在临时 git 仓库中验证 create/countChanges(fail-closed)/remove。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  WorktreeManager,
  findGitRoot,
} from "../../src/worktree/manager.ts";
import { isEphemeralWorktree } from "../../src/worktree/cleanup.ts";

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
}

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "sid-wt-"));
  git(["init", "-q"], repo);
  git(["config", "user.email", "t@t.com"], repo);
  git(["config", "user.name", "t"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  writeFileSync(join(repo, "a.txt"), "hello\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "init"], repo);
});

afterEach(() => {
  try {
    rmSync(repo, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

describe("findGitRoot", () => {
  it("在 git 仓库内返回根", () => {
    const root = findGitRoot(repo);
    expect(root).not.toBeNull();
    // macOS /tmp 是 /private/tmp 的符号链接，比对 basename 即可
    expect(root!.endsWith(repo.split("/").pop()!)).toBe(true);
  });

  it("非 git 目录返回 null", () => {
    const nonGit = mkdtempSync(join(tmpdir(), "sid-nogit-"));
    expect(findGitRoot(nonGit)).toBeNull();
    rmSync(nonGit, { recursive: true, force: true });
  });
});

describe("WorktreeManager", () => {
  it("create 生成隔离工作区，共享 .git", async () => {
    const mgr = new WorktreeManager(repo);
    const session = await mgr.create("brave-eagle-7");
    expect(existsSync(session.worktreePath)).toBe(true);
    expect(existsSync(join(session.worktreePath, "a.txt"))).toBe(true);
    expect(session.worktreeBranch).toBe("worktree-brave-eagle-7");
    await mgr.remove(session, true);
  });

  it("countChanges 干净时返回 0/0", async () => {
    const mgr = new WorktreeManager(repo);
    const session = await mgr.create("calm-fox-1");
    const changes = mgr.countChanges(session.worktreePath, session.originalHeadCommit);
    expect(changes).not.toBeNull();
    expect(changes!.changedFiles).toBe(0);
    expect(changes!.commits).toBe(0);
    await mgr.remove(session, true);
  });

  it("countChanges 检测未提交文件", async () => {
    const mgr = new WorktreeManager(repo);
    const session = await mgr.create("keen-wolf-2");
    writeFileSync(join(session.worktreePath, "b.txt"), "new\n");
    const changes = mgr.countChanges(session.worktreePath, session.originalHeadCommit);
    expect(changes!.changedFiles).toBeGreaterThan(0);
    await mgr.remove(session, true);
  });

  it("countChanges 在非 git 路径 fail-closed 返回 null", () => {
    const mgr = new WorktreeManager(repo);
    const nonGit = mkdtempSync(join(tmpdir(), "sid-nogit-"));
    const changes = mgr.countChanges(nonGit, "");
    expect(changes).toBeNull();
    rmSync(nonGit, { recursive: true, force: true });
  });

  it("remove 拒绝删除有未提交工作的 worktree（非 force）", async () => {
    const mgr = new WorktreeManager(repo);
    const session = await mgr.create("noble-bear-3");
    writeFileSync(join(session.worktreePath, "dirty.txt"), "x\n");
    await expect(mgr.remove(session, false)).rejects.toThrow();
    // force 删除成功
    await mgr.remove(session, true);
    expect(existsSync(session.worktreePath)).toBe(false);
  });

  it("create 幂等：worktree 已存在时复用", async () => {
    const mgr = new WorktreeManager(repo);
    const s1 = await mgr.create("wise-otter-4");
    const s2 = await mgr.create("wise-otter-4");
    expect(s2.worktreePath).toBe(s1.worktreePath);
    await mgr.remove(s1, true);
  });
});

describe("isEphemeralWorktree", () => {
  it("识别临时命名", () => {
    expect(isEphemeralWorktree("agent-a1b2c3d4")).toBe(true);
    expect(isEphemeralWorktree("swarm-frontend")).toBe(true);
    expect(isEphemeralWorktree("brave-eagle-42")).toBe(false); // 用户命名
  });
});
