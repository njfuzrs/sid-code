/**
 * hook 安装器「装 shim 而不是副本」的行为测试（X3-11）。
 *
 * ## 治的是什么
 *
 * 旧安装器把 `scripts/git-hooks/<name>.sh` 用 `cp` 复制成 `.git/hooks/<name>`。
 * 从那一刻起两边各走各的：`git pull` 拉到 hook 源文件的改动后，本地执行的仍是旧副本，
 * 且**没有任何提示**。失效形态是静默的 —— 有人给 pre-commit 加了新门禁并合入，
 * 所有已装过 hook 的人和 agent 本地都不跑它，提交照常通过，而门禁看起来「已存在」。
 *
 * 所以这里断言的是**行为**，不是安装器源码里有没有某个字符串：
 * 在 tmpdir 的真 git 仓库里跑一遍安装器，**只改源文件、不重装**，再触发一次真实
 * `git commit`，看它执行的是哪一份内容。
 *
 * 变异自证：把安装器改回 `cp "$src" "$dst"`，第一条用例必红
 * （第二次 commit 仍执行 v1、仍被拦在门外）。
 *
 * ## 其余几条守的是改造时暴露的相邻风险
 *
 * · 只装 git 会按名字调用的 hook：旧循环 `for src in "$SRC_DIR"/*.sh` 会把
 *   `push-scope.sh`（pre-push 的辅助脚本）也装成 `.git/hooks/push-scope`，
 *   那是个永远不会被调用的死文件。
 * · shim 必须保留 stdin：pre-push 的推送区间是从 stdin 读的（X3-02），
 *   转发层加了重定向就会把它吞掉。
 * · core.hooksPath 已设置时必须装到那里（git 的实际生效位置），否则装完等于没装。
 * · worktree 里必须能装上（2026-08-19 的真实事故：`.git` 在 worktree 里是文件）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const INSTALLER = join(ROOT, "scripts/install-git-hooks.sh");

const createdDirs: string[] = [];

afterEach(() => {
  for (const d of createdDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface TestRepo {
  dir: string;
  /** git，失败即抛错（用于夹具搭建）。 */
  git: (...args: string[]) => string;
  /** git，返回 status 与合并输出（用于断言失败场景）。 */
  gitRaw: (...args: string[]) => { status: number; out: string };
  write: (rel: string, body: string) => void;
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    // 环境里可能有全局 excludesFile / hooksPath，会让 tmpdir 仓库行为不可控
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

