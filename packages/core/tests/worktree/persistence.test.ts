/**
 * Worktree session 持久化与 resume 单测（P0-1 / P1-9 / D10）
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  saveWorktreeState,
  clearWorktreeState,
  restoreWorktreeSession,
  sessionConfigPath,
  removeSessionConfig,
  shouldAutoEnterWorktree,
  setWorktreeOwnerSessionId,
} from "@sid-code/core/worktree/persistence.ts";
import type { WorktreeSession } from "@sid-code/core/worktree/types.ts";
import { setSessionId } from "@sid-code/core/bootstrap/state.ts";

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

/**
 * 归属判定（shouldAutoEnterWorktree）。
 *
 * 背景：enter 落盘的状态只有显式 exit_worktree 会清，关终端 / /quit / kill 都留着它。
 * 旧判据「拥有者 jsonl 最后一条不是 session_end 就当崩溃、照常进入」在真实数据上
 * 近半数会话命中（23 个里 11 个没有 session_end），普通启动被成批 chdir 进别人的
 * worktree。新判据只问一件事：本次接续的是不是拥有者——与退出路径写没写成功无关。
 */
describe("shouldAutoEnterWorktree 归属判定", () => {
  const ownerId = "20260925-220507-8628cad7";

  afterEach(() => {
    setSessionId("");
    setWorktreeOwnerSessionId(undefined);
  });

  it("普通启动（没有接续任何会话）：不进入", () => {
    expect(shouldAutoEnterWorktree({ sessionId: ownerId })).toBe(false);
    expect(shouldAutoEnterWorktree({ sessionId: ownerId }, undefined)).toBe(false);
  });

  it("接续的正是拥有者：进入", () => {
    expect(shouldAutoEnterWorktree({ sessionId: ownerId }, ownerId)).toBe(true);
  });

  it("接续的是别的会话：不进入", () => {
    expect(shouldAutoEnterWorktree({ sessionId: ownerId }, "20260101-000000-deadbeef")).toBe(false);
  });

  it("没有 sessionId 的旧状态：证明不了归属，不进入", () => {
    expect(shouldAutoEnterWorktree({})).toBe(false);
    expect(shouldAutoEnterWorktree({ sessionId: "" })).toBe(false);
    // 空串不能与「未接续」的空值互相匹配
    expect(shouldAutoEnterWorktree({ sessionId: "" }, "")).toBe(false);
  });

  it("判定不碰磁盘：判 false 后持久化状态原样保留，供下次 resume 拥有者", () => {
    const wtPath = join(root, ".sid-code", "worktrees", "brave-eagle-1");
    mkdirSync(wtPath, { recursive: true });
    writeFileSync(join(wtPath, ".git"), "gitdir: /fake\n");
    saveWorktreeState({ ...makeSession(root, wtPath), sessionId: ownerId }, 1000);

    const { session } = restoreWorktreeSession(root);
    expect(shouldAutoEnterWorktree(session!)).toBe(false);
    expect(restoreWorktreeSession(root).session?.sessionId).toBe(ownerId);
  });

  it("saveWorktreeState 带上当前会话 id，restore 读得回来", () => {
    const wtPath = join(root, ".sid-code", "worktrees", "brave-eagle-1");
    mkdirSync(wtPath, { recursive: true });
    writeFileSync(join(wtPath, ".git"), "gitdir: /fake\n");

    setSessionId(ownerId);
    const session = makeSession(root, wtPath);
    session.sessionId = ""; // 调用方没给，必须从全局状态回退
    saveWorktreeState(session, 1000);

    const { session: restored } = restoreWorktreeSession(root);
    expect(restored).not.toBeNull();
    expect(restored!.sessionId).toBe(ownerId);
  });

  it("续写旧会话时落盘逻辑会话 id，而不是本进程新生成的 id", () => {
    const wtPath = join(root, ".sid-code", "worktrees", "brave-eagle-1");
    mkdirSync(wtPath, { recursive: true });
    writeFileSync(join(wtPath, ".git"), "gitdir: /fake\n");

    setSessionId("20261010-120000-newproc0"); // resume 时进程 id 恒是新的
    setWorktreeOwnerSessionId(ownerId); // cli 在恢复目标确定后回填
    const session = makeSession(root, wtPath);
    session.sessionId = "";
    saveWorktreeState(session, 1000);

    const { session: restored } = restoreWorktreeSession(root);
    expect(restored!.sessionId).toBe(ownerId);
    // 下次 --resume ownerId 能对上
    expect(shouldAutoEnterWorktree(restored!, ownerId)).toBe(true);
  });

  it("全局状态也没有会话 id：落盘不写 sessionId 字段（旧形态）", () => {
    const wtPath = join(root, ".sid-code", "worktrees", "brave-eagle-1");
    mkdirSync(wtPath, { recursive: true });
    writeFileSync(join(wtPath, ".git"), "gitdir: /fake\n");

    setSessionId("");
    const session = makeSession(root, wtPath);
    session.sessionId = "";
    saveWorktreeState(session, 1000);

    const raw = JSON.parse(readFileSync(sessionConfigPath(root), "utf-8"));
    expect(raw.activeWorktreeSession.sessionId).toBeUndefined();
  });
});
