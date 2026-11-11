/**
 * CG-2（台账 H3 / 后续规划 §2.7）：worktree 路径语义文案
 *
 * 缺陷形态：进入 worktree 后，上下文里仍留着大量主仓绝对路径，模型复用它们写文件时
 * 落盘到主仓（台账基线 53 次 / 4 会话）。修复只做**提示不拦截**（用户可能确实要改主仓
 * 的一份共享配置），验收判据是「每个会话 ≤ 1 次」——允许写错一次，提示后必须改正。
 *
 * 这里锁三件事：
 *   1. 进入/退出 worktree 的结果里，旧路径的角色变化被说清楚（否则模型默认它还是工作树）；
 *   2. 在 worktree 里写主仓路径时，提示里带**可直接执行的替换路径**（只说"写错了"没有用，
 *      模型下一轮还得自己算相对路径，容易再错一次）；
 *   3. 反向边界：不在 worktree、写在 worktree 内、写在主仓外、写别的 worktree 目录，
 *      都不许出提示（提示错比不提示更糟——它会把模型引到一个不存在的路径上）。
 */

import { describe, test, expect, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  enterWorktreePathsNotice,
  exitWorktreePathsNotice,
  mainRepoWriteHint,
} from "@sid-code/core/worktree/path-semantics.ts";
import {
  setCurrentWorktreeSession,
  clearWorktreeSession,
} from "@sid-code/core/worktree/manager.ts";
import type { WorktreeSession } from "@sid-code/core/worktree/types.ts";

/** 用临时目录当主仓，绝不能用真实仓库路径——下面的用例会真的经由 write 工具落盘。 */
const root = mkdtempSync(join(tmpdir(), "sid-wt-path-semantics-"));
const MAIN = join(root, "main-repo");
const WT = join(MAIN, ".sid-code", "worktrees", "feat+x");

function enterSession(overrides: Partial<WorktreeSession> = {}): void {
  const session: WorktreeSession = {
    originalCwd: MAIN,
    worktreePath: WT,
    worktreeName: "feat+x",
    sessionId: "test-session",
    worktreeBranch: "worktree-feat+x",
    originalHeadCommit: "0".repeat(40),
    ...overrides,
  };
  setCurrentWorktreeSession(session);
}

afterEach(() => {
  clearWorktreeSession();
});

describe("mainRepoWriteHint — worktree 内写主仓路径时的提示", () => {
  test("不在 worktree 会话里：不提示（主仓路径就是正确答案）", () => {
    expect(mainRepoWriteHint(join(MAIN, "src", "a.ts"))).toBe("");
  });

  test("写在当前 worktree 内：不提示", () => {
    enterSession();
    expect(mainRepoWriteHint(join(WT, "src", "a.ts"))).toBe("");
  });

  test("写在主仓根下：提示里带主仓路径与可直接执行的替换路径", () => {
    enterSession();
    const written = join(MAIN, "src", "a.ts");
    const hint = mainRepoWriteHint(written);

    // §2.7 规定的文案形态：指出在主仓 + 给出 worktree 里对应的路径
    expect(hint).toContain(written);
    expect(hint).toContain("在主仓");
    expect(hint).toContain(join(WT, "src", "a.ts"));
  });

  test("替换路径按相对位置拼出，深层子目录也正确", () => {
    enterSession();
    const hint = mainRepoWriteHint(join(MAIN, "packages", "core", "src", "tool", "edit.ts"));
    expect(hint).toContain(join(WT, "packages", "core", "src", "tool", "edit.ts"));
  });

  test("写在主仓之外（如 /tmp）：不提示（与 worktree 身份无关）", () => {
    enterSession();
    expect(mainRepoWriteHint(join(tmpdir(), "somewhere", "a.ts"))).toBe("");
  });

  test("写在 .sid-code/worktrees 下的其它 worktree：不提示", () => {
    // 按当前 worktree 做替换会拼出 <WT>/.sid-code/worktrees/feat+y/a.ts —— 一个不存在的路径。
    enterSession();
    expect(mainRepoWriteHint(join(MAIN, ".sid-code", "worktrees", "feat+y", "a.ts"))).toBe("");
  });

  test("前缀边界：/main-repo-other 不被当成 /main-repo 下的文件", () => {
    enterSession();
    expect(mainRepoWriteHint(MAIN + "-other/a.ts")).toBe("");
  });

  test("会话里记录的主仓根与实际写入路径同级时（写主仓根本身）：不提示", () => {
    // 写一个目录必然失败，没有可替换的路径；返回半截拼出来的路径只会误导。
    enterSession();
    expect(mainRepoWriteHint(MAIN)).toBe("");
  });
});

describe("enterWorktreePathsNotice — 进入时说明旧路径换了角色", () => {
  test("同时给出主仓根、worktree 路径，并点明主仓根不是当前工作树", () => {
    const notice = enterWorktreePathsNotice(WT, MAIN);
    expect(notice).toContain(MAIN);
    expect(notice).toContain(WT);
    expect(notice).toContain("不是当前工作树");
  });

  test("给出替代路径而不只是禁令（禁令下一轮仍会复用旧路径）", () => {
    const notice = enterWorktreePathsNotice(WT, MAIN);
    expect(notice).toContain("写文件请用");
  });
});

describe("exitWorktreePathsNotice — 退出时说明 worktree 不再是工作树", () => {
  test("keep：说明目录仍保留在磁盘上，当前工作目录是主仓", () => {
    const notice = exitWorktreePathsNotice(WT, MAIN, false);
    expect(notice).toContain(MAIN);
    expect(notice).toContain(WT);
    expect(notice).toContain("不再是当前工作树");
    expect(notice).toContain("仍保留在磁盘上");
  });

  test("remove：说明目录已删除，不能写成「仍保留在磁盘上」", () => {
    const notice = exitWorktreePathsNotice(WT, MAIN, true);
    expect(notice).toContain("已删除");
    expect(notice).not.toContain("仍保留在磁盘上");
  });
});

/** 模块级临时目录用完即删（只删本文件自己创建的目录）。 */
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
