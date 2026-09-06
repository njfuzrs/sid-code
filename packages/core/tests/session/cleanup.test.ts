/**
 * 会话清理测试
 *
 * 覆盖本次修复的两个关键行为：
 * - Bug1：getAllSessionFiles 能扫到 jsonl 会话（此前只扫 .json，jsonl 永不被清理）
 * - P0：删除会话时对称清理 trajectories/sessions/{id}/（此前沦为孤儿数据）
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join, dirname } from "path";
import { mkdirSync, rmSync, existsSync, writeFileSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { SessionStore } from "@sid-code/core/session/store.ts";
import { getAllSessionFiles } from "@sid-code/core/session/utils.ts";
import { cleanupExpiredSessions } from "@sid-code/core/session/cleanup.ts";
import { sidPaths } from "@sid-code/core/config/paths.ts";

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
        JSON.stringify({
          type: "session_start",
          sessionId: "old-1",
          model: "m",
          provider: "p",
          cwd: "/c",
          timestamp: oldTs,
        }),
        JSON.stringify({
          type: "user_message",
          message: { role: "user", content: [{ type: "text", text: "x" }] },
          timestamp: oldTs,
        }),
      ].join("\n") + "\n",
    );

    // 2) 造对应的 trajectory 目录
    const trajDir = join(sidPaths.trajectories(), "sessions", "old-1");
    mkdirSync(trajDir, { recursive: true });
    writeFileSync(join(trajDir, "raw.jsonl"), "{}\n");
    expect(existsSync(trajDir)).toBe(true);

    // 3) 触发清理（maxAge 极短，强制判过期）
    const result = await cleanupExpiredSessions({} as any, {
      enabled: true,
      maxAge: "1h",
      minRetention: "1h",
      maxCount: 1,
    });

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
      JSON.stringify({
        type: "session_start",
        sessionId: "no-traj",
        model: "m",
        provider: "p",
        cwd: "/c",
        timestamp: oldTs,
      }) +
        "\n" +
        JSON.stringify({
          type: "user_message",
          message: { role: "user", content: [{ type: "text", text: "x" }] },
          timestamp: oldTs,
        }) +
        "\n",
    );

    const result = await cleanupExpiredSessions({} as any, {
      enabled: true,
      maxAge: "1h",
      minRetention: "1h",
      maxCount: 1,
    });
    // 不抛异常即可，会话仍被删
    expect(existsSync(sessionFile)).toBe(false);
    expect(result.failed).toBe(0);
  });
});

/**
 * D3 / D4：清理的两条保护缺口。
 *
 * 两条缺陷共享一个后果形态：**用户的会话历史被静默删掉**，且清理侧零报错
 * （`.catch()` 只在 debug 时记日志），用户只会觉得"怎么少了个会话"。
 */
