/**
 * B14 防复发：同一仓库的主 checkout 与 linked worktree 共享长期记忆。
 *
 * 旧实现记忆键走 `git rev-parse --show-toplevel`，它在 linked worktree 里返回
 * worktree 自己 ⇒ 主仓与 worktree 落在两个 projectKey，记忆不共享；而模块注释、
 * 官网 `use/memory.md`、术语表三处都写着「共享」。旧测试 mock 了 execSync，
 * 测的是 mock 的返回值 —— 所以这里**必须真建一个 worktree**，不许 mock git。
 *
 * 变异自证（逐条确认过回退即红）：
 * - `getAutoMemPath` 改回用 `resolveProjectRoot` ⇒「worktree 与主仓派生同一记忆目录」
 *   与「worktree 里存的记忆回主仓 list 得到」变红；
 * - 删掉 `resolve(cwd, common)` 的归一（直接用 git 的相对输出）⇒「主仓子目录」变红；
 * - 删掉 `mergeLegacyWorktreeMemory` 调用 ⇒「旧键下的记忆被并入」变红；
 * - 删掉标记文件判断 ⇒「删除后不复活」变红。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, mkdirSync, realpathSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  getAutoMemPath,
  getLegacyWorktreeMemPath,
  resolveMemoryProjectRoot,
  resolveProjectRoot,
  sanitizeProjectKey,
  clearProjectRootCache,
} from "@sid-code/core/memory/paths.ts";
import { MemoryStore } from "@sid-code/core/memory/store.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

let base: string;
let mainRepo: string;
let wt: string;
let tmpHome: string;
let prevConfigDir: string | undefined;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "sid-b14-")));
  tmpHome = join(base, "home");
  mkdirSync(tmpHome);
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = tmpHome;

  mainRepo = join(base, "main-repo");
  mkdirSync(join(mainRepo, "sub"), { recursive: true });
  git(["init", "-q", "."], mainRepo);
  git(["config", "user.email", "t@t.com"], mainRepo);
  git(["config", "user.name", "t"], mainRepo);
  git(["config", "commit.gpgsign", "false"], mainRepo);
  git(["commit", "-q", "--allow-empty", "-m", "init"], mainRepo);
  wt = join(base, "wt-b");
  git(["worktree", "add", "-q", wt, "-b", "b14"], mainRepo);
  clearProjectRootCache();
});

afterAll(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  clearProjectRootCache();
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("B14 记忆键按 git common-dir 派生", () => {
  test("前提核验：--show-toplevel 在 worktree 里确实返回 worktree 自己", () => {
    // 这条锁的是缺陷成因本身：哪天 git 行为变了，这里先红，提醒重新评估
    expect(resolveProjectRoot(wt)).toBe(wt);
    expect(resolveProjectRoot(mainRepo)).toBe(mainRepo);
  });

  test("worktree 与主仓派生同一记忆目录", () => {
    expect(resolveMemoryProjectRoot(wt)).toBe(mainRepo);
    expect(getAutoMemPath(wt)).toBe(getAutoMemPath(mainRepo));
  });

  test("主仓子目录（git 返回相对路径 ../.git）也归一到主仓根", () => {
    expect(resolveMemoryProjectRoot(join(mainRepo, "sub"))).toBe(mainRepo);
  });

  test("非 git 目录回退到 resolveProjectRoot（不编路径）", () => {
    const plain = join(base, "plain");
    mkdirSync(plain, { recursive: true });
    expect(resolveMemoryProjectRoot(plain)).toBe(resolveProjectRoot(plain));
  });

  test("会话类数据仍按 worktree 分开（只改记忆键，不动 resolveProjectRoot）", () => {
    expect(resolveProjectRoot(wt)).not.toBe(resolveProjectRoot(mainRepo));
  });

  test("worktree 里存的记忆，回主仓 list 得到（端到端）", async () => {
    const inWt = new MemoryStore(wt);
    await inWt.set("b14-shared", "worktree 里写的", "project");
    const inMain = new MemoryStore(mainRepo);
    const keys = (await inMain.list()).map((e) => e.key);
    expect(keys).toContain("b14-shared");
  });
});

describe("B14 兼容：旧键（每 worktree 一份）下的存量记忆并入共享目录", () => {
  test("旧键目录里的记忆被并入，旧目录保留，删除后不复活", async () => {
    // 用第二个 worktree 模拟「升级前在 worktree 里攒过记忆」
    const wt2 = join(base, "wt-c");
    git(["worktree", "add", "-q", wt2, "-b", "b14c"], mainRepo);
    clearProjectRootCache();

    const legacyDir = getLegacyWorktreeMemPath(wt2)!;
    expect(legacyDir).toBeDefined();
    expect(legacyDir).toContain(sanitizeProjectKey(wt2));
    mkdirSync(legacyDir, { recursive: true });
    const legacyFile = join(legacyDir, "project_old-note.md");
    writeFileSync(
      legacyFile,
      "---\nname: old-note\ndescription: 升级前存的\ntype: project\n---\n\n旧 worktree 记忆\n",
    );

    const store = new MemoryStore(wt2);
    expect((await store.list()).map((e) => e.key)).toContain("old-note");
    // 复制不移动
    expect(existsSync(legacyFile)).toBe(true);
    // 主仓也看得到
    expect((await new MemoryStore(mainRepo).list()).map((e) => e.key)).toContain("old-note");

    // 在共享目录删掉后，新实例再加载不应从旧目录复活
    await store.delete("old-note");
    const again = new MemoryStore(wt2);
    expect((await again.list()).map((e) => e.key)).not.toContain("old-note");
  });

  test("主 checkout 没有旧键可迁", () => {
    expect(getLegacyWorktreeMemPath(mainRepo)).toBeUndefined();
  });
});
