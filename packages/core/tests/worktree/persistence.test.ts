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
} from "@sid-code/core/worktree/persistence.ts";
import type { WorktreeSession } from "@sid-code/core/worktree/types.ts";
import { setSessionId } from "@sid-code/core/bootstrap/state.ts";
import { registerSession, unregisterSession } from "@sid-code/core/session/concurrent.ts";
import { sanitizeProjectKey } from "@sid-code/core/memory/paths.ts";

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
 * 背景：enter 落盘的状态只有显式 exit_worktree 会清，关终端 / /quit / 任务做完
 * 都留着它。启动恢复若只问「目录还在不在」，就会把新会话 chdir 进一个
 * 已经没人用的 worktree。判定必须看拥有它的会话还活着没有。
 *
 * 会话 jsonl 落在 SID_CONFIG_DIR 下，而本文件的 beforeEach 只建了 gitRoot 临时目录。
 * 这里单独把配置根指到 root 内，避免碰用户真实的 ~/.sid-code，用完按原值恢复
 * （同进程内无条件 delete 会把预载的兜底一起抹掉）。
 */
describe("shouldAutoEnterWorktree 归属判定", () => {
  let prevConfigDir: string | undefined;
  const ownerId = "20260925-220507-8628cad7";

  beforeEach(() => {
    prevConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = join(root, "sid-home");
  });

  afterEach(() => {
    unregisterSession(ownerId);
    setSessionId("");
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
  });

  /** 在隔离的配置根下写一份会话 jsonl，返回其路径 */
  function writeSession(id: string, lines: string[]): void {
    const dir = join(root, "sid-home", "sessions", sanitizeProjectKey(root));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), lines.join("\n") + "\n");
  }

  function startLine(id: string): string {
    return JSON.stringify({ type: "session_start", sessionId: id, cwd: root });
  }

  it("拥有者会话已写 session_end：普通启动不自动进入", () => {
    writeSession(ownerId, [startLine(ownerId), JSON.stringify({ type: "session_end" })]);
    expect(shouldAutoEnterWorktree({ sessionId: ownerId })).toBe(false);
  });

  it("session_end 之后又续写：会话还活着，照常进入", () => {
    writeSession(ownerId, [
      startLine(ownerId),
      JSON.stringify({ type: "session_end" }),
      JSON.stringify({ type: "user_message" }),
    ]);
    expect(shouldAutoEnterWorktree({ sessionId: ownerId })).toBe(true);
  });

  it("尾部是半行损坏：不推翻前面读到的 session_end", () => {
    writeSession(ownerId, [startLine(ownerId), JSON.stringify({ type: "session_end" }), "{broken"]);
    expect(shouldAutoEnterWorktree({ sessionId: ownerId })).toBe(false);
  });

  it("注册表里 pid 还活着：即使 jsonl 已是 session_end 也不放弃", () => {
    writeSession(ownerId, [startLine(ownerId), JSON.stringify({ type: "session_end" })]);
    registerSession({
      sessionId: ownerId,
      pid: process.pid,
      kind: "interactive",
      cwd: root,
      startedAt: 1,
    });
    expect(shouldAutoEnterWorktree({ sessionId: ownerId })).toBe(true);
  });

  it("本次就是 resume 拥有者：即使会话已结束也进入", () => {
    writeSession(ownerId, [startLine(ownerId), JSON.stringify({ type: "session_end" })]);
    expect(shouldAutoEnterWorktree({ sessionId: ownerId }, ownerId)).toBe(true);
    // resume 的是别的会话 → 不进入
    expect(shouldAutoEnterWorktree({ sessionId: ownerId }, "20260101-000000-deadbeef")).toBe(false);
  });

  it("没有 sessionId 的旧状态：无从判断，保持原行为（进入）", () => {
    expect(shouldAutoEnterWorktree({})).toBe(true);
    expect(shouldAutoEnterWorktree({ sessionId: "" })).toBe(true);
  });

  it("jsonl 不存在（崩溃没落盘）：不把「没查到」当成「已结束」", () => {
    expect(shouldAutoEnterWorktree({ sessionId: "no-such-session" })).toBe(true);
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