describe("D3/D4：清理的保护边界", () => {
  let testDir: string;
  let origHome: string | undefined;
  let origConfigDir: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `sid-cleanup-p0-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  const OLD_TS = "2000-01-01T00:00:00.000Z";

  /** 写一个"很旧"的合法 jsonl 会话（够老，不受 minRetention 保护）。 */
  function writeOldSession(id: string): string {
    const file = join(sidPaths.sessions(), `${id}.jsonl`);
    writeFileSync(
      file,
      [
        JSON.stringify({
          type: "session_start",
          sessionId: id,
          model: "m",
          provider: "p",
          cwd: "/c",
          timestamp: OLD_TS,
        }),
        JSON.stringify({
          type: "user_message",
          message: { role: "user", content: [{ type: "text", text: "历史内容" }] },
          timestamp: OLD_TS,
        }),
      ].join("\n") + "\n",
    );
    return file;
  }

  /**
   * D3：**被恢复的会话必须免于清理。**
   *
   * 根因是「逻辑会话 id ≠ 进程会话 id」：`currentSessionId` 传的恒是本进程新生成的 id，
   * 而被恢复会话用的是旧 id —— 保护名单里根本没有它。启动时自动清理是 fire-and-forget，
   * 与 await 的 restoreSession 并发，删在读之前则用户历史永久消失。
   *
   * 判据刻意分两个断言：受保护的那个必须活着，**同时**另一个同样过期的必须真被删 ——
   * 否则「清理什么都没干」也能让第一个断言变绿（假绿）。
   */
  test("D3：protectedSessionIds 里的会话不被清理（同期其他过期会话照删）", async () => {
    const protectedFile = writeOldSession("resumed-old");
    const otherFile = writeOldSession("other-old");

    const result = await cleanupExpiredSessions(
      {} as any,
      { enabled: true, maxAge: "1h", minRetention: "1h", maxCount: 1 },
      "brand-new-process-id", // 进程新 id：它对应的文件都还不存在，保护它毫无意义
      ["resumed-old"], // 真正需要保护的：被恢复会话的旧 id
    );

    expect(existsSync(protectedFile)).toBe(true);
    // 反向自证：清理确实在工作（否则上一条断言是假绿）
    expect(existsSync(otherFile)).toBe(false);
    expect(result.deletedIds).not.toContain("resumed-old");
  });

  /**
   * D4：**空会话不是「损坏文件」，不能被无条件删除。**
   *
   * `sessionInfo: null` 有 6 种成因，其中「空会话」「子代理会话」明确不是损坏，
   * 「读文件抛异常」可能是瞬时故障。旧实现把这个信号一律当成「可以删」，
   * 且走的是一条**绕过 minRetention / currentSessionId / maxAge / maxCount 全部保护**的旁路。
   */
  test("D4：空会话（无 user/assistant 消息）不被当成损坏文件删除", async () => {
    const file = join(sidPaths.sessions(), "empty-session.jsonl");
    writeFileSync(
      file,
      JSON.stringify({
        type: "session_start",
        sessionId: "empty-session",
        model: "m",
        provider: "p",
        cwd: "/c",
        timestamp: OLD_TS,
      }) + "\n",
    );

    await cleanupExpiredSessions({} as any, {
      enabled: true,
      maxAge: "1h",
      minRetention: "1h",
      maxCount: 1,
    });

    expect(existsSync(file)).toBe(true);
  });

  /**
   * D4：**真损坏的文件也要过 minRetention。**
   *
   * minRetention 是防误删的最后兜底，而「刚写到一半的会话」被并发读到半行时
   * 恰好呈现为损坏 —— 与 D3 的竞争窗口叠加时，这会让一个**完全健康**的会话被删掉。
   * 刚写出的损坏文件（mtime = now）必须留着。
   */
  test("D4：minRetention 内的损坏文件不被删除", async () => {
    const file = join(sidPaths.sessions(), "corrupt-fresh.jsonl");
    writeFileSync(file, "{ 这不是合法 json\n");

    await cleanupExpiredSessions({} as any, {
      enabled: true,
      maxAge: "1h",
      minRetention: "1d", // 文件刚写出，落在保留期内
      maxCount: 1,
    });

    expect(existsSync(file)).toBe(true);
  });

  /**
   * D4 的另一侧：**真损坏且已过最小保留期的文件仍然要被清掉。**
   *
   * 缺了这条，上面两个断言可以靠「干脆不删任何损坏文件」变绿 ——
   * 那是把一个缺陷换成另一个（垃圾永久堆积）。
   */
  test("D4：过了 minRetention 的真损坏文件仍被清理", async () => {
    const file = join(sidPaths.sessions(), "corrupt-old.jsonl");
    writeFileSync(file, "{ 这不是合法 json\n");
    // 把 mtime 推到很久以前，跳出 minRetention
    const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    utimesSync(file, past, past);

    await cleanupExpiredSessions({} as any, {
      enabled: true,
      maxAge: "1h",
      minRetention: "1d",
      maxCount: 1,
    });

    expect(existsSync(file)).toBe(false);
  });
});

/**
 * D7 / D8：**会话被删除时，按会话 id 分文件/分目录的「兄弟存储」必须一起回收。**
 *
 * 缺陷形态：`deleteSessionArtifacts()` 清了 jsonl 本体 / summaries / sidechain / trajectories
 * 四样，漏了 `checkpoints/<id>/`（实测 27/68 孤儿，40%）与 `progress/<id>.md`（114/196，58%）。
 *
 * 为什么别的路径兜不住：三条既有清理路径（会话清理 / CheckpointManager.cleanupOldSessions /
 * startup-housekeeping）**没有一条以「会话文件已不存在」为判据**，全是 mtime 超期或总量 LRU ——
 * 所以「够新的孤儿」永远留着，孤儿是必然结果不是偶发。
 *
 * 每条断言都配了反向自证（另一个会话的同类存储必须活着），否则「helper 把整个
 * checkpoints/ 根目录删了」这种更糟的实现也能让断言变绿。
 */
describe("D7/D8：兄弟存储的对称清理", () => {
  let testDir: string;
  let origHome: string | undefined;
  let origConfigDir: string | undefined;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `sid-cleanup-sib-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
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

  const OLD_TS = "2000-01-01T00:00:00.000Z";

  function writeOldSession(id: string): string {
    const file = join(sidPaths.sessions(), `${id}.jsonl`);
    writeFileSync(
      file,
      [
        JSON.stringify({
          type: "session_start",
          sessionId: id,
          model: "m",
          provider: "p",
          cwd: "/c",
          timestamp: OLD_TS,
        }),
        JSON.stringify({
          type: "user_message",
          message: { role: "user", content: [{ type: "text", text: "历史内容" }] },
          timestamp: OLD_TS,
        }),
      ].join("\n") + "\n",
    );
    return file;
  }

  /** 造 checkpoints/<id>/index.json —— 真实结构里它内联着改动前的用户源码全文。 */
  function writeCheckpointDir(id: string): string {
    const dir = sidPaths.checkpoints(id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "index.json"),
      JSON.stringify({ sessionId: id, nextId: 2, snapshots: [{ id: "cp-1" }] }),
    );
    return dir;
  }

  /** 造 progress/<id>.md（路径口径必须与写入端一致，见 progressFilePath）。 */
  async function writeProgressFile(id: string): Promise<string> {
    const { progressFilePath } = await import("@sid-code/core/query/work-log.ts");
    const file = progressFilePath(id);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "# 进度\n- 已完成: x\n");
    return file;
  }

  test("D7/D8：自动清理删除会话时，连带删除 checkpoints/<id>/ 与 progress/<id>.md", async () => {
    const oldFile = writeOldSession("sib-old");
    const oldCp = writeCheckpointDir("sib-old");
    const oldProgress = await writeProgressFile("sib-old");

    // 反向自证用：一个**不该被删**的会话（受 protectedSessionIds 保护），它的兄弟存储必须活着。
    // 缺了这一组，「helper 把 checkpoints/ 整个根目录 rm 掉」也能让上面三条断言全绿。
    writeOldSession("sib-keep");
    const keepCp = writeCheckpointDir("sib-keep");
    const keepProgress = await writeProgressFile("sib-keep");

    expect(existsSync(oldCp)).toBe(true);
    expect(existsSync(oldProgress)).toBe(true);

    const result = await cleanupExpiredSessions(
      {} as any,
      { enabled: true, maxAge: "1h", minRetention: "1h", maxCount: 1 },
      undefined,
      ["sib-keep"],
    );

    // 会话本体被删 → 兄弟存储必须一起走
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(oldCp)).toBe(false);
    expect(existsSync(oldProgress)).toBe(false);

    // 反向自证：没被删的会话，兄弟存储原样保留
    expect(existsSync(keepCp)).toBe(true);
    expect(existsSync(keepProgress)).toBe(true);
    expect(result.deletedIds).toContain("sib-old");
  });

  test("D7/D8：兄弟存储不存在时清理不报错（best-effort，不阻断删会话）", async () => {
    const file = writeOldSession("sib-none");

    const result = await cleanupExpiredSessions({} as any, {
      enabled: true,
      maxAge: "1h",
      minRetention: "1h",
      maxCount: 1,
    });

    expect(existsSync(file)).toBe(false);
    expect(result.failed).toBe(0);
  });

  /**
   * `--delete-session` 是删除会话的**第二个入口**，此前它只 unlink jsonl 本体。
   * 两个入口各自罗列「要删什么」，同一条缺陷就会存在两份 —— 所以它们共用
   * `deleteSessionSiblingStores()`，这条测试锁住那次接线。
   */
  test("D7/D8：deleteSessionSiblingStores 只删指定 id，不波及其他会话", async () => {
    const targetCp = writeCheckpointDir("target-id");
    const targetProgress = await writeProgressFile("target-id");
    const otherCp = writeCheckpointDir("other-id");
    const otherProgress = await writeProgressFile("other-id");

    const { deleteSessionSiblingStores } = await import("@sid-code/core/session/cleanup.ts");
    await deleteSessionSiblingStores("target-id");

    expect(existsSync(targetCp)).toBe(false);
    expect(existsSync(targetProgress)).toBe(false);
    // 反向自证：同级目录里别的会话不受影响（否则就是把根目录删了）
    expect(existsSync(otherCp)).toBe(true);
    expect(existsSync(otherProgress)).toBe(true);
  });
});
