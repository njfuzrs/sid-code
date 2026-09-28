/**
 * N10 门禁：自动清理必须保护**其它活着的进程**正在使用的会话。
 *
 * 缺陷形态（P0，实测已可复现）：`currentSessionId` / `protectedSessionIds` 两道保护都由
 * 调用方从**自己的** config / resume 目标传入，对「隔壁那个 sid-code 正在续写哪个会话」
 * 一无所知；而清理扫的是**全局** sessions/ 目录。于是进程 B 启动时的自动清理会把
 * 进程 A 正在续写的会话文件 unlinkSync 掉，**且 A 侧全程无感** ——
 * 它的写缓冲照常 append 到一个已被删除的 inode 上，用户看不到任何报错，
 * 直到下次想恢复时才发现整个会话没了。
 *
 * 修法是复用已有的活跃会话表（~/.sid-code/active-sessions/，本就为"谁还活着"而存在，
 * 且自带 PID 探活 + stale 清理），并补一个 `logicalSessionId` 字段解决
 * 「resume 时活跃表登记的是本进程新 id，而磁盘上在写的是旧 id」这个错位。
 *
 * 每条用例都带**反向自证**：不受保护的过期会话必须照删，否则"清理什么都没干"
 * 也能让保护类断言变绿。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, existsSync, writeFileSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { cleanupExpiredSessions } from "@sid-code/core/session/cleanup.ts";
import {
  registerSession,
  registerLogicalSessionId,
  unregisterSession,
  listActiveSessions,
} from "@sid-code/core/session/concurrent.ts";
import { sidPaths } from "@sid-code/core/config/paths.ts";

/** 远早于 maxAge/minRetention 的时间戳，保证固件"够老可删"。 */
const OLD_TS = "2000-01-01T00:00:00.000Z";
const OLD_MTIME_SEC = new Date(OLD_TS).getTime() / 1000;

describe("N10：跨进程清理保护", () => {
  let testDir: string;
  let origHome: string | undefined;
  let origConfigDir: string | undefined;
  const registered: string[] = [];

  beforeEach(() => {
    testDir = join(tmpdir(), `sid-n10-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, ".sid-code", "sessions"), { recursive: true });
    origHome = process.env.HOME;
    process.env.HOME = testDir;
    origConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = join(testDir, ".sid-code");
    registered.length = 0;
  });

  afterEach(() => {
    for (const id of registered) {
      try {
        unregisterSession(id);
      } catch {
        /* ignore */
      }
    }
    process.env.HOME = origHome;
    if (origConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = origConfigDir;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  /** 造一个"够老可删"的合法会话文件。 */
  function writeOldSession(sessionId: string): string {
    const file = join(sidPaths.sessions(), `${sessionId}.jsonl`);
    mkdirSync(sidPaths.sessions(), { recursive: true });
    writeFileSync(
      file,
      [
        JSON.stringify({
          type: "session_start",
          version: "3.0",
          sessionId,
          model: "m",
          provider: "p",
          cwd: "/tmp",
          timestamp: OLD_TS,
          uuid: "u0",
          parentUuid: null,
        }),
        JSON.stringify({
          type: "user_message",
          message: { role: "user", content: [{ type: "text", text: "历史内容" }] },
          timestamp: OLD_TS,
          uuid: "u1",
          parentUuid: "u0",
        }),
        JSON.stringify({
          type: "assistant_message",
          message: { role: "assistant", content: [{ type: "text", text: "回复" }] },
          timestamp: OLD_TS,
          uuid: "u2",
          parentUuid: "u1",
        }),
      ].join("\n") + "\n",
    );
    utimesSync(file, OLD_MTIME_SEC, OLD_MTIME_SEC);
    return file;
  }

  /** 模拟「另一个活着的进程」注册进活跃表。PID 用本进程的（探活必须为真）。 */
  function registerOtherProcess(sessionId: string, logicalSessionId?: string): void {
    registerSession({
      sessionId,
      pid: process.pid, // 探活为真 = "这个进程还活着"
      kind: "interactive",
      cwd: "/tmp",
      startedAt: Date.now(),
    });
    registered.push(sessionId);
    if (logicalSessionId) registerLogicalSessionId(sessionId, logicalSessionId);
  }

  test("进程 A 正在用的会话不被进程 B 的清理删除（反向自证：无人用的照删）", async () => {
    const inUse = writeOldSession("20000101-000000-inuse01");
    const orphan = writeOldSession("20000101-000000-orphan1");

    // 进程 A：正跑着这个会话（未 resume ⇒ sessionId 自己就是在写的那个）。
    registerOtherProcess("20000101-000000-inuse01");

    // 进程 B 的自动清理：它只知道自己的新 id，对 A 一无所知。
    await cleanupExpiredSessions(
      {} as any,
      { enabled: true, maxAge: "1h", minRetention: "1h" },
      "process-B-brand-new-id",
    );

    expect(existsSync(inUse)).toBe(true);
    // 反向自证：清理确实在干活
    expect(existsSync(orphan)).toBe(false);
  });

  test("resume 场景：被续写的旧 id 受保护（活跃表里登记的是本进程新 id）", async () => {
    const resumed = writeOldSession("20000101-000000-resumed");
    const orphan = writeOldSession("20000101-000000-orphan2");

    // 进程 A 恢复了旧会话：活跃表 sessionId = 本进程新 id，
    // 而磁盘上真正在被续写的是 logicalSessionId 那个旧 id。
    registerOtherProcess("process-A-new-id", "20000101-000000-resumed");

    await cleanupExpiredSessions(
      {} as any,
      { enabled: true, maxAge: "1h", minRetention: "1h" },
      "process-B-brand-new-id",
    );

    // 修复前：活跃表里查不到这个旧 id ⇒ 它满足淘汰条件就被删，而 A 侧全程无感。
    expect(existsSync(resumed)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
  });

  test("进程已死（stale 注册）⇒ 保护不生效，文件照删", async () => {
    const stale = writeOldSession("20000101-000000-stale01");

    // 用一个几乎不可能存在的 PID 模拟"进程已死"。
    registerSession({
      sessionId: "20000101-000000-stale01",
      pid: 2 ** 22, // 远超常见 pid_max，探活为假
      kind: "interactive",
      cwd: "/tmp",
      startedAt: Date.now(),
    });
    registered.push("20000101-000000-stale01");

    // listActiveSessions 会顺带清掉 stale 条目，这里先确认它确实不算活跃。
    expect(listActiveSessions().map((e) => e.sessionId)).not.toContain("20000101-000000-stale01");

    await cleanupExpiredSessions(
      {} as any,
      { enabled: true, maxAge: "1h", minRetention: "1h" },
      "process-B-brand-new-id",
    );

    // 关键：保护只覆盖**活着的**进程，否则崩溃残留会永久钉住一堆过期会话。
    expect(existsSync(stale)).toBe(false);
  });

  test("registerLogicalSessionId 幂等，且对未注册条目安全无操作", () => {
    // 未注册就调用：不抛错、不创建条目。
    registerLogicalSessionId("never-registered", "whatever");
    expect(listActiveSessions().map((e) => e.sessionId)).not.toContain("never-registered");

    registerOtherProcess("proc-x", "logical-y");
    registerLogicalSessionId("proc-x", "logical-y"); // 重复调用
    const entries = listActiveSessions().filter((e) => e.sessionId === "proc-x");
    expect(entries).toHaveLength(1);
    expect(entries[0].logicalSessionId).toBe("logical-y");
  });
});
