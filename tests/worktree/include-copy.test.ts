/**
 * .worktreeinclude 解析与复制单测（P1-4）
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseIncludeFile, applyWorktreeInclude } from "@sid-code/core/worktree/include-copy.ts";

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
}

let repo: string;

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "sid-incl-")));
  git(["init", "-q"], repo);
  git(["config", "user.email", "t@t.com"], repo);
  git(["config", "user.name", "t"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  writeFileSync(join(repo, ".gitignore"), ".env\nsecrets/\n");
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

describe("parseIncludeFile", () => {
  it("解析 pattern，忽略注释和空行", () => {
    writeFileSync(join(repo, ".worktreeinclude"), "# comment\n.env\n\nsecrets/\n");
    const patterns = parseIncludeFile(repo);
    expect(patterns.map((p) => p.normalized).sort()).toEqual([".env", "secrets"]);
  });

  it("无文件返回空数组", () => {
    expect(parseIncludeFile(repo)).toEqual([]);
  });
});

describe("applyWorktreeInclude", () => {
  it("把 gitignored 的 .env 复制到 worktree", () => {
    writeFileSync(join(repo, ".env"), "SECRET=1\n");
    writeFileSync(join(repo, ".worktreeinclude"), ".env\n");

    const wtPath = join(repo, ".sid-code", "worktrees", "feat");
    mkdirSync(join(repo, ".sid-code", "worktrees"), { recursive: true });
    git(["worktree", "add", "-B", "feat", wtPath, "HEAD"], repo);

    // worktree 不应自带 .env（gitignored）
    expect(existsSync(join(wtPath, ".env"))).toBe(false);

    applyWorktreeInclude(repo, wtPath);

    expect(existsSync(join(wtPath, ".env"))).toBe(true);
    expect(readFileSync(join(wtPath, ".env"), "utf-8")).toBe("SECRET=1\n");
  });

  it("复制 gitignored 目录", () => {
    mkdirSync(join(repo, "secrets"));
    writeFileSync(join(repo, "secrets", "key.pem"), "KEY\n");
    writeFileSync(join(repo, ".worktreeinclude"), "secrets/\n");

    const wtPath = join(repo, ".sid-code", "worktrees", "feat2");
    mkdirSync(join(repo, ".sid-code", "worktrees"), { recursive: true });
    git(["worktree", "add", "-B", "feat2", wtPath, "HEAD"], repo);

    applyWorktreeInclude(repo, wtPath);
    expect(existsSync(join(wtPath, "secrets", "key.pem"))).toBe(true);
  });

  it("不覆盖 worktree 已存在的文件", () => {
    writeFileSync(join(repo, ".env"), "SECRET=main\n");
    writeFileSync(join(repo, ".worktreeinclude"), ".env\n");

    const wtPath = join(repo, ".sid-code", "worktrees", "feat3");
    mkdirSync(join(repo, ".sid-code", "worktrees"), { recursive: true });
    git(["worktree", "add", "-B", "feat3", wtPath, "HEAD"], repo);
    writeFileSync(join(wtPath, ".env"), "SECRET=existing\n");

    applyWorktreeInclude(repo, wtPath);
    // 已存在的不被覆盖
    expect(readFileSync(join(wtPath, ".env"), "utf-8")).toBe("SECRET=existing\n");
  });

  it("无 .worktreeinclude 时不复制任何东西", () => {
    writeFileSync(join(repo, ".env"), "SECRET=1\n");
    const wtPath = join(repo, ".sid-code", "worktrees", "feat4");
    mkdirSync(join(repo, ".sid-code", "worktrees"), { recursive: true });
    git(["worktree", "add", "-B", "feat4", wtPath, "HEAD"], repo);
    applyWorktreeInclude(repo, wtPath);
    expect(existsSync(join(wtPath, ".env"))).toBe(false);
  });
});
