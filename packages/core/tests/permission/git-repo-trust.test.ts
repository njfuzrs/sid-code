/**
 * B4 的仓库身份判定单元测试（`resolveGitRepoTrust` / `resolveOwnCommonDir`）
 *
 * 与 `git-readonly-boundary.test.ts` 拆成两个文件：那份测的是**权限结果**（一条命令最终
 * ALLOW 还是 ASK），这份测的是**判定本身**。分开的直接理由是修缺陷前要做旧行为探测——
 * 权限矩阵那份必须能在修前的 main 上跑起来（不引用本次新增的模块）。
 *
 * 夹具在 tmpdir 里现造四种形态：本仓（含 ws 外的 linked worktree）、ws 内的嵌套独立仓库、
 * ws 内的裸仓库形态目录（`HEAD` + `objects/` + `refs/`，没有 `.git`）、以及完全无关的目录。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  resetGitRepoTrustCache,
  resolveGitRepoTrust,
  resolveOwnCommonDir,
} from "@sid-code/core/permission/git-repo-trust.ts";

let root: string;
/** 本仓根 */
let ws: string;
/** ws 内的嵌套独立仓库 */
let nestedRepo: string;
/** ws 内的裸仓库形态目录 */
let bareShape: string;
/** 本仓的 linked worktree，刻意建在 ws 之外 */
let worktree: string;
/** ws 之外的独立仓库 */
let otherRepo: string;
/** ws 内、不属于任何仓库的普通目录 */
let plainDir: string;
/** ws 之外、不属于任何仓库的目录 */
let nowhere: string;

function git(args: string[], cwd: string): void {
  execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=a", ...args], {
    cwd,
    stdio: "pipe",
  });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(["init", "-q"], dir);
  git(["commit", "-q", "--allow-empty", "-m", "init"], dir);
}

// 夹具要 spawn 十几次 git，在慢机器上会超过 bun 默认的 5s hook 超时
const FIXTURE_TIMEOUT = 60_000;

beforeAll(() => {
  resetGitRepoTrustCache();
  root = realpathSync(mkdtempSync(join(tmpdir(), "sid-pr1-trust-")));
  ws = join(root, "repo");
  initRepo(ws);
  nestedRepo = join(ws, "vendor", "evil");
  initRepo(nestedRepo);
  bareShape = join(ws, "vendor", "bare-shape");
  mkdirSync(join(bareShape, "objects"), { recursive: true });
  mkdirSync(join(bareShape, "refs"), { recursive: true });
  writeFileSync(join(bareShape, "HEAD"), "ref: refs/heads/main\n");
  plainDir = join(ws, "docs");
  mkdirSync(plainDir, { recursive: true });
  worktree = join(root, "wt");
  git(["worktree", "add", "-q", worktree, "-b", "wtb"], ws);
  otherRepo = join(root, "other");
  initRepo(otherRepo);
  nowhere = join(root, "nowhere");
  mkdirSync(nowhere, { recursive: true });
}, FIXTURE_TIMEOUT);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  resetGitRepoTrustCache();
}, FIXTURE_TIMEOUT);

describe("resolveGitRepoTrust / resolveOwnCommonDir", () => {
  test("本仓根、子目录、linked worktree 都是 own", () => {
    const own = resolveOwnCommonDir(ws);
    expect(own).not.toBeNull();
    expect(resolveGitRepoTrust(ws, own)).toBe("own");
    expect(resolveGitRepoTrust(plainDir, own)).toBe("own");
    // linked worktree 的 `.git` 是文件，按 commondir 解析到主仓的 .git
    expect(resolveGitRepoTrust(worktree, own)).toBe("own");
  });

  test("嵌套独立仓库是 foreign", () => {
    expect(resolveGitRepoTrust(nestedRepo, resolveOwnCommonDir(ws))).toBe("foreign");
    expect(resolveGitRepoTrust(otherRepo, resolveOwnCommonDir(ws))).toBe("foreign");
  });

  test("裸仓库形态是 bare（即使是 ws 内的子目录）", () => {
    // 先查 `.git` 再查裸仓库形态，顺序不能反：反了会向上找到 <ws>/.git 而误判成 own
    expect(resolveGitRepoTrust(bareShape, resolveOwnCommonDir(ws))).toBe("bare");
  });

  test("不属于任何仓库的目录是 none", () => {
    expect(resolveGitRepoTrust(nowhere, resolveOwnCommonDir(ws))).toBe("none");
  });

  test("工作区不在仓库里时 resolveOwnCommonDir 返回 null", () => {
    expect(resolveOwnCommonDir(nowhere)).toBeNull();
  });

  test("不存在的目录按 none 处理（不抛错）", () => {
    expect(resolveGitRepoTrust(join(root, "does-not-exist"), resolveOwnCommonDir(ws))).toBe("none");
  });
});
