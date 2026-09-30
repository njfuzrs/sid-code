/**
 * Worktree 隔离 W11–W18 回归测试
 * 来源：docs-research/sid-code/bugfixes/todo/20260926-Worktree隔离-顺着sc-19核出的缺陷.md
 *
 * 判据都取「故障时会变」的信号：链接是否出现在磁盘上、git 的 locked 文件、
 * GC 之后目录还在不在、删除检查报出的 commit 数、权限决策、全局 cwd 的值。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  lstatSync,
  utimesSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  WorktreeManager,
  readWorktreeLockReason,
  unlockWorktree,
  SID_LOCK_REASON_PREFIX,
} from "@sid-code/core/worktree/manager.ts";
import { cleanupStaleWorktrees } from "@sid-code/core/worktree/cleanup.ts";
import { resetSettingsCache } from "@sid-code/core/config/settings/cache.ts";
import { withAgentCwd } from "@sid-code/core/bootstrap/cwd-context.ts";
import { getCwd, setCwd } from "@sid-code/core/bootstrap/state.ts";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import {
  declareFileIntent,
  queryFileIntents,
  clearFileIntent,
  intentKeyForPath,
} from "@sid-code/core/session/file-intent.ts";
import { registerSession, unregisterSession } from "@sid-code/core/session/concurrent.ts";

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

/** 让目录看起来比 GC 宽限期老 */
function ageDir(p: string): void {
  const old = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  utimesSync(p, old, old);
}

/** 一个确定已经退出的 pid */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "0"]);
  return r.pid ?? 999_999;
}

let repo: string;
let outside: string;
let sidHome: string;
let prevSidHome: string | undefined;