function makeRepo(): TestRepo {
  const dir = mkdtempSync(join(tmpdir(), "hook-shim-"));
  createdDirs.push(dir);

  const git = (...args: string[]): string => {
    const res = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv() });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${res.stderr}`);
    return (res.stdout ?? "").trim();
  };
  const gitRaw = (...args: string[]): { status: number; out: string } => {
    const res = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv() });
    return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
  };
  const write = (rel: string, body: string): void => {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  };

  git("init", "-q", "-b", "main");
  write("README.md", "base\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return { dir, git, gitRaw, write };
}

/** 在仓库里铺一份 hook 源文件（内容可控，用来观察执行的是哪一版）。 */
function writeHook(repo: TestRepo, name: string, body: string): void {
  repo.write(`scripts/git-hooks/${name}.sh`, body);
}

/** 跑安装器（cwd 为被测仓库）。 */
function runInstaller(cwd: string): { status: number; out: string } {
  const res = spawnSync("sh", [INSTALLER], { cwd, encoding: "utf8", env: gitEnv() });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/** 一个会打印版本并拦截的 pre-commit 源文件。 */
function preCommitV1(): string {
  return "#!/bin/sh\necho '[hook] v1'\nexit 1\n";
}

/** 一个会打印版本并放行的 pre-commit 源文件。 */
function preCommitV2(): string {
  return "#!/bin/sh\necho '[hook] v2'\nexit 0\n";
}

describe("hook 安装器：装 shim 而不是副本（X3-11）", () => {
  test("源文件更新后**不重装**也执行新内容（核心行为）", () => {
    const repo = makeRepo();
    writeHook(repo, "pre-commit", preCommitV1());
    writeHook(repo, "pre-push", "#!/bin/sh\nexit 0\n");
    expect(runInstaller(repo.dir).status).toBe(0);

    repo.write("a.txt", "a\n");
    repo.git("add", "a.txt");
    const blocked = repo.gitRaw("commit", "-m", "c1");
    expect(blocked.status).not.toBe(0); // v1 拦截
    expect(blocked.out).toContain("[hook] v1");

    // 只改源文件，**不重装**：旧实现（cp 快照）在这里仍会执行 v1
    writeHook(repo, "pre-commit", preCommitV2());
    const passed = repo.gitRaw("commit", "-m", "c1");
    expect(passed.out).toContain("[hook] v2");
    expect(passed.status).toBe(0);
  });

  test("安装产物是转发脚本，不含源文件内容", () => {
    const repo = makeRepo();
    writeHook(repo, "pre-commit", preCommitV1());
    writeHook(repo, "pre-push", "#!/bin/sh\nexit 0\n");
    expect(runInstaller(repo.dir).status).toBe(0);

    const shim = readFileSync(join(repo.dir, ".git/hooks/pre-commit"), "utf8");
    expect(shim).toContain("--show-toplevel");
    expect(shim).toContain("scripts/git-hooks/pre-commit.sh");
    expect(shim).not.toContain("[hook] v1"); // 副本会带上源文件内容
  });

  test("源文件不存在（旧分支）→ 打印提示并放行，不阻塞提交", () => {
    const repo = makeRepo();
    writeHook(repo, "pre-commit", preCommitV1());
    writeHook(repo, "pre-push", "#!/bin/sh\nexit 0\n");
    expect(runInstaller(repo.dir).status).toBe(0);

    rmSync(join(repo.dir, "scripts/git-hooks/pre-commit.sh"));
    repo.write("b.txt", "b\n");
    repo.git("add", "b.txt");
    const res = repo.gitRaw("commit", "-m", "c2");
    expect(res.status).toBe(0);
    expect(res.out).toContain("找不到");
  });

  test("只装真 hook：辅助脚本 push-scope.sh 不得被装成 .git/hooks/push-scope", () => {
    const repo = makeRepo();
    writeHook(repo, "pre-commit", preCommitV1());
    writeHook(repo, "pre-push", "#!/bin/sh\nexit 0\n");
    writeHook(repo, "push-scope", "#!/bin/sh\necho helper\n");
    expect(runInstaller(repo.dir).status).toBe(0);

    expect(existsSync(join(repo.dir, ".git/hooks/pre-commit"))).toBe(true);
    expect(existsSync(join(repo.dir, ".git/hooks/pre-push"))).toBe(true);
    expect(existsSync(join(repo.dir, ".git/hooks/push-scope"))).toBe(false);
  });

  test("shim 保留 stdin（pre-push 的推送区间靠它读，X3-02）", () => {
    const repo = makeRepo();
    // 一个把 stdin 原样回显的 pre-push
    writeHook(repo, "pre-push", '#!/bin/sh\nwhile read -r line; do echo "[push] $line"; done\n');
    writeHook(repo, "pre-commit", preCommitV2());
    expect(runInstaller(repo.dir).status).toBe(0);

    const res = spawnSync("sh", [join(repo.dir, ".git/hooks/pre-push")], {
      cwd: repo.dir,
      input: "refs/heads/main abc123 refs/heads/main 000000\n",
      encoding: "utf8",
      env: gitEnv(),
    });
    expect(res.stdout ?? "").toContain("[push] refs/heads/main abc123");
  });

  test("core.hooksPath 已设置 → 装到那里（git 的实际生效位置）", () => {
    const repo = makeRepo();
    writeHook(repo, "pre-commit", preCommitV1());
    writeHook(repo, "pre-push", "#!/bin/sh\nexit 0\n");
    repo.git("config", "core.hooksPath", ".githooks");

    expect(runInstaller(repo.dir).status).toBe(0);
    expect(existsSync(join(repo.dir, ".githooks/pre-commit"))).toBe(true);
    expect(existsSync(join(repo.dir, ".githooks/pre-push"))).toBe(true);
  });

  test("worktree 里能装上（装到主仓 hooks；shim 转发到该 worktree 的源文件）", () => {
    const repo = makeRepo();
    writeHook(repo, "pre-commit", preCommitV1());
    writeHook(repo, "pre-push", "#!/bin/sh\nexit 0\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "加 hook 源文件");

    const wt = `${repo.dir}-wt`;
    createdDirs.push(wt);
    repo.git("worktree", "add", "-q", "-b", "wt-branch", wt);

    const res = runInstaller(wt);
    expect(res.status).toBe(0);
    // hooks 是仓库级共享的：装到主仓 .git/hooks
    expect(existsSync(join(repo.dir, ".git/hooks/pre-commit"))).toBe(true);
    // 而 shim 的 --show-toplevel 解析到 worktree，执行的是该 worktree 的源文件
    expect(readFileSync(join(repo.dir, ".git/hooks/pre-commit"), "utf8")).toContain(
      "--show-toplevel",
    );
  });
});
