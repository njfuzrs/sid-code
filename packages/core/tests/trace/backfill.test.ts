/**
 * 启动补传（backfill.ts）测试
 *
 * 背景实测（2026-09-16）：本机 52 个交互式会话 0 个上传成功、0 个带 `.uploaded` 标记，
 * 其中 39 个 `events.jsonl` 里连 SessionEnd 事件都没有 —— 「退出时上传」这条唯一
 * 自动路径在日常交互里基本不执行。补传是最后一道防线，它的判据必须只依赖磁盘现状。
 *
 * 本文件锁死三类不变量：
 *   1. 判据正确：缺 `.uploaded` + 有非空 traj 才补传；
 *   2. **绝不碰正在被写的会话**（当前会话 / 心跳新 / PID 存活 / 目录太新）——
 *      传错一次就会盖上 `.uploaded` 章，真正的终态从此永不补传；
 *   3. 统计不撒谎：每个被跳过的会话都落进某一格，跳过原因可区分。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  scanPendingUploads,
  runBackfill,
  formatBackfillResult,
  getUploadBacklog,
  type BackfillUploader,
} from "@sid-code/core/trace/backfill.ts";

/** 造一个会话目录。traj=null 表示不建 session.traj */
function mkSession(
  root: string,
  id: string,
  opts: {
    traj?: string | null;
    uploaded?: boolean;
    heartbeatTs?: string;
    ageMs?: number;
    /** false = 不写 events.jsonl，构造「幽灵目录」（只有 traj 的空壳残骸） */
    events?: boolean;
  } = {},
): string {
  const dir = join(root, "sessions", id);
  mkdirSync(dir, { recursive: true });
  const traj = opts.traj === undefined ? '{"metadata":{}}' : opts.traj;
  if (traj !== null) writeFileSync(join(dir, "session.traj"), traj);
  // 真实会话在 SessionStart 就写下第一条事件（实测 52/52 齐全），
  // 所以默认建出来 —— 缺它即为幽灵目录，另有专测。
  if (opts.events !== false) writeFileSync(join(dir, "events.jsonl"), '{"event":"SessionStart"}\n');
  if (opts.uploaded) writeFileSync(join(dir, ".uploaded"), "{}");
  if (opts.heartbeatTs) {
    writeFileSync(join(dir, "heartbeat.txt"), JSON.stringify({ ts: opts.heartbeatTs }));
  }
  // 默认把目录 mtime 推老，避开「太新不动」的时间闸（该闸另有专测）
  const ageMs = opts.ageMs ?? 10 * 60 * 1000;
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(dir, t, t);
  return dir;
}

/** 记录调用的假上传器 */
function fakeUploader(behavior: (id: string) => boolean | Error = () => true): {
  uploader: BackfillUploader;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    uploader: {
      async uploadSession(_dir: string, sessionId: string) {
        calls.push(sessionId);
        const r = behavior(sessionId);
        if (r instanceof Error) throw r;
        return { allConfirmed: r };
      },
    },
  };
}

