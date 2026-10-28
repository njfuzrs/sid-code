/**
 * PR-1 — file-intent 存储层双轨重构回归测试
 *
 * 覆盖外部方案文档（20261016-并发冲突检测-worktree感知重构）核实后的修正项：
 * - B1：假容器路径不再误折叠（折叠判据改为 git 自己的记录，不猜路径形态）
 * - B2：仓库外同级 worktree（git worktree add ../x）折回主仓键，冲突不再漏检
 * - B5：operation 只升不降（read 冲不掉 edit/write）
 * - C1：temp+rename 原子写（无 .tmp 残留、读侧永远看到完整 JSON）
 * - 双轨：FileIntent.physicalPath 保留物理位置，ConflictReport 据此区分
 *   「同一份磁盘文件」（真覆盖风险）与「worktree 分支分叉」（合并时才撞车）
 * - B-a：write 新建文件（路径不存在）走「最近已存在祖先」realpath 回退
 * - B-b：查询侧与写入侧同一解析函数，键天然对称
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
} from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import {
  declareFileIntent,
  queryFileIntents,
  queryAllFileIntents,
  clearFileIntent,
  intentKeyForPath,
  resolveIntentKey,
  __clearIntentKeyCache,
} from "@sid-code/core/session/file-intent.ts";
import { checkConflict } from "@sid-code/core/session/conflict-detector.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

let repo: string;
let outside: string;
let sidHome: string;
let prevSidHome: string | undefined;

beforeEach(() => {
  prevSidHome = process.env.SID_CONFIG_DIR;
  sidHome = realpathSync(mkdtempSync(join(tmpdir(), "sid-pr1-home-")));
  process.env.SID_CONFIG_DIR = sidHome;
  __clearIntentKeyCache();

  repo = realpathSync(mkdtempSync(join(tmpdir(), "sid-pr1-repo-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "sid-pr1-out-")));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@t.com"], repo);
  git(["config", "user.name", "t"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "login.ts"), "export const v = 1;\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "init"], repo);
});

afterEach(() => {
  __clearIntentKeyCache();
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

/** 建一个真实 linked worktree（git 会写 .git pointer 文件） */
function addWorktree(path: string, branch: string): void {
  git(["worktree", "add", "-q", "-b", branch, path, "main"], repo);
}

describe("B2 — 仓库外同级 worktree 折回主仓键", () => {
  it("git worktree add ../x 里的文件与主仓同一相对路径同键", () => {
    const sibling = join(outside, "wt-feat");
    addWorktree(sibling, "feat-sibling");

    const mainFile = join(repo, "src", "login.ts");
    const wtFile = join(sibling, "src", "login.ts");
    expect(intentKeyForPath(wtFile)).toBe(mainFile);
    expect(intentKeyForPath(wtFile)).toBe(intentKeyForPath(mainFile));
  });

  it("仓库内容器 worktree（.sid-code/worktrees/<slug>）同样折回主仓键", () => {
    const wt = join(repo, ".sid-code", "worktrees", "agent-x1");
    addWorktree(wt, "feat-inner");

    const wtFile = join(wt, "src", "login.ts");
    expect(intentKeyForPath(wtFile)).toBe(join(repo, "src", "login.ts"));
  });

  it("跨 worktree 冲突可见：worktree 会话声明后主仓会话能查到", () => {
    const sibling = join(outside, "wt-feat2");
    addWorktree(sibling, "feat-sib2");
    const wtFile = join(sibling, "src", "login.ts");

    declareFileIntent("pr1-wt-session", process.pid, sibling, wtFile, "edit");
    try {
      const hits = queryFileIntents(join(repo, "src", "login.ts"), "pr1-main-session");
      expect(hits.map((h) => h.sessionId)).toContain("pr1-wt-session");
    } finally {
      clearFileIntent("pr1-wt-session");
    }
  });
});

