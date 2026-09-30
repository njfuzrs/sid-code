/**
 * Worktree 隔离 W19–W27 回归测试
 * 来源：docs-research/sid-code/bugfixes/todo/20260926-Worktree隔离-顺着sc-19核出的缺陷.md
 *
 * 判据都取「故障时会变」的信号：规则来源里读到的是哪个目录的文件、GC 之后目录还在不在、
 * 删除检查报出的 commit 数、复制结果、session 名是否相同、remove 是否诚实地失败。
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
  utimesSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  WorktreeManager,
  unlockWorktree,
  SID_LOCK_REASON_PREFIX,
} from "@sid-code/core/worktree/manager.ts";
import { cleanupStaleWorktrees, lastActivityMs } from "@sid-code/core/worktree/cleanup.ts";
import {
  applyWorktreeInclude,
  parseIncludeFile,
  matchesPatterns,
} from "@sid-code/core/worktree/include-copy.ts";
import {
  generateTmuxSessionName,
  generateTeamTmuxSessionName,
} from "@sid-code/core/worktree/tmux.ts";
import { onWorkspaceChange, notifyWorkspaceChange } from "@sid-code/core/worktree/canonical.ts";
import { resetSettingsCache } from "@sid-code/core/config/settings/cache.ts";
import { RuleLoader } from "@sid-code/core/permission/rule-loader.ts";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import { SubAgentRunner } from "@sid-code/core/workflow/sub-agent-runner.ts";

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

function writeLocalRules(dir: string, allow: string[]): void {
  mkdirSync(join(dir, ".sid-code"), { recursive: true });
  writeFileSync(
    join(dir, ".sid-code", "settings.local.json"),
    JSON.stringify({ permissions: { allow } }),
  );
}

function localRules(loader: RuleLoader): string[] {
  return loader
    .getAllRules()
    .filter((r) => r.source === "localSettings")
    .map((r) => r.rawRule);
}

let repo: string;
let sidHome: string;
let prevSidHome: string | undefined;
let prevCwd: string;

beforeEach(() => {
  prevCwd = process.cwd();
  prevSidHome = process.env.SID_CONFIG_DIR;
  sidHome = realpathSync(mkdtempSync(join(tmpdir(), "sid-w19w27-home-")));
  process.env.SID_CONFIG_DIR = sidHome;
  resetSettingsCache();

  repo = realpathSync(mkdtempSync(join(tmpdir(), "sid-w19w27-")));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@t.com"], repo);
  git(["config", "user.name", "t"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  commit(repo, "a.txt", "init");
});

afterEach(() => {
  process.chdir(prevCwd);
  if (prevSidHome === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevSidHome;
  resetSettingsCache();
  for (const d of [repo, sidHome]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
});

describe("W19 pr-batch 把白名单同时写进 sid-code 读的 .sid-code/", () => {
  const script = readFileSync(join(import.meta.dir, "../../../../scripts/pr-batch.sh"), "utf-8");

  it("prepare 与 reperm 两处都写 .sid-code/settings.local.json", () => {
    const writes = script.match(/tee "\$wt\/\.sid-code\/settings\.local\.json"/g) ?? [];
    expect(writes.length).toBe(2);
  });

  it("sid-code 的加载器读的正是这个路径", async () => {
    writeLocalRules(repo, ["Bash(bun test)"]);
    const loader = new RuleLoader(repo);
    await loader.loadAll();
    expect(localRules(loader)).toContain("Bash(bun test)");
  });
});

describe("W22 进入 worktree 后权限规则按 worktree 目录重载", () => {
  it("不给目录的 RuleLoader 在 loadAll 时跟随当前 cwd", async () => {
    const wt = realpathSync(mkdtempSync(join(tmpdir(), "sid-w22-wt-")));
    try {
      writeLocalRules(repo, ["Bash(main-only)"]);
      writeLocalRules(wt, ["Bash(wt-only)"]);
      process.chdir(repo);
      const loader = new RuleLoader();
      process.chdir(wt); // 构造之后才切进去（cli.ts 的真实顺序）
      await loader.loadAll();
      expect(localRules(loader)).toEqual(["Bash(wt-only)"]);
    } finally {
      process.chdir(prevCwd);
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it("checker.reloadWorkspaceRules 换掉 local 来源，保留会话规则", async () => {
    const wt = realpathSync(mkdtempSync(join(tmpdir(), "sid-w22-wt-")));
    try {
      writeLocalRules(repo, ["Bash(main-only)"]);
      writeLocalRules(wt, ["Bash(wt-only)"]);
      const checker = new PermissionChecker(defaultConfig(), undefined, repo);
      await checker.getRuleLoader().loadAll();
      checker.getRuleLoader().addSessionRule("allow", "Bash(session-rule)");
      await checker.reloadWorkspaceRules(wt);
      const loader = checker.getRuleLoader();
      expect(localRules(loader)).toEqual(["Bash(wt-only)"]);
      expect(loader.getAllRules().some((r) => r.rawRule === "Bash(session-rule)")).toBe(true);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it("deriveForWorkspace 不改主 checker 的规则", async () => {
    const wt = realpathSync(mkdtempSync(join(tmpdir(), "sid-w22-wt-")));
    try {
      writeLocalRules(repo, ["Bash(main-only)"]);
      writeLocalRules(wt, ["Bash(wt-only)"]);
      const main = new PermissionChecker(defaultConfig(), undefined, repo);
      await main.getRuleLoader().loadAll();
      const derived = await main.deriveForWorkspace(wt);
      expect(localRules(derived.getRuleLoader())).toEqual(["Bash(wt-only)"]);
      expect(localRules(main.getRuleLoader())).toEqual(["Bash(main-only)"]);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it("工作区切换通知送达登记方，注销后不再送达", async () => {
    const seen: string[] = [];
    const off = onWorkspaceChange((d) => {
      seen.push(d);
    });
    await notifyWorkspaceChange("/x");
    off();
    await notifyWorkspaceChange("/y");
    expect(seen).toEqual(["/x"]);
  });
});

describe("W20 swarm 成员的创建期告警有出口", () => {
  it("team.ts 读取 setupWarnings 并挂到成员结果上", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/swarm/team.ts"), "utf-8");
    expect(src).toContain("worktreeSession.setupWarnings");
    expect(src).toContain("result.setupWarnings");
  });
});

describe("W21 workflow 的 worktree 建不起来就失败，不降级到主仓", () => {
  it("非 git 目录下 isolation=worktree 抛错，子代理不被执行", async () => {
    const notGit = realpathSync(mkdtempSync(join(tmpdir(), "sid-w21-")));
    try {
      process.chdir(notGit);
      const { setCwd } = await import("@sid-code/core/bootstrap/state.ts");
      setCwd(notGit);
      const runner = new SubAgentRunner({
        providerRegistry: {} as any,
        toolRegistry: {} as any,
        runId: "r1",
      });
      const ctx = { callIndex: 0, label: "t", signal: new AbortController().signal } as any;
      await expect(runner.run("p", { isolation: "worktree" } as any, ctx)).rejects.toThrow(
        /isolation=worktree/,
      );
      setCwd(prevCwd);
    } finally {
      process.chdir(prevCwd);
      rmSync(notGit, { recursive: true, force: true });
    }
  });
});

describe("W23 GC 年龄取最近一次活动，不只看目录 mtime", () => {
  it("只改已有文件内容时，lastActivityMs 仍然前移", async () => {
    const m = new WorktreeManager(repo);
    const s = await m.create("agent-23232323");
    const old = new Date(Date.now() - 7 * 24 * 3600_000);
    utimesSync(s.worktreePath, old, old);
    writeFileSync(join(s.worktreePath, "a.txt"), "edited\n"); // 改已有文件：目录 mtime 不动
    utimesSync(s.worktreePath, old, old);
    expect(lastActivityMs(s.worktreePath)).toBeGreaterThan(Date.now() - 60_000);
    await m.remove(s, true);
  });

  it("刚 commit 过的活 worktree 不被 GC 删（锁持有者已死、工作区干净）", async () => {
    // 让 worktree 的 commit 对别的 ref 可达：模拟「已推过」，countChanges 拦不住
    const m = new WorktreeManager(repo);
    const s = await m.create("agent-23232324");
    commit(s.worktreePath, "b.txt", "wt-commit");
    git(["branch", "backup", "HEAD"], s.worktreePath);
    unlockWorktree(repo, s.worktreePath);
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid ?? 999_999;
    git(["worktree", "lock", "--reason", `${SID_LOCK_REASON_PREFIX}${dead}`, s.worktreePath], repo);
    const old = new Date(Date.now() - 7 * 24 * 3600_000);
    utimesSync(s.worktreePath, old, old); // 旧判据下这一步就足以让它过期

    const n = await cleanupStaleWorktrees(repo, 30);
    expect(n).toBe(0);
    expect(existsSync(s.worktreePath)).toBe(true);
    await m.remove(s, true);
  });
});

describe("W24 .worktreeinclude 按 gitignore 语法匹配", () => {
  function wt(name: string): string {
    const p = join(repo, ".sid-code", "worktrees", name);
    mkdirSync(join(repo, ".sid-code", "worktrees"), { recursive: true });
    git(["worktree", "add", "-q", "-B", name, p, "HEAD"], repo);
    return p;
  }

  it("* 通配与 ! 取反都生效", () => {
    writeFileSync(join(repo, ".gitignore"), "*.pem\n.sid-code/\n");
    git(["add", ".gitignore"], repo);
    git(["commit", "-q", "-m", "ignore"], repo);
    mkdirSync(join(repo, "sub"));
    writeFileSync(join(repo, "root.pem"), "r");
    writeFileSync(join(repo, "sub", "a.pem"), "a");
    writeFileSync(join(repo, "sub", "b.pem"), "b");
    writeFileSync(join(repo, ".worktreeinclude"), "*.pem\n!sub/a.pem\n");

    const p = wt("incl1");
    applyWorktreeInclude(repo, p);
    expect(existsSync(join(p, "root.pem"))).toBe(true);
    expect(existsSync(join(p, "sub", "b.pem"))).toBe(true);
    expect(existsSync(join(p, "sub", "a.pem"))).toBe(false);
  });

  it("目录被整体忽略时，锚定 glob 只挑出匹配的文件", () => {
    writeFileSync(join(repo, ".gitignore"), "config/\n.sid-code/\n");
    git(["add", ".gitignore"], repo);
    git(["commit", "-q", "-m", "ignore"], repo);
    mkdirSync(join(repo, "config"));
    writeFileSync(join(repo, "config", "db.env"), "d");
    writeFileSync(join(repo, "config", "big.bin"), "x");
    writeFileSync(join(repo, ".worktreeinclude"), "config/*.env\n");

    const p = wt("incl2");
    applyWorktreeInclude(repo, p);
    expect(existsSync(join(p, "config", "db.env"))).toBe(true);
    expect(existsSync(join(p, "config", "big.bin"))).toBe(false);
  });

  it("匹配器语义：最后命中者胜、目录限定只对目录生效", () => {
    writeFileSync(join(repo, ".worktreeinclude"), "secrets/\n!secrets/x.key\nlogs/\n");
    const ps = parseIncludeFile(repo);
    expect(matchesPatterns("secrets/y.key", false, ps)).toBe(true);
    expect(matchesPatterns("secrets/x.key", false, ps)).toBe(false);
    expect(matchesPatterns("logs", false, ps)).toBe(false); // 同名文件不算目录
    expect(matchesPatterns("logs", true, ps)).toBe(true);
  });
});

describe("W25 tmux session 名超长时不再碰撞", () => {
  it("只在末位不同的两个长名得到不同的 session 名，且都不超过 50", () => {
    const a = generateTmuxSessionName("sid-code", "worktree-" + "a".repeat(60) + "1");
    const b = generateTmuxSessionName("sid-code", "worktree-" + "a".repeat(60) + "2");
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(50);
    expect(b.length).toBeLessThanOrEqual(50);
  });

  it("同一全名稳定映射（自己的 session 还能复用），短名不变", () => {
    const n = "worktree-" + "z".repeat(60);
    expect(generateTmuxSessionName("r", n)).toBe(generateTmuxSessionName("r", n));
    expect(generateTmuxSessionName("r", "feat")).toBe("sid-r-feat");
  });

  it("团队名同样不碰撞", () => {
    expect(generateTeamTmuxSessionName("x".repeat(80) + "1")).not.toBe(
      generateTeamTmuxSessionName("x".repeat(80) + "2"),
    );
  });
});

describe("W26 fresh 基线取 worktree 实际切出的 commit", () => {
  it("主仓本地落后于 origin 时，什么都没做的 worktree 删除检查报 0 个 commit", async () => {
    const origin = realpathSync(mkdtempSync(join(tmpdir(), "sid-w26-origin-")));
    try {
      git(["init", "-q", "--bare", "-b", "main"], origin);
      git(["remote", "add", "origin", origin], repo);
      commit(repo, "b.txt", "ahead");
      git(["push", "-q", "origin", "main"], repo);
      git(["fetch", "-q", "origin"], repo);
      git(["remote", "set-head", "origin", "main"], repo);
      git(["reset", "-q", "--hard", "HEAD~1"], repo); // 本地落后 origin 一个 commit

      const m = new WorktreeManager(repo);
      const s = await m.create("fresh-base");
      expect(s.originalHeadCommit).toBe(git(["rev-parse", "origin/main"], repo));
      const changes = m.countChanges(s.worktreePath, s.originalHeadCommit);
      expect(changes).toEqual({ changedFiles: 0, commits: 0 });
      await m.remove(s, false); // 不再被「凭空的未合并 commit」挡住
      expect(existsSync(s.worktreePath)).toBe(false);
    } finally {
      rmSync(origin, { recursive: true, force: true });
    }
  });
});

describe("W27 hook 建的 worktree 没配 WorktreeRemove 时删除诚实失败", () => {
  it("remove 抛错且目录仍在", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "sid-w27-")));
    try {
      const m = new WorktreeManager(repo);
      await expect(
        m.remove(
          {
            originalCwd: repo,
            worktreePath: dir,
            worktreeName: "hooked",
            sessionId: "",
            worktreeBranch: "",
            originalHeadCommit: "",
            hookBased: true,
          },
          true,
        ),
      ).rejects.toThrow(/WorktreeRemove/);
      expect(existsSync(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
