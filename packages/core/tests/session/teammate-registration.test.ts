/**
 * P1-2：teammate 会话注册的探活判据。
 *
 * 普通会话按 PID 探活；teammate 与宿主同进程，PID 恒活着，
 * 改看其后台任务是否仍在注册表且未终态。覆盖：运行中可见、
 * 终态算 stale、无 taskId 算 stale、普通会话不受影响。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  registerSession,
  unregisterSession,
  listActiveSessions,
} from "@sid-code/core/session/concurrent.ts";
import { registerTask, clearAllTasks } from "@sid-code/core/task/registry.ts";
import type { LocalAgentTaskState } from "@sid-code/core/task/types.ts";

let dir: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sid-teammate-sess-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = join(dir, ".sid-code");
  clearAllTasks();
});

afterEach(() => {
  clearAllTasks();
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

function agentTask(id: string, status: LocalAgentTaskState["status"]): LocalAgentTaskState {
  const t: LocalAgentTaskState = {
    id,
    type: "local_agent",
    status,
    description: "member",
    startTime: Date.now(),
    outputFile: "/tmp/x",
    outputOffset: 0,
    notified: false,
    agentType: "general",
    prompt: "do",
    isBackgrounded: true,
    progress: { toolUseCount: 0, tokenCount: 0, recentActivities: [] },
  };
  registerTask(t);
  return t;
}

describe("teammate 会话探活", () => {
  it("任务运行中时 /ps 能看到 teammate 会话及团队名", () => {
    agentTask("task-1", "running");
    registerSession({
      sessionId: "teammate-alpha-alice",
      pid: process.pid,
      kind: "teammate",
      cwd: "/work",
      startedAt: Date.now(),
      team: "alpha",
      taskId: "task-1",
    });
    const list = listActiveSessions();
    const mine = list.find((s) => s.sessionId === "teammate-alpha-alice");
    expect(mine).toBeDefined();
    expect(mine?.kind).toBe("teammate");
    expect(mine?.team).toBe("alpha");
  });

  it("任务已终态时 teammate 会话算 stale 并被清理", () => {
    agentTask("task-2", "completed");
    registerSession({
      sessionId: "teammate-alpha-bob",
      pid: process.pid,
      kind: "teammate",
      cwd: "/work",
      startedAt: Date.now(),
      team: "alpha",
      taskId: "task-2",
    });
    const list = listActiveSessions();
    expect(list.some((s) => s.sessionId === "teammate-alpha-bob")).toBe(false);
  });

  it("没有 taskId 的 teammate 条目算 stale（无法判断存活）", () => {
    registerSession({
      sessionId: "teammate-alpha-carol",
      pid: process.pid,
      kind: "teammate",
      cwd: "/work",
      startedAt: Date.now(),
      team: "alpha",
    });
    expect(listActiveSessions().some((s) => s.sessionId === "teammate-alpha-carol")).toBe(false);
  });

  it("普通会话仍按 PID 探活，不受 teammate 规则影响", () => {
    registerSession({
      sessionId: "main-sess",
      pid: process.pid,
      kind: "interactive",
      cwd: "/work",
      startedAt: Date.now(),
    });
    expect(listActiveSessions().some((s) => s.sessionId === "main-sess")).toBe(true);
    unregisterSession("main-sess");
    expect(listActiveSessions().some((s) => s.sessionId === "main-sess")).toBe(false);
  });
});
