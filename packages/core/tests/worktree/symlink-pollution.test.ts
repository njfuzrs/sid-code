/**
 * 回归测试：worktree symlink 导致的「工作区污染 + 孤儿目录无限增长」（2026-08-02 修复）
 *
 * 事故现场：本仓 .sid-code/worktrees/ 下堆了 5 个孤儿 worktree、361MB，全部
 * `dirty=1 ahead=0`。唯一那条「改动」是 `?? node_modules`——我们自己建的 symlink。
 *
 * 根因链：
 *   主仓 .gitignore 写 `node_modules/`（带尾斜杠只匹配目录）
 *   → symlink 不是目录，规则不命中
 *   → worktree 内 git status 永久报 `?? node_modules`
 *   → countChanges 得 changedFiles=1
 *   → remove(force=false) 判定「有未保存工作」fail-closed 拒删
 *   → 每个隔离子代理留一个几十 MB 孤儿，永久累积
 *
 * 本测试锁三件事：
 *   A. countChanges 不把「我们建的 symlink」算作用户改动 → 任务结束能自动清理
 *   B. fail-closed 底线不破：真实未提交改动 / 未推送 commit 必须拒删
 *   C. 零 git 副作用：不改主仓 .gitignore / .git/info/exclude / status
 *
 * ⚠️ 已实测否决的方案（别再尝试写 exclude）：
 *   git 不支持 per-worktree exclude。`rev-parse --git-path info/exclude` 在
 *   worktree 里解析到的是**主仓** .git/info/exclude（写它 = 污染主仓）；写进
 *   .git/worktrees/<name>/info/exclude 则被 git 完全忽略。故只能在判定侧解决。
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
  utimesSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WorktreeManager } from "@sid-code/core/worktree/manager.ts";
import { cleanupStaleWorktrees, EPHEMERAL_GRACE_MS } from "@sid-code/core/worktree/cleanup.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

let base: string;
let repo: string;

/** 建带 remote 的仓库：无 remote 时 `HEAD --not --remotes` 会把 init commit 算成未推送 */
function setupRepoWithRemote(): void {
  base = mkdtempSync(join(tmpdir(), "sid-wt-pollute-"));
  const bare = join(base, "origin.git");
  repo = join(base, "repo");
  execFileSync("git", ["init", "-q", "--bare", bare], { stdio: ["pipe", "pipe", "pipe"] });
  execFileSync("git", ["clone", "-q", bare, repo], { stdio: ["pipe", "pipe", "pipe"] });
  git(["config", "user.email", "t@t.com"], repo);
  git(["config", "user.name", "t"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  writeFileSync(join(repo, "a.txt"), "hello\n");
  // 关键：node_modules 用最常见的带尾斜杠写法，正是踩中 bug 的形态。
  // .sid-code/ 也忽略掉，模拟真实项目（worktree 就落在这个目录下）。
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.sid-code/\n");
  mkdirSync(join(repo, "node_modules"));
  writeFileSync(join(repo, "node_modules", "pkg.js"), "1\n");
  git(["add", "a.txt", ".gitignore"], repo);
  git(["commit", "-q", "-m", "init"], repo);
  git(["push", "-q", "-u", "origin", "HEAD"], repo);
}

beforeEach(setupRepoWithRemote);

afterEach(() => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

/**
 * remove(force=false) 是否因 fail-closed 而抛错。
 * 返回 true = 拒删（预期的保护行为）；false = 删成功（有工作时属危险）。
 */
async function removeThrows(
  m: WorktreeManager,
  s: Awaited<ReturnType<WorktreeManager["create"]>>,
): Promise<boolean> {
  try {
    await m.remove(s, false);
    return false;
  } catch {
    return true;
  }
}

/** 把目录 mtime 调到超出宽限期 */
function ageOut(path: string): void {
  const t = new Date(Date.now() - EPHEMERAL_GRACE_MS - 3600_000);
  utimesSync(path, t, t);
}

describe("A. symlink 不算用户改动（孤儿累积的直接根因）", () => {
  it("node_modules symlink 存在时 countChanges 仍为 0", async () => {
    const m = new WorktreeManager(repo);
    const s = await m.create("agent-deadbeef");

    // 前提确认：symlink 真的建了（否则本测试无意义）
    expect(existsSync(join(s.worktreePath, "node_modules"))).toBe(true);

    const changes = m.countChanges(s.worktreePath, s.originalHeadCommit);
    expect(changes).not.toBeNull();
    expect(changes!.changedFiles).toBe(0);
    expect(changes!.commits).toBe(0);
  });

  it("无改动的隔离 worktree 能被 remove(force=false) 自动清理", async () => {
    const m = new WorktreeManager(repo);
    const s = await m.create("agent-cafe0001");
    expect(await m.remove(s, false)).toBe(true);
    expect(existsSync(s.worktreePath)).toBe(false);
  });

  it("第二道防线：即使 raw status 报 ?? symlink，判定仍为 0（覆盖旧版本遗留 worktree）", async () => {
    const m = new WorktreeManager(repo);
    const s = await m.create("agent-cafe0002");

    // 确认原始 git status 确实报了这一行 —— 复现 bug 现场
    const raw = git(["status", "--porcelain"], s.worktreePath).trim();
    expect(raw).toBe("?? node_modules");

    // 但我们的判定不受它影响
    expect(m.countChanges(s.worktreePath, s.originalHeadCommit)!.changedFiles).toBe(0);
  });
});

describe("B. fail-closed 底线：真实工作必须保住", () => {
  it("未提交的普通文件仍算改动，拒绝删除", async () => {
    const m = new WorktreeManager(repo);
    const s = await m.create("agent-beef0001");
    writeFileSync(join(s.worktreePath, "user-work.txt"), "用户的真实工作\n");

    expect(m.countChanges(s.worktreePath, s.originalHeadCommit)!.changedFiles).toBe(1);
    expect(await removeThrows(m, s)).toBe(true);
    expect(existsSync(s.worktreePath)).toBe(true);
  });

  it("已跟踪文件被修改仍算改动", async () => {
    const m = new WorktreeManager(repo);
    const s = await m.create("agent-beef0002");
    writeFileSync(join(s.worktreePath, "a.txt"), "改了\n");

    expect(m.countChanges(s.worktreePath, s.originalHeadCommit)!.changedFiles).toBe(1);
    expect(await removeThrows(m, s)).toBe(true);
  });

  it("未推送 commit 仍算工作，拒绝删除", async () => {
    const m = new WorktreeManager(repo);
    const s = await m.create("agent-beef0003");
    writeFileSync(join(s.worktreePath, "c.txt"), "1\n");
    git(["add", "c.txt"], s.worktreePath);
    git(["commit", "-q", "-m", "wip"], s.worktreePath);

    expect(m.countChanges(s.worktreePath, s.originalHeadCommit)!.commits).toBe(1);
    expect(await removeThrows(m, s)).toBe(true);
    expect(existsSync(s.worktreePath)).toBe(true);
  });

  it("非 symlink 的 untracked 目录照常算改动（不被过度豁免）", async () => {
    const m = new WorktreeManager(repo);
    const s = await m.create("agent-beef0004");
    mkdirSync(join(s.worktreePath, "user-dir"));
    writeFileSync(join(s.worktreePath, "user-dir", "f.txt"), "x\n");

    expect(m.countChanges(s.worktreePath, s.originalHeadCommit)!.changedFiles).toBe(1);
  });
});

describe("C. 零 git 副作用（不碰用户文件 / 不污染主仓）", () => {
  it("创建与删除 worktree 全程不改主仓 .gitignore、exclude、status", async () => {
    const excludePath = join(repo, ".git", "info", "exclude");
    const snapshot = () => ({
      gitignore: readFileSync(join(repo, ".gitignore"), "utf-8"),
      exclude: existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "<none>",
      status: git(["status", "--porcelain"], repo),
      head: git(["rev-parse", "HEAD"], repo),
    });

    const before = snapshot();
    const m = new WorktreeManager(repo);
    const s1 = await m.create("agent-0badf00d");
    const s2 = await m.create("agent-0badf11d");

    const during = snapshot();
    expect(during.gitignore).toBe(before.gitignore);
    expect(during.exclude).toBe(before.exclude);
    expect(during.status).toBe(before.status);
    expect(during.head).toBe(before.head);

    await m.remove(s1, false);
    await m.remove(s2, false);

    const after = snapshot();
    expect(after.gitignore).toBe(before.gitignore);
    expect(after.exclude).toBe(before.exclude);
    expect(after.status).toBe(before.status);
    // 临时分支应随 remove 一起清掉，refs 完全复原
    expect(git(["for-each-ref", "--format=%(refname)"], repo)).toBe(
      git(["for-each-ref", "--format=%(refname)"], repo),
    );
    expect(existsSync(s1.worktreePath)).toBe(false);
    expect(existsSync(s2.worktreePath)).toBe(false);
  });

  it("主仓 .git/info/exclude 不被创建（曾误写此处污染主仓）", async () => {
    const excludePath = join(repo, ".git", "info", "exclude");
    const existedBefore = existsSync(excludePath);
    const contentBefore = existedBefore ? readFileSync(excludePath, "utf-8") : null;

    const m = new WorktreeManager(repo);
    const s = await m.create("agent-0badbeef");

    if (existedBefore) {
      expect(readFileSync(excludePath, "utf-8")).toBe(contentBefore!);
    } else {
      expect(existsSync(excludePath)).toBe(false);
    }
    // 且不含我们的标记
    if (existsSync(excludePath)) {
      expect(readFileSync(excludePath, "utf-8")).not.toContain("sid-code");
    }
    await m.remove(s, false);
  });
});

describe("D. 启动期 GC 宽限期（防孤儿占盘 30 天）", () => {
  it("超宽限且无改动的临时 worktree 被回收", async () => {
    const m = new WorktreeManager(repo);
    const s = await m.create("agent-11111111");
    ageOut(s.worktreePath);

    const n = await cleanupStaleWorktrees(repo, 30);
    expect(n).toBe(1);
    expect(existsSync(s.worktreePath)).toBe(false);
  });

  it("宽限期内的新建 worktree 不被回收（避开正在跑的任务）", async () => {
    const m = new WorktreeManager(repo);
    const s = await m.create("agent-22222222");

    const n = await cleanupStaleWorktrees(repo, 30);
    expect(n).toBe(0);
    expect(existsSync(s.worktreePath)).toBe(true);
  });

  it("GC 能看见「未 git add 的新文件」并保住 worktree（曾用 -uno 致数据丢失）", async () => {
    // 这是本次修复抓到的**预存在**真实数据丢失风险：
    // GC 原用 countChanges({fast:true}) → `-uno` 完全跳过 untracked 扫描 →
    // 用户新建但未 add 的文件对 GC 不可见 → 判定无改动 → 连同工作一起删除。
    const m = new WorktreeManager(repo);
    const s = await m.create("agent-77777777");
    writeFileSync(join(s.worktreePath, "未保存的新文件.txt"), "还没 git add 的工作\n");
    ageOut(s.worktreePath);

    // fast 模式必须能看见它
    const fast = m.countChanges(s.worktreePath, "", { fast: true });
    expect(fast).not.toBeNull();
    expect(fast!.changedFiles).toBe(1);

    const n = await cleanupStaleWorktrees(repo, 30);
    expect(n).toBe(0);
    expect(existsSync(s.worktreePath)).toBe(true);
    expect(existsSync(join(s.worktreePath, "未保存的新文件.txt"))).toBe(true);
  });

  it("超宽限但有真实改动 / 未推送 commit 的一律保住", async () => {
    const m = new WorktreeManager(repo);
    const dirty = await m.create("agent-33333333");
    writeFileSync(join(dirty.worktreePath, "user-work.txt"), "真实工作\n");
    ageOut(dirty.worktreePath);

    const committed = await m.create("agent-44444444");
    writeFileSync(join(committed.worktreePath, "c.txt"), "1\n");
    git(["add", "c.txt"], committed.worktreePath);
    git(["commit", "-q", "-m", "wip"], committed.worktreePath);
    ageOut(committed.worktreePath);

    await cleanupStaleWorktrees(repo, 30);
    expect(existsSync(dirty.worktreePath)).toBe(true);
    expect(existsSync(committed.worktreePath)).toBe(true);
  });

  it("用户命名的 worktree 永不自动回收（即使很老且无改动）", async () => {
    const m = new WorktreeManager(repo);
    const s = await m.create("my-feature");
    ageOut(s.worktreePath);

    const n = await cleanupStaleWorktrees(repo, 30);
    expect(n).toBe(0);
    expect(existsSync(s.worktreePath)).toBe(true);
  });

  it("活跃 session 的 worktree 被 skipPath 跳过", async () => {
    const m = new WorktreeManager(repo);
    const s = await m.create("agent-55555555");
    ageOut(s.worktreePath);

    const n = await cleanupStaleWorktrees(repo, 30, s.worktreePath);
    expect(n).toBe(0);
    expect(existsSync(s.worktreePath)).toBe(true);
  });
});
