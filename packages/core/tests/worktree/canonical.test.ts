/**
 * findCanonicalGitRoot 防嵌套单测（P0-2 / B1）
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { realpathSync } from "fs";
import { findCanonicalGitRoot } from "@sid-code/core/worktree/canonical.ts";

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
}

let repo: string;

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "sid-canon-")));
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

describe("findCanonicalGitRoot", () => {
  it("主仓目录返回自身", () => {
    expect(findCanonicalGitRoot(repo)).toBe(repo);
  });

  it("主仓子目录返回主仓根", () => {
    const sub = join(repo, "src", "deep");
    mkdirSync(sub, { recursive: true });
    expect(findCanonicalGitRoot(sub)).toBe(repo);
  });

  it("从 worktree 内部穿透 pointer 返回主仓根（防嵌套核心）", () => {
    const wtDir = join(repo, ".sid-code", "worktrees");
    mkdirSync(wtDir, { recursive: true });
    const wtPath = join(wtDir, "feat");
    git(["worktree", "add", "-B", "feat", wtPath, "HEAD"], repo);

    // 关键：从 worktree 内部调用，必须回到主仓根而非 worktree
    expect(findCanonicalGitRoot(wtPath)).toBe(repo);

    // worktree 内的子目录同样回到主仓根
    const wtSub = join(wtPath, "src");
    mkdirSync(wtSub, { recursive: true });
    expect(findCanonicalGitRoot(wtSub)).toBe(repo);
  });

  it("非 git 目录返回 null", () => {
    const nonGit = realpathSync(mkdtempSync(join(tmpdir(), "sid-nogit-")));
    expect(findCanonicalGitRoot(nonGit)).toBeNull();
    rmSync(nonGit, { recursive: true, force: true });
  });
});
