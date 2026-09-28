/**
 * W5：findCanonicalGitRoot 不再靠「向上两级」硬算，改读 git 自己的 commondir。
 *
 * 旧实现把 `.git` pointer 指向的 gitdir 向上两级当主仓 .git、再上一级当仓库根。
 * 这个层数只在 `<repo>/.git/worktrees/<name>` 这一种布局下成立；
 * `git init --separate-git-dir=<别处>` 下会把仓库根指到**仓库外面**
 * （实测旧算法返回 /private/tmp，真实根是 .../odd/repo，差三层），
 * 而函数里 `statSync(mainGitDir).isDirectory()` 那道防御拦不住——
 * 它只检查「算出来的路径是不是目录」，任何存在的目录都能通过。
 *
 * 后果（按 findGitRootForAgent 的调用链）：worktree 建到项目外、GC 扫不到、
 * symlink/settings 复制全部相对错误的根取。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { findCanonicalGitRoot } from "@sid-code/core/worktree/canonical.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function initRepo(dir: string, extraInitArgs: string[] = []): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", ...extraInitArgs, "."], {
    cwd: dir,
    stdio: ["pipe", "pipe", "pipe"],
  });
  git(["config", "user.email", "t@t.com"], dir);
  git(["config", "user.name", "t"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], {
    cwd: dir,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

let base: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "sid-canon-sep-")));
});

afterEach(() => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

describe("findCanonicalGitRoot：--separate-git-dir 布局（W5）", () => {
  it("主 checkout 返回它自己，而不是 gitdir 的上两级", () => {
    const repo = join(base, "repo");
    const realgit = join(base, "realgit");
    initRepo(repo, [`--separate-git-dir=${realgit}`]);

    // 判据取自 git 自己的回答，不写死期望字符串
    const truth = git(["rev-parse", "--show-toplevel"], repo);
    expect(findCanonicalGitRoot(repo)).toBe(truth);

    // 反向自证：旧算法在这里会返回 realgit 的上两级 = base 的父目录（仓库外）
    const oldAlgorithmWouldReturn = join(base, "..");
    expect(findCanonicalGitRoot(repo)).not.toBe(realpathSync(oldAlgorithmWouldReturn));
  });

  it("该仓库再开的 worktree 里，宁可返回 null 也不指到仓库外", () => {
    const repo = join(base, "repo");
    const realgit = join(base, "realgit");
    initRepo(repo, [`--separate-git-dir=${realgit}`]);
    const wt = join(base, "wt1");
    git(["worktree", "add", "-q", wt, "-b", "wt1"], repo);

    // git 在任何文件里都没有记录 separate-git-dir 的主 checkout 路径（实测整个
    // git dir grep 零命中），所以这种布局下正确答案是「推不出来」→ null，
    // 让 findGitRootForAgent 回退到 `git rev-parse --show-toplevel`。
    const got = findCanonicalGitRoot(wt);
    expect(got).toBeNull();

    // 关键：绝不能返回一个仓库外的路径（旧算法返回 realgit 的上一级 = base）
    expect(got).not.toBe(base);
  });

  it("推不出主仓根时不继续向上，避免把外层无关仓库当主仓", () => {
    // 外层是一个真仓库，内层放一个 separate-git-dir 仓库的 worktree。
    // 旧实现「算不出就继续向上」会一路撞到外层仓库并把它当主仓返回。
    const outer = join(base, "outer");
    initRepo(outer);

    const inner = join(outer, "inner");
    const innerGit = join(outer, "innerrealgit");
    initRepo(inner, [`--separate-git-dir=${innerGit}`]);
    const wt = join(outer, "inner-wt");
    git(["worktree", "add", "-q", wt, "-b", "iwt"], inner);

    const got = findCanonicalGitRoot(wt);
    expect(got).not.toBe(outer); // 外层仓库不是它的主仓
    expect(got).toBeNull();
  });
});

describe("findCanonicalGitRoot：普通布局不受影响（W5 回归护栏）", () => {
  it("普通仓库的 linked worktree 仍然穿透到主仓根", () => {
    const repo = join(base, "plain");
    initRepo(repo);
    const wtDir = join(repo, ".sid-code", "worktrees");
    mkdirSync(wtDir, { recursive: true });
    const wt = join(wtDir, "feat");
    git(["worktree", "add", "-q", wt, "-b", "feat"], repo);

    expect(findCanonicalGitRoot(wt)).toBe(repo);
    const sub = join(wt, "src", "deep");
    mkdirSync(sub, { recursive: true });
    expect(findCanonicalGitRoot(sub)).toBe(repo);
  });

  it("worktree 不在主仓目录内时也能穿透（commondir 是相对路径）", () => {
    const repo = join(base, "plain2");
    initRepo(repo);
    const wt = join(base, "outside-wt");
    git(["worktree", "add", "-q", wt, "-b", "outside"], repo);

    expect(findCanonicalGitRoot(wt)).toBe(repo);
  });
});
