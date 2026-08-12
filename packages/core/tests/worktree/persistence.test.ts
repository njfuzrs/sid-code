/**
 * Worktree session 持久化与 resume 单测（P0-1 / P1-9 / D10）
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  saveWorktreeState,
  clearWorktreeState,
  restoreWorktreeSession,
  sessionConfigPath,
  removeSessionConfig,
} from "@sid-code/core/worktree/persistence.ts";
import type { WorktreeSession } from "@sid-code/core/worktree/types.ts";

let root: string;

function makeSession(root: string, wtPath: string): WorktreeSession {
  return {
    originalCwd: root,
    worktreePath: wtPath,
    worktreeName: "brave-eagle-1",
    sessionId: "sess-1",
    worktreeBranch: "worktree-brave-eagle-1",
    originalBranch: "main",
    originalHeadCommit: "abc123",
    creationDurationMs: 42, // ephemeral，不应被持久化
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sid-persist-"));
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

describe("saveWorktreeState / restoreWorktreeSession", () => {
  it("保存后能恢复，且剥离 ephemeral 字段", () => {
    const wtPath = join(root, ".sid-code", "worktrees", "brave-eagle-1");
    mkdirSync(wtPath, { recursive: true });
    writeFileSync(join(wtPath, ".git"), "gitdir: /fake\n");

    saveWorktreeState(makeSession(root, wtPath), 1000);

    // 持久化文件应存在
    expect(existsSync(sessionConfigPath(root))).toBe(true);

    const { session, cleared } = restoreWorktreeSession(root);
    expect(cleared).toBe(false);
    expect(session).not.toBeNull();
    expect(session!.worktreeName).toBe("brave-eagle-1");
    expect(session!.worktreeBranch).toBe("worktree-brave-eagle-1");
    // D10：ephemeral 字段不应恢复
    expect(session!.creationDurationMs).toBeUndefined();
  });

  it("worktree 目录不存在时清除状态（P1-9）", () => {
    const wtPath = join(root, ".sid-code", "worktrees", "gone");
    saveWorktreeState(makeSession(root, wtPath), 1000);

    // 目录从未创建 → restore 应清除并返回 cleared
    const { session, cleared } = restoreWorktreeSession(root);
    expect(session).toBeNull();
    expect(cleared).toBe(true);

    // 状态已清除
    const second = restoreWorktreeSession(root);
    expect(second.cleared).toBe(false);
    expect(second.session).toBeNull();
  });

  it("无持久化状态时返回 null 且不报 cleared", () => {
    const { session, cleared } = restoreWorktreeSession(root);
    expect(session).toBeNull();
    expect(cleared).toBe(false);
  });

  it("clearWorktreeState 移除状态", () => {
    const wtPath = join(root, ".sid-code", "worktrees", "x");
    mkdirSync(wtPath, { recursive: true });
    writeFileSync(join(wtPath, ".git"), "gitdir: /fake\n");
    saveWorktreeState(makeSession(root, wtPath), 1000);
    clearWorktreeState(root);
    const { session } = restoreWorktreeSession(root);
    expect(session).toBeNull();
  });

  it("损坏的 session-config 容错（不抛异常）", () => {
    const p = sessionConfigPath(root);
    mkdirSync(join(root, ".sid-code"), { recursive: true });
    writeFileSync(p, "{ this is not json");
    const { session } = restoreWorktreeSession(root);
    expect(session).toBeNull();
  });

  it("removeSessionConfig 删除整个文件", () => {
    const wtPath = join(root, ".sid-code", "worktrees", "x");
    mkdirSync(wtPath, { recursive: true });
    writeFileSync(join(wtPath, ".git"), "gitdir: /fake\n");
    saveWorktreeState(makeSession(root, wtPath), 1000);
    expect(existsSync(sessionConfigPath(root))).toBe(true);
    removeSessionConfig(root);
    expect(existsSync(sessionConfigPath(root))).toBe(false);
  });
});