describe("backfill 扫描判据", () => {
  let root: string;
  beforeEach(() => {
    root = join(tmpdir(), `backfill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(root, "sessions"), { recursive: true });
  });
  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  test("缺 .uploaded 且有非空 traj → 待补传", () => {
    mkSession(root, "s1");
    const { pending, stats } = scanPendingUploads({ outputDir: root });
    expect(pending.map((p) => p.sessionId)).toEqual(["s1"]);
    expect(stats.scanned).toBe(1);
  });

  test("已有 .uploaded 标记 → 跳过并计入 alreadyUploaded", () => {
    mkSession(root, "s1", { uploaded: true });
    const { pending, stats } = scanPendingUploads({ outputDir: root });
    expect(pending).toHaveLength(0);
    expect(stats.alreadyUploaded).toBe(1);
  });

  test("无 session.traj → 跳过并计入 noTraj（空壳/正在初始化）", () => {
    mkSession(root, "s1", { traj: null });
    const { pending, stats } = scanPendingUploads({ outputDir: root });
    expect(pending).toHaveLength(0);
    expect(stats.noTraj).toBe(1);
  });

  test("session.traj 为 0 字节 → 跳过并计入 emptyTraj（写了一半，传上去是坏文件）", () => {
    mkSession(root, "s1", { traj: "" });
    const { pending, stats } = scanPendingUploads({ outputDir: root });
    expect(pending).toHaveLength(0);
    expect(stats.emptyTraj).toBe(1);
  });

  test("幽灵目录（有 traj 无 events.jsonl）→ 不补传，计入 ghost", () => {
    // 成因：空壳会话被删目录后，side-call 观察者又触发一次落盘，
    // 而 Bun.write 会自动重建父目录 —— 留下只含 traj 的残骸。
    // 传上云等于把空壳判定当初想剔除的噪音搬进训练数据。
    mkSession(root, "ghost", { events: false });
    const { pending, stats } = scanPendingUploads({ outputDir: root });
    expect(pending).toHaveLength(0);
    expect(stats.ghost).toBe(1);
  });

  test("正常会话（traj + events 齐全）不被幽灵判据误伤", () => {
    mkSession(root, "normal");
    const { pending, stats } = scanPendingUploads({ outputDir: root });
    expect(pending.map((p) => p.sessionId)).toEqual(["normal"]);
    expect(stats.ghost).toBe(0);
  });

  test("当前会话永不补传（它还在写）", () => {
    mkSession(root, "me");
    const { pending, stats } = scanPendingUploads({ outputDir: root, currentSessionId: "me" });
    expect(pending).toHaveLength(0);
    expect(stats.live).toBe(1);
  });

  test("心跳很新 → 判为有活进程在写，跳过", () => {
    mkSession(root, "s1", { heartbeatTs: new Date().toISOString() });
    const { pending, stats } = scanPendingUploads({ outputDir: root });
    expect(pending).toHaveLength(0);
    expect(stats.live).toBe(1);
  });

  test("心跳很旧 → 视为已退出，纳入补传", () => {
    mkSession(root, "s1", { heartbeatTs: new Date(Date.now() - 3600_000).toISOString() });
    const { pending } = scanPendingUploads({ outputDir: root });
    expect(pending.map((p) => p.sessionId)).toEqual(["s1"]);
  });

  test("心跳文件损坏/空 → 不因此判活（取不到时间就当没有心跳）", () => {
    // ⚠️ 写文件会把**目录** mtime 刷新成"刚刚"，于是时间闸会先把它判成 tooNew ——
    // 这不是产品缺陷而是测试顺序问题，写完必须重新推老目录时间才测得到心跳分支。
    const dir = mkSession(root, "s1");
    writeFileSync(join(dir, "heartbeat.txt"), "{ 这不是 json");
    const t = (Date.now() - 10 * 60 * 1000) / 1000;
    utimesSync(dir, t, t);
    const { pending, stats } = scanPendingUploads({ outputDir: root });
    expect(stats.tooNew).toBe(0);
    expect(pending.map((p) => p.sessionId)).toEqual(["s1"]);
  });

  test("目录太新 → 时间闸挡住（覆盖『刚建目录、心跳还没写第一次』的窗口）", () => {
    mkSession(root, "s1", { ageMs: 0 });
    const { pending, stats } = scanPendingUploads({ outputDir: root, minAgeMs: 60_000 });
    expect(pending).toHaveLength(0);
    expect(stats.tooNew).toBe(1);
  });

  test("PID 存活（用本进程 pid 冒充）→ 跳过；PID 已死 → 纳入", () => {
    mkSession(root, "alive");
    mkSession(root, "dead");
    const pidsDir = join(root, ".pids");
    mkdirSync(pidsDir, { recursive: true });
    writeFileSync(
      join(pidsDir, "alive.json"),
      JSON.stringify({ pid: process.pid, session_id: "alive" }),
    );
    // pid 2^31-1 几乎不可能存在
    writeFileSync(
      join(pidsDir, "dead.json"),
      JSON.stringify({ pid: 2147483646, session_id: "dead" }),
    );
    const { pending, stats } = scanPendingUploads({ outputDir: root });
    expect(pending.map((p) => p.sessionId)).toEqual(["dead"]);
    expect(stats.live).toBe(1);
  });

  test("只读传进来的 outputDir，不去看真实 HOME 的 .pids（否则本机开着 sid-code 会让结论翻转）", () => {
    mkSession(root, "s1");
    const { pending } = scanPendingUploads({ outputDir: root });
    // 真实 HOME 下极可能有 .pids 条目，但绝不能影响 tmp 隔离目录的判定
    expect(pending.map((p) => p.sessionId)).toEqual(["s1"]);
  });

  test("点开头的内部目录（.pids 等）不当成会话", () => {
    mkdirSync(join(root, "sessions", ".internal"), { recursive: true });
    const { stats } = scanPendingUploads({ outputDir: root });
    expect(stats.scanned).toBe(0);
  });

  test("sessions/ 不存在时安全返回空", () => {
    const empty = join(tmpdir(), `backfill-none-${Date.now()}`);
    const { pending, stats } = scanPendingUploads({ outputDir: empty });
    expect(pending).toHaveLength(0);
    expect(stats.scanned).toBe(0);
  });

  test("最旧优先（最旧的最接近被 LRU 轮转删掉）", () => {
    mkSession(root, "new", { ageMs: 5 * 60_000 });
    mkSession(root, "old", { ageMs: 60 * 60_000 });
    const { pending } = scanPendingUploads({ outputDir: root });
    expect(pending.map((p) => p.sessionId)).toEqual(["old", "new"]);
  });
});

describe("backfill 执行", () => {
  let root: string;
  beforeEach(() => {
    root = join(tmpdir(), `backfill-run-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(root, "sessions"), { recursive: true });
  });
  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  test("全部成功：uploaded 计数正确", async () => {
    mkSession(root, "a");
    mkSession(root, "b");
    const { uploader, calls } = fakeUploader();
    const r = await runBackfill(uploader, { outputDir: root });
    expect(r.pending).toBe(2);
    expect(r.attempted).toBe(2);
    expect(r.uploaded).toBe(2);
    expect(calls.sort()).toEqual(["a", "b"]);
  });

  test("allConfirmed=false 计入 failed 而非 uploaded", async () => {
    mkSession(root, "a");
    const { uploader } = fakeUploader(() => false);
    const r = await runBackfill(uploader, { outputDir: root });
    expect(r.uploaded).toBe(0);
    expect(r.failed).toBe(1);
  });

  test("上传抛异常被兜住：不冒泡，计入 errors", async () => {
    mkSession(root, "a");
    mkSession(root, "b");
    const { uploader } = fakeUploader((id) => (id === "a" ? new Error("boom") : true));
    const r = await runBackfill(uploader, { outputDir: root });
    expect(r.errors).toBe(1);
    expect(r.uploaded).toBe(1);
  });

  test("maxSessions 截断：本轮只传 N 个，其余 deferred（不打爆启动网络）", async () => {
    for (let i = 0; i < 5; i++) mkSession(root, `s${i}`);
    const { uploader, calls } = fakeUploader();
    const r = await runBackfill(uploader, { outputDir: root, maxSessions: 2 });
    expect(r.pending).toBe(5);
    expect(r.attempted).toBe(2);
    expect(r.deferred).toBe(3);
    expect(calls).toHaveLength(2);
  });

  test("maxSessions=0：一个都不传", async () => {
    mkSession(root, "a");
    const { uploader, calls } = fakeUploader();
    const r = await runBackfill(uploader, { outputDir: root, maxSessions: 0 });
    expect(r.attempted).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("maxSessions=Infinity：全传（--upload-traces 手动命令的口径）", async () => {
    for (let i = 0; i < 4; i++) mkSession(root, `s${i}`);
    const { uploader } = fakeUploader();
    const r = await runBackfill(uploader, {
      outputDir: root,
      maxSessions: Number.POSITIVE_INFINITY,
    });
    expect(r.attempted).toBe(4);
    expect(r.deferred).toBe(0);
  });

  test("已 abort 的 signal：不发起任何上传", async () => {
    mkSession(root, "a");
    const ac = new AbortController();
    ac.abort();
    const { uploader, calls } = fakeUploader();
    const r = await runBackfill(uploader, { outputDir: root, signal: ac.signal });
    expect(calls).toHaveLength(0);
    expect(r.aborted).toBe(true);
  });

  test("并发上限不超过 concurrency", async () => {
    for (let i = 0; i < 6; i++) mkSession(root, `s${i}`);
    let inFlight = 0;
    let peak = 0;
    const uploader: BackfillUploader = {
      async uploadSession() {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { allConfirmed: true };
      },
    };
    await runBackfill(uploader, { outputDir: root, concurrency: 2 });
    expect(peak).toBeLessThanOrEqual(2);
  });

  test("无待补传时不调用上传器", async () => {
    mkSession(root, "a", { uploaded: true });
    const { uploader, calls } = fakeUploader();
    const r = await runBackfill(uploader, { outputDir: root });
    expect(r.pending).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("formatBackfillResult 把每一类都说出来（输出可区分 0 与 N）", async () => {
    mkSession(root, "a");
    mkSession(root, "b", { uploaded: true });
    const { uploader } = fakeUploader();
    const line = formatBackfillResult(await runBackfill(uploader, { outputDir: root }));
    expect(line).toContain("待补传 1");
    expect(line).toContain("成功 1");
    expect(line).toContain("已上传 1");
  });
});

describe("上传积压体检（可观测性）", () => {
  let root: string;
  beforeEach(() => {
    root = join(tmpdir(), `backlog-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(root, "sessions"), { recursive: true });
  });
  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  test("分别报出总数 / 已上传 / 待补传", () => {
    mkSession(root, "a");
    mkSession(root, "b", { uploaded: true });
    mkSession(root, "c");
    const b = getUploadBacklog({ outputDir: root });
    expect(b.totalSessions).toBe(3);
    expect(b.uploaded).toBe(1);
    expect(b.pending).toBe(2);
  });

  test("队列文件不存在 → queueEntries 为 0", () => {
    expect(getUploadBacklog({ outputDir: root }).queueEntries).toBe(0);
  });

  test("队列有条目 → 数出行数", () => {
    writeFileSync(join(root, ".upload_queue.jsonl"), '{"a":1}\n{"a":2}\n');
    expect(getUploadBacklog({ outputDir: root }).queueEntries).toBe(2);
  });

  test("「读不到队列」与「队列为空」必须可区分（null ≠ 0）", () => {
    // 把队列路径做成目录 → readFileSync 抛错 → 必须是 null 而不是 0
    mkdirSync(join(root, ".upload_queue.jsonl"), { recursive: true });
    expect(getUploadBacklog({ outputDir: root }).queueEntries).toBeNull();
  });

  test("幽灵目录单独计数，不混进 pending", () => {
    mkSession(root, "ghost", { events: false });
    const b = getUploadBacklog({ outputDir: root });
    expect(b.ghost).toBe(1);
    expect(b.pending).toBe(0);
  });
});