beforeEach(() => {
  prevSidHome = process.env.SID_CONFIG_DIR;
  sidHome = realpathSync(mkdtempSync(join(tmpdir(), "sid-w11w18-home-")));
  process.env.SID_CONFIG_DIR = sidHome;
  resetSettingsCache();

  repo = realpathSync(mkdtempSync(join(tmpdir(), "sid-w11w18-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "sid-w11w18-out-")));
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
  for (const d of [repo, outside, sidHome]) {
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

describe("W11 symlinkDirectories 校验路径与源的真实位置", () => {
  it("../ 越界项与指向仓库外的源都不链，正常目录照常链", async () => {
    writeFileSync(join(outside, "key.txt"), "topsecret");
    symlinkSync(outside, join(repo, "alias"), "dir");
    mkdirSync(join(repo, "vendor"));
    writeProjectSettings({
      worktree: { symlinkDirectories: ["../../outside-secret", "alias", "vendor"] },
    });

    const s = await new WorktreeManager(repo).create("agent-1111aaaa");

    // 越界项：worktree 上一级不许冒出链接
    expect(existsSync(join(repo, ".sid-code", "outside-secret"))).toBe(false);
    let danglingOutside = false;
    try {
      lstatSync(join(repo, ".sid-code", "outside-secret"));
      danglingOutside = true;
    } catch {
      /* 不存在，符合预期 */
    }
    expect(danglingOutside).toBe(false);
    // 出站链接：不能从 worktree 读到仓库外的内容
    expect(existsSync(join(s.worktreePath, "alias", "key.txt"))).toBe(false);
    // 正常目录照常
    expect(lstatSync(join(s.worktreePath, "vendor")).isSymbolicLink()).toBe(true);
  });
});

describe("W13 创建时加锁，GC 分得清活锁与陈旧锁", () => {
  it("create 写入 sid-code:pid=<本进程> 的锁，remove 能干净删掉", async () => {
    const m = new WorktreeManager(repo);
    const s = await m.create("agent-2222bbbb");
    expect(readWorktreeLockReason(s.worktreePath)?.trim()).toBe(
      `${SID_LOCK_REASON_PREFIX}${process.pid}`,
    );
    await m.remove(s, false);
    expect(existsSync(s.worktreePath)).toBe(false);
    expect(git(["worktree", "list", "--porcelain"], repo)).not.toContain("agent-2222bbbb");
  });

  it("活进程持有的锁挡住 GC；持有者死掉后 GC 照常回收", async () => {
    const s = await new WorktreeManager(repo).create("agent-3333cccc");
    ageDir(s.worktreePath);

    expect(await cleanupStaleWorktrees(repo, 30)).toBe(0);
    expect(existsSync(s.worktreePath)).toBe(true);

    unlockWorktree(repo, s.worktreePath);
    git(
      ["worktree", "lock", "--reason", `${SID_LOCK_REASON_PREFIX}${deadPid()}`, s.worktreePath],
      repo,
    );
    ageDir(s.worktreePath);
    expect(await cleanupStaleWorktrees(repo, 30)).toBe(1);
    expect(existsSync(s.worktreePath)).toBe(false);
  });

  it("用户手动加的锁（非 sid-code 理由）永远尊重", async () => {
    const s = await new WorktreeManager(repo).create("agent-4444dddd");
    unlockWorktree(repo, s.worktreePath);
    git(["worktree", "lock", "--reason", "human", s.worktreePath], repo);
    ageDir(s.worktreePath);
    expect(await cleanupStaleWorktrees(repo, 30)).toBe(0);
    expect(existsSync(s.worktreePath)).toBe(true);
  });
});

describe("W14 GC 跳过其它活会话正在用的 worktree", () => {
  it("注册表里有活会话站在该 worktree 下时不删，注销后才删", async () => {
    const s = await new WorktreeManager(repo).create("agent-5555eeee");
    unlockWorktree(repo, s.worktreePath); // 去掉 W13 的锁，只留 W14 这一道
    ageDir(s.worktreePath);

    const sessionId = "w14-other-session";
    registerSession({
      sessionId,
      pid: process.pid,
      kind: "interactive",
      cwd: join(s.worktreePath, "sub"),
      startedAt: Date.now(),
    });
    try {
      expect(await cleanupStaleWorktrees(repo, 30)).toBe(0);
      expect(existsSync(s.worktreePath)).toBe(true);
    } finally {
      unregisterSession(sessionId);
    }
    ageDir(s.worktreePath);
    expect(await cleanupStaleWorktrees(repo, 30)).toBe(1);
  });
});

describe("W18 复用已有 worktree 时基线取分叉点，不取当前 HEAD", () => {
  it("同名再 create 一次，已有 commit 仍计入删除检查", async () => {
    const m = new WorktreeManager(repo);
    const first = await m.create("reuse-me");
    commit(first.worktreePath, "b.txt", "work");

    const again = await m.create("reuse-me");
    expect(again.originalHeadCommit).not.toBe(git(["rev-parse", "HEAD"], first.worktreePath));
    expect(m.countChanges(again.worktreePath, again.originalHeadCommit)?.commits).toBe(1);
    let err = "";
    try {
      await m.remove(again, false);
    } catch (e: any) {
      err = String(e?.message ?? e);
    }
    expect(err).toMatch(/1 个未合并 commit/);
    expect(existsSync(again.worktreePath)).toBe(true);
  });

  it("基线为空时不当 0，按「别的 ref 够不到」计数", async () => {
    const m = new WorktreeManager(repo);
    const s = await m.create("empty-baseline");
    commit(s.worktreePath, "c.txt", "work");
    expect(m.countChanges(s.worktreePath, "")?.commits).toBe(1);
  });
});

describe("W16 子代理里的 setCwd 只改它自己的 cwd", () => {
  it("主会话 cwd 不被改，子代理内部读到新值", () => {
    const main = getCwd();
    const inside = withAgentCwd("/tmp/wt-child", () => {
      setCwd("/tmp/wt-child/subdir");
      return getCwd();
    });
    expect(inside).toBe("/tmp/wt-child/subdir");
    expect(getCwd()).toBe(main);
  });
});

describe("W12 隔离 worktree 里的写工具不能写回主仓", () => {
  // 判据是「有没有被 W12 这条硬拒」：其余决策（是否弹确认）取决于权限模式，与本条无关。
  const W12 = "越界写主仓";

  it("写主仓绝对路径硬拒且不给确认；写 worktree 内、主会话写主仓都不触发", async () => {
    const wt = join(repo, ".sid-code", "worktrees", "agent-6666ffff");
    mkdirSync(join(wt, "src"), { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    const checker = new PermissionChecker(defaultConfig(), undefined, repo);

    const decide = (file_path: string) =>
      withAgentCwd(wt, () => checker.check({ toolName: "write", input: { file_path } }));

    const escaped = await decide(join(repo, "src", "login.ts"));
    expect(escaped.allowed).toBe(false);
    expect(escaped.needsConfirmation ?? false).toBe(false);
    expect(escaped.reason ?? "").toContain(W12);

    expect((await decide(join(wt, "src", "login.ts"))).reason ?? "").not.toContain(W12);
    expect((await decide("src/login.ts")).reason ?? "").not.toContain(W12);

    const mainWrite = await checker.check({
      toolName: "write",
      input: { file_path: join(repo, "src", "login.ts") },
    });
    expect(mainWrite.reason ?? "").not.toContain(W12);
  });
});

describe("W15 冲突检测的键折回主仓相对位置", () => {
  it("两个 worktree 里同一相对路径互相可见", () => {
    const a = join(repo, ".sid-code", "worktrees", "agent-aaaa0000", "src", "login.ts");
    const b = join(repo, ".sid-code", "worktrees", "agent-bbbb0000", "src", "login.ts");
    expect(intentKeyForPath(a)).toBe(join(repo, "src", "login.ts"));
    expect(intentKeyForPath(a)).toBe(intentKeyForPath(b));
    // 以点开头的段不当 slug（与 W4 守卫同口径）
    expect(intentKeyForPath("/r/.sid-code/worktrees/.git/hooks/x")).toBe(
      "/r/.sid-code/worktrees/.git/hooks/x",
    );

    declareFileIntent("w15-a", process.pid, repo, a, "edit");
    try {
      const hits = queryFileIntents(b, "w15-b");
      expect(hits.map((h) => h.sessionId)).toContain("w15-a");
    } finally {
      clearFileIntent("w15-a");
    }
  });
});

describe("W17 启动恢复与 /worktree 用主仓根", () => {
  it("两个调用点不再用 findGitRoot(process.cwd())", () => {
    const root = join(import.meta.dir, "..", "..", "..", "..");
    const advanced = readFileSync(join(root, "packages/cli/src/command/advanced.ts"), "utf-8");
    expect(advanced).not.toContain("findGitRoot(process.cwd())");
    expect(advanced).toContain("findGitRootForAgent(process.cwd())");
    const cli = readFileSync(join(root, "packages/cli/src/cli.ts"), "utf-8");
    const restoreBlock = cli.slice(
      cli.indexOf("restoreWorktreeSession, setCurrentWorktreeSession"),
    );
    expect(restoreBlock.slice(0, 600)).toContain("findGitRootForAgent(process.cwd())");
  });
});