describe("B1 — 假容器路径不再误折叠", () => {
  it("未经 git worktree add 的容器子目录按原样作键（剥一级会映射到主仓不存在的位置）", () => {
    const fake = join(repo, ".sid-code", "worktrees", "not-a-worktree", "src", "x.ts");
    expect(intentKeyForPath(fake)).toBe(fake);
  });

  it("非 git 目录里的路径原样返回（含点开头段）", () => {
    expect(intentKeyForPath(join(outside, "a", "b.ts"))).toBe(join(outside, "a", "b.ts"));
    expect(intentKeyForPath("/r/.sid-code/worktrees/.git/hooks/x")).toBe(
      "/r/.sid-code/worktrees/.git/hooks/x",
    );
  });
});

describe("双轨 — physicalPath 与逻辑键分离", () => {
  it("worktree 里声明：path=主仓键，physicalPath=worktree 物理位置", () => {
    const sibling = join(outside, "wt-dual");
    addWorktree(sibling, "feat-dual");
    const wtFile = join(sibling, "src", "login.ts");

    declareFileIntent("pr1-dual", process.pid, sibling, wtFile, "edit");
    try {
      const entry = queryAllFileIntents()["pr1-dual"].files[join(repo, "src", "login.ts")];
      expect(entry).toBeDefined();
      expect(entry.path).toBe(join(repo, "src", "login.ts"));
      expect(entry.physicalPath).toBe(wtFile);
      expect(entry.physicalPath).not.toBe(entry.path);
    } finally {
      clearFileIntent("pr1-dual");
    }
  });

  it("checkConflict：跨 worktree 分叉 → isWorktreeBranchConflict=true（不弹窗语义，PR-4 消费）", () => {
    const sibling = join(outside, "wt-bc");
    addWorktree(sibling, "feat-bc");
    const wtFile = join(sibling, "src", "login.ts");

    declareFileIntent("pr1-other", process.pid, sibling, wtFile, "edit");
    try {
      const report = checkConflict(join(repo, "src", "login.ts"), "pr1-self");
      expect(report).not.toBeNull();
      expect(report!.isWorktreeBranchConflict).toBe(true);
      expect(report!.conflictingSessions[0].isBranchDivergence).toBe(true);
      expect(report!.conflictingSessions[0].physicalPath).toBe(wtFile);
    } finally {
      clearFileIntent("pr1-other");
    }
  });

  it("checkConflict：同一份磁盘文件 → isWorktreeBranchConflict=false（真覆盖风险，须人工裁决）", () => {
    const mainFile = join(repo, "src", "login.ts");
    declareFileIntent("pr1-other2", process.pid, repo, mainFile, "edit");
    try {
      const report = checkConflict(mainFile, "pr1-self2");
      expect(report).not.toBeNull();
      expect(report!.isWorktreeBranchConflict).toBe(false);
      expect(report!.conflictingSessions[0].isBranchDivergence).toBe(false);
    } finally {
      clearFileIntent("pr1-other2");
    }
  });

  it("混合场景（一个分叉 + 一个同文件）→ false，覆盖风险优先", () => {
    const sibling = join(outside, "wt-mix");
    addWorktree(sibling, "feat-mix");
    const mainFile = join(repo, "src", "login.ts");

    declareFileIntent("pr1-branch", process.pid, sibling, join(sibling, "src", "login.ts"), "edit");
    declareFileIntent("pr1-same", process.pid, repo, mainFile, "write");
    try {
      const report = checkConflict(mainFile, "pr1-self3");
      expect(report).not.toBeNull();
      expect(report!.conflictingSessions.length).toBe(2);
      expect(report!.isWorktreeBranchConflict).toBe(false);
    } finally {
      clearFileIntent("pr1-branch");
      clearFileIntent("pr1-same");
    }
  });
});

describe("B-a — write 新建文件（路径不存在）的 realpath 回退", () => {
  it("不存在的目标按最近已存在祖先归一化，键与后来真实创建的文件一致", () => {
    const target = join(repo, "src", "brand-new.ts");
    expect(existsSync(target)).toBe(false);
    const before = resolveIntentKey(target);
    expect(before.key).toBe(target);
    expect(before.physical).toBe(target);

    // 创建后解析结果不变（祖先 realpath 稳定的普通目录场景）
    writeFileSync(target, "x");
    __clearIntentKeyCache();
    const after = resolveIntentKey(target);
    expect(after.key).toBe(before.key);
  });

  it("符号链接路径与真实路径解析到同一个键", () => {
    const realFile = join(repo, "src", "login.ts");
    const linkDir = join(repo, "link-to-src");
    symlinkSync(join(repo, "src"), linkDir, "dir");
    const viaLink = join(linkDir, "login.ts");

    expect(intentKeyForPath(viaLink)).toBe(intentKeyForPath(realFile));
  });
});

