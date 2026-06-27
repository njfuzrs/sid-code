/**
 * WorktreeManager 集成新特性单测：slug 校验、扁平化目录、detached HEAD、fast countChanges
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WorktreeManager } from "../../src/worktree/manager.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

let repo: string;

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "sid-mgr2-")));
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

describe("WorktreeManager.create 校验与扁平化", () => {
  it("拒绝非法 slug（路径穿越）", async () => {
    const mgr = new WorktreeManager(repo);
    await expect(mgr.create("../escape")).rejects.toThrow();
  });

  it("扁平化 user/feature → user+feature 目录", async () => {
    const mgr = new WorktreeManager(repo);
    const session = await mgr.create("user/feature");
    expect(session.worktreeName).toBe("user+feature");
    expect(session.worktreeBranch).toBe("worktree-user+feature");
    expect(existsSync(session.worktreePath)).toBe(true);
    expect(session.worktreePath.endsWith("user+feature")).toBe(true);
    await mgr.remove(session, true);
  });

  it("已存在 worktree 时快速复用（不重复创建）", async () => {
    const mgr = new WorktreeManager(repo);
    const s1 = await mgr.create("reuse-me-1");
    const s2 = await mgr.create("reuse-me-1");
    expect(s2.worktreePath).toBe(s1.worktreePath);
    await mgr.remove(s1, true);
  });
});

describe("WorktreeManager.countChanges fast 模式", () => {
  it("干净 worktree 返回 0 变更", async () => {
    const mgr = new WorktreeManager(repo);
    const session = await mgr.create("clean-1");
    const changes = mgr.countChanges(session.worktreePath, session.originalHeadCommit, { fast: true });
    expect(changes).not.toBeNull();
    expect(changes!.changedFiles).toBe(0);
    await mgr.remove(session, true);
  });

  it("有未提交修改时检测到变更", async () => {
    const mgr = new WorktreeManager(repo);
    const session = await mgr.create("dirty-1");
    writeFileSync(join(session.worktreePath, "new.txt"), "x\n");
    git(["add", "."], session.worktreePath);
    const changes = mgr.countChanges(session.worktreePath, session.originalHeadCommit, { fast: true });
    expect(changes!.changedFiles).toBeGreaterThan(0);
    await mgr.remove(session, true);
  });
});

describe("WorktreeManager.remove fail-closed", () => {
  it("有未提交修改时拒绝删除（非 force）", async () => {
    const mgr = new WorktreeManager(repo);
    const session = await mgr.create("protect-1");
    writeFileSync(join(session.worktreePath, "wip.txt"), "wip\n");
    git(["add", "."], session.worktreePath);
    await expect(mgr.remove(session, false)).rejects.toThrow();
    // force 才能删
    await mgr.remove(session, true);
    expect(existsSync(session.worktreePath)).toBe(false);
  });
});
