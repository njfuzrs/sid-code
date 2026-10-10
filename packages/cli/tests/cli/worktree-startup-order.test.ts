/**
 * 门禁 · worktree 启动恢复与 GC 的时序（W2）
 *
 * 缺陷形态：启动流程里三件事的顺序是
 *   ① 按「目录还在不在」恢复持久化状态并 **chdir 进去**
 *   ② fire-and-forget 启动 GC，skipPath 用的是 ① 算出的 activeWtPath
 *   ③ 才解析「本次要恢复哪个会话」，做归属复核 —— 可能得出「这份状态不该进入」
 * ② 拿着一个**马上要被推翻**的事实当 skipPath 跑出去，且与会话选择器并发。
 *
 * 修法与紧邻的会话清理（D3 的 startBackgroundSessionCleanup）同构：
 * 不是「多传一个参数」，而是把**启动时机**挪到判据齐了之后。
 * 恢复那段只登记 gitRoot 与候选 worktree，GC 在归属复核之后才启动。
 * 复核通过才 chdir；不通过则不进入、状态保留，skipPath 仍指向它（留给拥有者回来）。
 *
 * 为什么用静态门禁而不是行为测试：这段逻辑在 cli.ts 的 main() 里，
 * 跑它要拉起整个 CLI 启动流程（TUI、provider、session store）。
 * 本文件锁住的是**语句相对顺序**这一个判据——它恰好就是缺陷本身，
 * 而顺序被改回去是这条缺陷唯一的复发方式。
 * worktree 侧的行为由 packages/core/tests/worktree/*.test.ts 覆盖。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLI_SRC = readFileSync(join(import.meta.dir, "../../src/cli.ts"), "utf-8");

/** 取某段源码首次出现的下标，找不到就让断言给出可读的失败信息 */
function idx(needle: string): number {
  const i = CLI_SRC.indexOf(needle);
  expect(i, `cli.ts 里找不到: ${needle}`).toBeGreaterThan(-1);
  return i;
}

describe("GC 不再在归属复核之前启动", () => {
  test("worktree 启动恢复那段只登记，不直接调 cleanupStaleWorktrees", () => {
    // 登记点在恢复段内
    const register = idx("worktreeCleanupGitRoot = gitRoot;");
    // 真正的调用点只有一处，且在 startWorktreeCleanup 这个延迟启动器里面
    const callSites = CLI_SRC.split("cleanupStaleWorktrees(").length - 1;
    expect(callSites).toBe(1);
    expect(idx("cleanupStaleWorktrees(")).toBeLessThan(register);
    expect(idx("const startWorktreeCleanup")).toBeLessThan(register);
  });

  test("登记 → 归属复核 → 启动 GC，三者顺序固定", () => {
    const register = idx("worktreeCleanupGitRoot = gitRoot;");
    const ownershipCheck = idx("if (shouldAutoEnterWorktree(wt, resumedSessionIdForCleanup)) {");
    const launch = idx("await startWorktreeCleanup();");

    expect(register).toBeLessThan(ownershipCheck);
    expect(ownershipCheck).toBeLessThan(launch);
  });

  test("GC 启动排在「被恢复会话 id 已知」之后（复核的输入）", () => {
    expect(idx("resumedSessionIdForCleanup = session.id;")).toBeLessThan(
      idx("await startWorktreeCleanup();"),
    );
  });
});

describe("持久化 worktree 只在归属复核通过后才 chdir（不再先进后撤）", () => {
  test("启动恢复段只登记候选，不调 enterWorktreeCwd(session.worktreePath)", () => {
    // 旧实现：恢复段直接 enterWorktreeCwd(session.worktreePath)，复核失败再 exitWorktreeCwd。
    // 中间整段启动流程（选择器、-c、restoreSession）都跑在错误的 cwd 里。
    expect(CLI_SRC).not.toContain("await enterWorktreeCwd(session.worktreePath);");
    expect(CLI_SRC).not.toContain("await exitWorktreeCwd(wt.originalCwd);");
    expect(idx("pendingWorktreeRestore = session;")).toBeLessThan(
      idx("worktreeCleanupGitRoot = gitRoot;"),
    );
  });

  test("chdir 在复核放行分支内，且排在会话 id 已知之后", () => {
    const resolved = idx("resumedSessionIdForCleanup = session.id;");
    const check = idx("if (shouldAutoEnterWorktree(wt, resumedSessionIdForCleanup)) {");
    const enter = idx("await enterWorktreeCwd(wt.worktreePath);");
    expect(resolved).toBeLessThan(check);
    expect(check).toBeLessThan(enter);
    expect(enter).toBeLessThan(idx("await startWorktreeCleanup();"));
  });

  test("不进入时不清持久化状态（留给下次 resume 拥有者）", () => {
    const section = CLI_SRC.slice(
      idx("if (shouldAutoEnterWorktree(wt, resumedSessionIdForCleanup)) {"),
      idx("await startBackgroundSessionCleanup();"),
    );
    expect(section).not.toContain("clearWorktreeState(");
  });

  test("回填逻辑会话 id 给后续 enter_worktree 落盘，分叉时不回填", () => {
    expect(CLI_SRC).toContain(
      "const logicalOwnerId = config.forkSession ? undefined : resumedSessionIdForCleanup;",
    );
    expect(idx("setWorktreeOwnerSessionId(logicalOwnerId);")).toBeGreaterThan(
      idx("resumedSessionIdForCleanup = session.id;"),
    );
  });

  test("GC 读的是变量而非恢复期的局部值（否则撤销无效）", () => {
    expect(CLI_SRC).toContain(
      "cleanupStaleWorktrees(worktreeCleanupGitRoot, 30, activeWorktreePathForCleanup)",
    );
  });
});

describe("与会话清理保持同一范式（D3 的先例）", () => {
  test("两个延迟启动器都在归属复核之后依次启动", () => {
    const sessionCleanup = idx("await startBackgroundSessionCleanup();");
    const worktreeCleanup = idx("await startWorktreeCleanup();");
    const ownershipCheck = idx("shouldAutoEnterWorktree(wt, resumedSessionIdForCleanup)");

    expect(ownershipCheck).toBeLessThan(sessionCleanup);
    expect(ownershipCheck).toBeLessThan(worktreeCleanup);
  });

  test("GC 仍是后台 fire-and-forget（改的是启动时机，不是把它变成阻塞步骤）", () => {
    const launcher = CLI_SRC.slice(
      idx("const startWorktreeCleanup"),
      idx("const startBackgroundSessionCleanup"),
    );
    // .then/.catch 形态 = 不 await 内部 promise
    expect(launcher).toContain(".then((n) =>");
    expect(launcher).toContain(".catch(");
    expect(launcher).not.toContain("await cleanupStaleWorktrees");
  });

  test("没有登记过 gitRoot（非 git 目录 / print 模式）时 GC 不跑", () => {
    const launcher = CLI_SRC.slice(
      idx("const startWorktreeCleanup"),
      idx("const startBackgroundSessionCleanup"),
    );
    expect(launcher).toContain("if (!worktreeCleanupGitRoot) return;");
  });
});
