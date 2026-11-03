/**
 * /conflict 命令的展示层：物理路径 + 真冲突/分支分叉分组。
 *
 * 修的是「按逻辑键平铺」的两处误导：
 * 1. 逻辑键是跨 worktree 折叠后的主仓路径，用户看不出这份意图实际在哪个 worktree；
 * 2. 两个 worktree 各改同名文件（物理上互不相干）被报成「⚠ 潜在冲突」并建议
 *    「关闭其他会话」——关会话既不能消除分叉，也解决不了合并时的问题。
 *
 * 判据统一到**物理路径**：同一份磁盘文件被并发写才是真冲突；物理路径互不相同
 * 只是分支分叉，合并回主仓时才可能撞车。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import conflictCommand, {
  groupIntentConflicts,
} from "@sid-code/cli/command/commands/conflict/conflict.ts";
import type { CommandContext } from "@sid-code/cli/command/types.ts";
import type {
  FileIntent,
  FileOperation,
  SessionFileIntents,
} from "@sid-code/core/session/file-intent.ts";
import { clearFileIntent, declareFileIntent } from "@sid-code/core/session/file-intent.ts";

const LOGICAL = "/repo/src/a.ts";

function intent(
  logicalPath: string,
  physicalPath: string | undefined,
  operation: FileOperation = "edit",
): FileIntent {
  return {
    path: logicalPath,
    ...(physicalPath === undefined ? {} : { physicalPath }),
    declaredAt: 1,
    lastAccessAt: Date.now(),
    operation,
  };
}

function session(
  sessionId: string,
  files: Record<string, FileIntent>,
  extra: Partial<SessionFileIntents> = {},
): SessionFileIntents {
  return { sessionId, pid: process.pid, cwd: "/repo", files, ...extra };
}

describe("groupIntentConflicts：真冲突 vs 分支分叉", () => {
  test("两个会话写同一份物理文件 → 真冲突，不进分叉组", () => {
    const groups = groupIntentConflicts({
      a: session("a", { [LOGICAL]: intent(LOGICAL, LOGICAL) }),
      b: session("b", { [LOGICAL]: intent(LOGICAL, LOGICAL, "write") }),
    });
    expect(groups.sameFile).toHaveLength(1);
    expect(groups.sameFile[0]!.physicalPath).toBe(LOGICAL);
    expect(groups.sameFile[0]!.sessionIds.sort()).toEqual(["a", "b"]);
    expect(groups.diverged).toHaveLength(0);
  });

  test("两个 worktree 各改各的副本 → 分支分叉，不算真冲突", () => {
    const a = "/repo/.sid-code/worktrees/d2/src/a.ts";
    const b = "/repo/.sid-code/worktrees/d10/src/a.ts";
    const groups = groupIntentConflicts({
      a: session("a", { [LOGICAL]: intent(LOGICAL, a) }),
      b: session("b", { [LOGICAL]: intent(LOGICAL, b) }),
    });
    expect(groups.sameFile).toHaveLength(0);
    expect(groups.diverged).toHaveLength(1);
    expect(groups.diverged[0]!.logicalPath).toBe(LOGICAL);
    expect(groups.diverged[0]!.copies.map((c) => c.physicalPath).sort()).toEqual([a, b].sort());
  });

  test("混合场景：A+B 同文件冲突 + C 在别的 worktree → 两组各收自己那份，不重复", () => {
    const c = "/repo/.sid-code/worktrees/d10/src/a.ts";
    const groups = groupIntentConflicts({
      a: session("a", { [LOGICAL]: intent(LOGICAL, LOGICAL) }),
      b: session("b", { [LOGICAL]: intent(LOGICAL, LOGICAL) }),
      c: session("c", { [LOGICAL]: intent(LOGICAL, c) }),
    });
    expect(groups.sameFile).toHaveLength(1);
    expect(groups.sameFile[0]!.sessionIds.sort()).toEqual(["a", "b"]);
    expect(groups.diverged).toHaveLength(1);
    // C 是唯一一份独自副本，被收进分叉组；A/B 的物理文件不再重复出现在分叉组
    expect(groups.diverged[0]!.copies).toHaveLength(1);
    expect(groups.diverged[0]!.copies[0]!.sessionId).toBe("c");
  });

  test("只有 read 不进冲突口径（与 checkConflict 的 blockingOperations 同口径）", () => {
    const groups = groupIntentConflicts({
      a: session("a", { [LOGICAL]: intent(LOGICAL, LOGICAL, "read") }),
      b: session("b", { [LOGICAL]: intent(LOGICAL, LOGICAL, "read") }),
    });
    expect(groups.sameFile).toHaveLength(0);
    expect(groups.diverged).toHaveLength(0);
  });

  test("read 与 edit 混在同一物理文件：只有 edit 方计入，不构成双写冲突", () => {
    const groups = groupIntentConflicts({
      a: session("a", { [LOGICAL]: intent(LOGICAL, LOGICAL, "read") }),
      b: session("b", { [LOGICAL]: intent(LOGICAL, LOGICAL, "edit") }),
    });
    expect(groups.sameFile).toHaveLength(0);
    expect(groups.diverged).toHaveLength(0);
  });

  test("旧记录没有 physicalPath 时回退逻辑键（同键视为同一份文件）", () => {
    const groups = groupIntentConflicts({
      a: session("a", { [LOGICAL]: intent(LOGICAL, undefined) }),
      b: session("b", { [LOGICAL]: intent(LOGICAL, undefined) }),
    });
    expect(groups.sameFile).toHaveLength(1);
    expect(groups.sameFile[0]!.physicalPath).toBe(LOGICAL);
    expect(groups.diverged).toHaveLength(0);
  });

  test("单会话不构成任何冲突", () => {
    const groups = groupIntentConflicts({
      a: session("a", { [LOGICAL]: intent(LOGICAL, LOGICAL) }),
    });
    expect(groups.sameFile).toHaveLength(0);
    expect(groups.diverged).toHaveLength(0);
  });
});

describe("/conflict 命令输出", () => {
  let dir: string;
  // 存/恢复原值：bun test 同进程跑多文件，条件 delete 会抹掉 preload 兜底
  const savedConfigDir = process.env.SID_CONFIG_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sid-conflict-cmd-"));
    process.env.SID_CONFIG_DIR = dir;
  });

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = savedConfigDir;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 已被清理 */
    }
  });

  async function run(): Promise<string> {
    const res = await conflictCommand.call("", {} as CommandContext);
    expect(res.type).toBe("text");
    return (res as { value: string }).value;
  }

  /**
   * 直接写意图文件（绕过 declareFileIntent 的 key 推导）。
   *
   * 两个 worktree 各自折叠到同一逻辑键、物理路径不同的记录，只能这样造：
   * `declareFileIntent` 会自己算 realpath + 主仓根，在 tmpdir 里造不出真实 worktree
   * （真建 git worktree 对一条展示命令的测试太重）。读取侧照常走
   * `queryAllFileIntents` 与完整命令渲染，所以覆盖的仍是真实链路。
   */
  function seedIntents(
    sessionId: string,
    files: Record<string, { physicalPath?: string; operation: FileOperation }>,
  ): void {
    const dirPath = join(dir, "file-intents");
    mkdirSync(dirPath, { recursive: true });
    const entries: Record<string, FileIntent> = {};
    const now = Date.now();
    for (const [logicalPath, spec] of Object.entries(files)) {
      entries[logicalPath] = {
        path: logicalPath,
        ...(spec.physicalPath === undefined ? {} : { physicalPath: spec.physicalPath }),
        declaredAt: now,
        lastAccessAt: now,
        operation: spec.operation,
      };
    }
    writeFileSync(
      join(dirPath, `${sessionId}.json`),
      JSON.stringify({ sessionId, pid: process.pid, cwd: "/repo", files: entries }, null, 2),
    );
  }

  test("两个 worktree 各改各的副本 → 报「分支分叉」，不给关闭会话建议", async () => {
    seedIntents("cmd-a", {
      [LOGICAL]: {
        physicalPath: "/repo/.sid-code/worktrees/d2/src/a.ts",
        operation: "edit",
      },
    });
    seedIntents("cmd-b", {
      [LOGICAL]: {
        physicalPath: "/repo/.sid-code/worktrees/d10/src/a.ts",
        operation: "edit",
      },
    });
    const out = await run();
    expect(out).toContain("分支分叉");
    // 分叉不靠关会话解决——旧实现正是在这里建议「关闭其他会话」，属误导
    expect(out).not.toContain("关闭其他会话");
    expect(out).not.toContain("同文件并发");
  });

  test("worktree 里的意图额外显示实际物理路径", async () => {
    const wtPath = "/repo/.sid-code/worktrees/d2/src/a.ts";
    seedIntents("cmd-a", { [LOGICAL]: { physicalPath: wtPath, operation: "edit" } });
    const out = await run();
    expect(out).toContain(`实际路径: ${wtPath}`);
  });

  test("两个会话写同一文件 → 报「同文件并发」并给关闭会话建议", async () => {
    const file = join(dir, "shared.txt");
    declareFileIntent("cmd-a", process.pid, dir, file, "edit");
    declareFileIntent("cmd-b", process.pid, dir, file, "write");
    try {
      const out = await run();
      expect(out).toContain("同文件并发");
      expect(out).toContain("关闭其他会话");
      expect(out).not.toContain("分支分叉");
    } finally {
      clearFileIntent("cmd-a");
      clearFileIntent("cmd-b");
    }
  });

  test("只有一个会话 → 报无冲突，且不出现冲突分组", async () => {
    const file = join(dir, "solo.txt");
    declareFileIntent("cmd-a", process.pid, dir, file, "edit");
    try {
      const out = await run();
      expect(out).toContain("✔ 无冲突");
      expect(out).not.toContain("同文件并发");
      expect(out).not.toContain("分支分叉");
    } finally {
      clearFileIntent("cmd-a");
    }
  });

  test("两个会话都只是读同一文件 → 不报冲突（read 不进冲突口径）", async () => {
    const file = join(dir, "read-only.txt");
    declareFileIntent("cmd-a", process.pid, dir, file, "read");
    declareFileIntent("cmd-b", process.pid, dir, file, "read");
    try {
      const out = await run();
      expect(out).toContain("✔ 无冲突");
      expect(out).not.toContain("同文件并发");
    } finally {
      clearFileIntent("cmd-a");
      clearFileIntent("cmd-b");
    }
  });
});
