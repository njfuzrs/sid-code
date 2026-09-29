/**
 * Worktree 隔离 W6–W10 回归测试
 * 来源：docs-research/sid-code/bugfixes/todo/20260926-Worktree隔离-顺着sc-19核出的缺陷.md
 *
 * 每条断言都在真实临时 git 仓库上跑，判据取「故障时会变」的信号：
 * 主仓 .git/config 的字节、主仓 hooks 目录里的文件、分支指针、被删的分支。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WorktreeManager } from "@sid-code/core/worktree/manager.ts";
import { cleanupStaleWorktrees } from "@sid-code/core/worktree/cleanup.ts";
import { hasWorktreeCreateHook, validateHookWorktreePath } from "@sid-code/core/worktree/hooks.ts";
import { TrustManager } from "@sid-code/core/permission/trust.ts";
import { resetSettingsCache } from "@sid-code/core/config/settings/cache.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function commit(cwd: string, file: string, msg: string): void {
  writeFileSync(join(cwd, file), msg + "\n");
  git(["add", "."], cwd);
  git(["commit", "-q", "-m", msg], cwd);
}

let repo: string;
let sidHome: string;
let prevSidHome: string | undefined;

beforeEach(() => {
  prevSidHome = process.env.SID_CONFIG_DIR;
  sidHome = realpathSync(mkdtempSync(join(tmpdir(), "sid-w6w10-home-")));
  process.env.SID_CONFIG_DIR = sidHome;
  resetSettingsCache();

  repo = realpathSync(mkdtempSync(join(tmpdir(), "sid-w6w10-")));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@t.com"], repo);
  git(["config", "user.name", "t"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  commit(repo, "a.txt", "init");
});

afterEach(() => {
  resetSettingsCache();
  if (prevSidHome === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevSidHome;
  for (const d of [repo, sidHome]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
});

function writeProjectSettings(obj: unknown): void {
  mkdirSync(join(repo, ".sid-code"), { recursive: true });
  writeFileSync(join(repo, ".sid-code", "settings.json"), JSON.stringify(obj));
  resetSettingsCache();
}

describe("W6 创建 worktree 不写主仓 git config", () => {
  it("主仓 .git/config 字节不变，且不出现 core.hooksPath", async () => {
    const before = readFileSync(join(repo, ".git", "config"), "utf-8");
    const mgr = new WorktreeManager(repo);
    const s = await mgr.create("w6-a", { baseRef: "head" });
    expect(readFileSync(join(repo, ".git", "config"), "utf-8")).toBe(before);
    expect(() => git(["config", "--get", "core.hooksPath"], repo)).toThrow();
    await mgr.remove(s, true);
  });

  it("用户已有的 core.hooksPath（husky 形态）不被覆盖", async () => {
    git(["config", "core.hooksPath", ".husky"], repo);
    const mgr = new WorktreeManager(repo);
    const s = await mgr.create("w6-b", { baseRef: "head" });
    expect(git(["config", "--get", "core.hooksPath"], repo)).toBe(".husky");
    await mgr.remove(s, true);
  });
});

describe("W7 commit 归因 hook 不装进主仓共享 hooks 目录", () => {
  it("开启 commitAttribution：主仓 .git/hooks 下不出现 prepare-commit-msg，且给出告警", async () => {
    writeProjectSettings({ worktree: { commitAttribution: true } });
    const mgr = new WorktreeManager(repo);
    const s = await mgr.create("w7-a", { baseRef: "head" });
    expect(existsSync(join(repo, ".git", "hooks", "prepare-commit-msg"))).toBe(false);
    expect((s.setupWarnings ?? []).some((w) => w.includes("commitAttribution"))).toBe(true);

    // 端到端：主仓的下一次 commit 消息里不被追加任何东西
    commit(repo, "b.txt", "main-commit");
    expect(git(["log", "-1", "--format=%B"], repo)).toBe("main-commit");
    await mgr.remove(s, true);
  });
});

describe("W8 GC 按实际检出的分支删除", () => {
  /** 在 GC 目录下建一个 worktree 并把目录 mtime 拨到宽限期之前 */
  function staleWorktree(dir: string, addArgs: string[]): string {
    const p = join(repo, ".sid-code", "worktrees", dir);
    mkdirSync(join(repo, ".sid-code", "worktrees"), { recursive: true });
    git(["worktree", "add", "-q", ...addArgs.slice(0, -1), p, addArgs[addArgs.length - 1]!], repo);
    execFileSync("touch", ["-t", fmtTouch(new Date(Date.now() - 48 * 3600_000)), p]);
    return p;
  }
  function fmtTouch(d: Date): string {
    const z = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}${z(d.getHours())}${z(d.getMinutes())}`;
  }

  it("目录检出的是别的分支时，不强删同名的 worktree-<dir> 分支", async () => {
    // 一条「恰好同名」的无关分支，上面有独有 commit
    git(["branch", "worktree-agent-aaaa1111"], repo);
    git(["switch", "-q", "worktree-agent-aaaa1111"], repo);
    commit(repo, "keep.txt", "keep-me");
    git(["switch", "-q", "main"], repo);
    const keepSha = git(["rev-parse", "worktree-agent-aaaa1111"], repo);

    // 目录叫 agent-aaaa1111，检出的是 feature-login（已合入 main，无独有 commit）
    git(["branch", "feature-login"], repo);
    const p = staleWorktree("agent-aaaa1111", ["feature-login"]);

    const removed = await cleanupStaleWorktrees(repo, 30);
    expect(removed).toBe(1);
    expect(existsSync(p)).toBe(false);
    // 同名无关分支仍在且未被移动
    expect(git(["rev-parse", "worktree-agent-aaaa1111"], repo)).toBe(keepSha);
    // 用户自己的分支也不删（GC 只收我们造的东西）
    expect(git(["branch", "--list", "feature-login"], repo)).toContain("feature-login");
  });

  it("检出的正是 worktree-<dir> 时照常删分支（正向路径没被改坏）", async () => {
    staleWorktree("agent-bbbb2222", ["-b", "worktree-agent-bbbb2222", "HEAD"]);
    expect(await cleanupStaleWorktrees(repo, 30)).toBe(1);
    expect(git(["branch", "--list", "worktree-agent-bbbb2222"], repo)).toBe("");
  });
});

describe("W9 同名分支上有独有 commit 时拒绝 -B 重置", () => {
  it("worktree-<slug> 已有独有提交 → create 抛错，分支指针不动", async () => {
    git(["branch", "worktree-w9-a"], repo);
    git(["switch", "-q", "worktree-w9-a"], repo);
    commit(repo, "secret.txt", "user-work");
    git(["switch", "-q", "main"], repo);
    const sha = git(["rev-parse", "worktree-w9-a"], repo);

    const mgr = new WorktreeManager(repo);
    await expect(mgr.create("w9-a", { baseRef: "head" })).rejects.toThrow(/拒绝重置/);
    expect(git(["rev-parse", "worktree-w9-a"], repo)).toBe(sha);
    expect(existsSync(join(repo, ".sid-code", "worktrees", "w9-a"))).toBe(false);
  });

  it("残留的空分支（无独有提交）照常重建（D4 幂等性保留）", async () => {
    git(["branch", "worktree-w9-b"], repo);
    const mgr = new WorktreeManager(repo);
    const s = await mgr.create("w9-b", { baseRef: "head" });
    expect(existsSync(s.worktreePath)).toBe(true);
    await mgr.remove(s, true);
  });
});

describe("W10 WorktreeCreate hook 的来源信任与输出校验", () => {
  it("项目级 settings.json 的 WorktreeCreate 在未信任时不生效", () => {
    writeProjectSettings({ hooks: { WorktreeCreate: [{ command: "printf /" }] } });
    expect(hasWorktreeCreateHook(repo)).toBe(false);
  });

  it("未信任时 create 走 git worktree，不执行仓库提交的 hook", async () => {
    const marker = join(sidHome, "hook-ran");
    writeProjectSettings({ hooks: { WorktreeCreate: [{ command: `touch ${marker}; printf /` }] } });
    const mgr = new WorktreeManager(repo);
    const s = await mgr.create("w10-a", { baseRef: "head" });
    expect(existsSync(marker)).toBe(false);
    expect(s.hookBased).toBeUndefined();
    expect(s.worktreePath).toBe(join(repo, ".sid-code", "worktrees", "w10-a"));
    await mgr.remove(s, true);
  });

  it("信任后项目级 hook 生效；配置内容改动后信任失效", async () => {
    writeProjectSettings({ hooks: { WorktreeCreate: [{ command: "printf /tmp" }] } });
    await new TrustManager(repo).trust();
    resetSettingsCache();
    expect(hasWorktreeCreateHook(repo)).toBe(true);

    writeProjectSettings({ hooks: { WorktreeCreate: [{ command: "printf /etc" }] } });
    expect(hasWorktreeCreateHook(repo)).toBe(false);
  });

  it("用户级 hook 不受项目信任影响", () => {
    writeFileSync(
      join(sidHome, "settings.json"),
      JSON.stringify({ hooks: { WorktreeCreate: [{ command: "printf /tmp" }] } }),
    );
    resetSettingsCache();
    expect(hasWorktreeCreateHook(repo)).toBe(true);
  });

  it("hook 输出路径校验：相对路径 / 不存在 / 根目录 / 主仓根 一律拒绝", () => {
    expect(() => validateHookWorktreePath("rel/dir", repo)).toThrow(/绝对路径/);
    expect(() => validateHookWorktreePath(join(repo, "nope"), repo)).toThrow(/不是已存在的目录/);
    expect(() => validateHookWorktreePath("/", repo)).toThrow(/根目录/);
    expect(() => validateHookWorktreePath(repo, repo)).toThrow(/主仓根/);
    const ok = join(sidHome, "wt");
    mkdirSync(ok);
    expect(validateHookWorktreePath(ok, repo)).toBe(ok);
  });

  it("端到端：用户级 hook 打印 / 时 create 抛错而不是返回可 chdir 的 session", async () => {
    writeFileSync(
      join(sidHome, "settings.json"),
      JSON.stringify({ hooks: { WorktreeCreate: [{ command: "printf /" }] } }),
    );
    resetSettingsCache();
    const mgr = new WorktreeManager(repo);
    await expect(mgr.create("w10-b")).rejects.toThrow(/根目录/);
  });
});
