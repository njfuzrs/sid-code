/**
 * 会话清理测试
 *
 * 覆盖本次修复的两个关键行为：
 * - Bug1：getAllSessionFiles 能扫到 jsonl 会话（此前只扫 .json，jsonl 永不被清理）
 * - P0：删除会话时对称清理 trajectories/sessions/{id}/（此前沦为孤儿数据）
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { SessionStore } from "../../src/session/store.ts";
import { getAllSessionFiles } from "../../src/session/utils.ts";
import { cleanupExpiredSessions } from "../../src/session/cleanup.ts";
import { sidPaths } from "../../src/config/paths.ts";

describe("会话清理与 jsonl 列表", () => {
  let testDir: string;
  let origHome: string | undefined;
  let origConfigDir: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `sid-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, ".sid-code", "sessions"), { recursive: true });
    origHome = process.env.HOME;
    process.env.HOME = testDir;
    origConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = join(testDir, ".sid-code");
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (origConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = origConfigDir;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("Bug1: getAllSessionFiles 能扫到 jsonl 会话", async () => {
    // 写一个真实的 jsonl 会话（多行事件流）
    const store = new SessionStore();
    store.startSession("jsonl-1", "m", "p", "/cwd");
    store.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }] });
    store.appendMessage({ role: "assistant", content: [{ type: "text", text: "hi" }] });

    const sessionDir = sidPaths.sessions();
    const entries = await getAllSessionFiles(sessionDir);

    // 此前 jsonl 会被 JSON.parse 整体解析失败 → 全部判为损坏(null)
    const valid = entries.filter((e) => e.sessionInfo !== null);
    expect(valid.length).toBe(1);
    expect(valid[0].sessionInfo!.id).toBe("jsonl-1");
    expect(valid[0].sessionInfo!.messageCount).toBe(2);
    // file 字段不应残留 jsonl 的尾字符 "l"
    expect(valid[0].sessionInfo!.file).toBe("jsonl-1");
  });

  test("P0: 清理 jsonl 会话时对称删除 trajectory 目录", async () => {
    // 1) 造一个"过期"的 jsonl 会话
    const store = new SessionStore();
    store.startSession("old-1", "m", "p", "/cwd");
    store.appendMessage({ role: "user", content: [{ type: "text", text: "x" }] });
    store.endSession(0, 1);

    // 把 updatedAt 改老：直接重写 jsonl 时间戳为很久以前
    const sessionFile = join(sidPaths.sessions(), "old-1.jsonl");
    const oldTs = "2000-01-01T00:00:00.000Z";
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session_start", sessionId: "old-1", model: "m", provider: "p", cwd: "/c", timestamp: oldTs }),
        JSON.stringify({ type: "user_message", message: { role: "user", content: [{ type: "text", text: "x" }] }, timestamp: oldTs }),
      ].join("\n") + "\n"
    );

    // 2) 造对应的 trajectory 目录
    const trajDir = join(sidPaths.trajectories(), "sessions", "old-1");
    mkdirSync(trajDir, { recursive: true });
    writeFileSync(join(trajDir, "raw.jsonl"), "{}\n");
    expect(existsSync(trajDir)).toBe(true);

    // 3) 触发清理（maxAge 极短，强制判过期）
    const result = await cleanupExpiredSessions(
      {} as any,
      { enabled: true, maxAge: "1h", minRetention: "1h", maxCount: 1 },
    );

    // 会话文件被删
    expect(existsSync(sessionFile)).toBe(false);
    // trajectory 目录被对称清理
    expect(existsSync(trajDir)).toBe(false);
    expect(result.deleted).toBeGreaterThanOrEqual(1);
  });

  test("P0: 不存在 trajectory 目录时清理不报错", async () => {
    const store = new SessionStore();
    store.startSession("no-traj", "m", "p", "/cwd");
    const sessionFile = join(sidPaths.sessions(), "no-traj.jsonl");
    const oldTs = "2000-01-01T00:00:00.000Z";
    writeFileSync(
      sessionFile,
      JSON.stringify({ type: "session_start", sessionId: "no-traj", model: "m", provider: "p", cwd: "/c", timestamp: oldTs }) + "\n" +
      JSON.stringify({ type: "user_message", message: { role: "user", content: [{ type: "text", text: "x" }] }, timestamp: oldTs }) + "\n"
    );

    const result = await cleanupExpiredSessions(
      {} as any,
      { enabled: true, maxAge: "1h", minRetention: "1h", maxCount: 1 },
    );
    // 不抛异常即可，会话仍被删
    expect(existsSync(sessionFile)).toBe(false);
    expect(result.failed).toBe(0);
  });
});