describe("B5 — operation 只升不降", () => {
  it("edit 之后 read 不把意图冲成 read（否则冲突检测被自己的读静默撤销）", () => {
    const f = join(repo, "src", "login.ts");
    declareFileIntent("pr1-b5", process.pid, repo, f, "edit");
    declareFileIntent("pr1-b5", process.pid, repo, f, "read");
    try {
      const entry = queryAllFileIntents()["pr1-b5"].files[f];
      expect(entry.operation).toBe("edit");
    } finally {
      clearFileIntent("pr1-b5");
    }
  });

  it("read 之后 edit 正常升级为 edit", () => {
    const f = join(repo, "src", "login.ts");
    declareFileIntent("pr1-b5b", process.pid, repo, f, "read");
    declareFileIntent("pr1-b5b", process.pid, repo, f, "edit");
    try {
      expect(queryAllFileIntents()["pr1-b5b"].files[f].operation).toBe("edit");
    } finally {
      clearFileIntent("pr1-b5b");
    }
  });

  it("edit 之后 read 不再让其它会话的冲突消失（端到端语义）", () => {
    const f = join(repo, "src", "login.ts");
    declareFileIntent("pr1-b5c", process.pid, repo, f, "edit");
    declareFileIntent("pr1-b5c", process.pid, repo, f, "read");
    try {
      const report = checkConflict(f, "pr1-viewer");
      expect(report).not.toBeNull();
      expect(report!.conflictingSessions[0].lastOperation).toBe("edit");
    } finally {
      clearFileIntent("pr1-b5c");
    }
  });
});

describe("C1 — temp+rename 原子写", () => {
  it("声明后无 .tmp 残留，意图文件永远是完整 JSON", () => {
    const f = join(repo, "src", "login.ts");
    for (let i = 0; i < 5; i++) {
      declareFileIntent("pr1-c1", process.pid, repo, f, i % 2 ? "edit" : "read");
    }
    const dir = join(sidHome, "file-intents");
    const leftovers = readdirSync(dir).filter((n) => n.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    const parsed = JSON.parse(readFileSync(join(dir, "pr1-c1.json"), "utf-8"));
    expect(parsed.sessionId).toBe("pr1-c1");
    expect(parsed.files[f]).toBeDefined();
    clearFileIntent("pr1-c1");
  });
});

describe("B-b — 写入侧与查询侧键对称", () => {
  it("同一函数解析：declare 用相对起算目录，query 用绝对路径，键一致", () => {
    const sibling = join(outside, "wt-sym");
    addWorktree(sibling, "feat-sym");
    const wtFile = join(sibling, "src", "login.ts");

    // 写入侧从 worktree 内声明（cwd=sibling），查询侧站在全然不同的 cwd 查主仓路径
    declareFileIntent("pr1-sym-w", process.pid, sibling, wtFile, "write");
    try {
      const hits = queryFileIntents(join(repo, "src", "login.ts"), "pr1-sym-q");
      expect(hits.map((h) => h.sessionId)).toContain("pr1-sym-w");
      expect(hits[0].intent.physicalPath).toBe(wtFile);
    } finally {
      clearFileIntent("pr1-sym-w");
    }
  });

  it("dirname 起算而非 cwd：对与 cwd 无关的绝对路径也解析出正确主仓根", () => {
    const sibling = join(outside, "wt-cwd");
    addWorktree(sibling, "feat-cwd");
    const wtFile = join(sibling, "src", "login.ts");

    // 站在 /（与任何仓库无关）解析 worktree 文件——旧实现若按 cwd 起算会拿错根
    const prevCwd = process.cwd();
    try {
      process.chdir(dirname(sidHome));
      __clearIntentKeyCache();
      expect(intentKeyForPath(wtFile)).toBe(join(repo, "src", "login.ts"));
    } finally {
      process.chdir(prevCwd);
      __clearIntentKeyCache();
    }
  });
});
