/**
 * B1 + B2：上传重试队列接入跨进程退避/终态，并收敛重复条目
 *
 * 背景（会话 20261103-114056-3b4f9ca7 复盘的取证）：
 *   1. sid-code 有两套互不知道对方的重试机制——补传扫描（backfill.ts，读 `.upload-attempts`
 *      做指数退避、8 次后写 `.upload-failed` 终态）与重试队列（uploader.ts 的
 *      `processRetryQueue`，全文没有任何一处引用 upload-attempts.ts）。
 *      后果：一个 445MB 的 traj 会话每 5 分钟被重传一轮，35 分钟出现 7 组失败日志，
 *      与 `upload-attempts` 记的「第 5 次失败，16h 内不该再碰」完全脱节。
 *   2. `appendToRetryQueue` 的去重条件是 `entry.status !== "failed"`，于是「判死的那条」
 *      不阻止追加：每失败一次就再生一条全新 pending，`maxQueueRetries=50` 因此没有上限。
 *      实测同一个 (20261022-034121-20f64f92, session.traj) 攒了 9 条
 *      （8 条 attempts=50/failed + 1 条 attempts=23/pending），累计自动尝试 423 轮。
 *
 * 本文件是这两条的验收：每一条都写成「不修就会红」的断言，而不是只测新函数存在。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UploadManager } from "@sid-code/core/trace/uploader.ts";
import { UPLOAD_ATTEMPTS_FILE, UPLOAD_FAILED_FILE } from "@sid-code/core/trace/upload-attempts.ts";

const origFetch = globalThis.fetch;

interface QueueLine {
  session_id: string;
  file: string;
  added_at?: string;
  attempts: number;
  last_error?: string;
  status: "pending" | "failed";
}

function mkRoot(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, "sessions"), { recursive: true });
  return dir;
}

function queueLine(entry: QueueLine): string {
  return JSON.stringify({
    added_at: "2026-11-03T00:00:00.000Z",
    last_error: "",
    ...entry,
  });
}

function writeQueue(root: string, entries: QueueLine[]): void {
  writeFileSync(join(root, ".upload_queue.jsonl"), entries.map(queueLine).join("\n") + "\n");
}

function readQueue(root: string): QueueLine[] {
  const p = join(root, ".upload_queue.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as QueueLine);
}

function mkSession(root: string, sessionId: string, fileName = "session.traj"): string {
  const dir = join(root, "sessions", sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), '{"metadata":{"session_id":"' + sessionId + '"}}');
  return dir;
}

/** 写一份「刚刚失败过、仍在退避窗口内」的记账（backoffMs(1) = 1h） */
function markInBackoff(dir: string, attempts = 1): void {
  writeFileSync(
    join(dir, UPLOAD_ATTEMPTS_FILE),
    JSON.stringify({ attempts, lastAttemptMs: Date.now(), lastError: "timeout" }),
  );
}

function markTerminal(dir: string, attempts = 8): void {
  writeFileSync(
    join(dir, UPLOAD_FAILED_FILE),
    JSON.stringify({ failed_at: "2026-11-03T00:00:00.000Z", attempts, reason: "timeout" }),
  );
}

function mkMgr(root: string, opts: Record<string, unknown> = {}): UploadManager {
  const mgr = new UploadManager({
    baseUrl: "http://127.0.0.1:1",
    token: "t",
    outputDir: root,
    maxRetries: 1,
    retryBaseMs: 1,
    recomputeCostBeforeUpload: false,
    ...opts,
  });
  // 构造后默认 serverReachable=true；显式表达意图，避免将来默认值变化时测试静默变味
  (mgr as any).serverReachable = true;
  return mgr;
}

/** 统计真正发出去的 HTTP 请求数 */
function countFetch(status = 500): { calls: () => number; restore: () => void } {
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    return new Response("err", { status });
  }) as any;
  return { calls: () => n, restore: () => (globalThis.fetch = origFetch) };
}

describe("B1：重试队列接入跨进程退避与终态", () => {
  let root: string;
  beforeEach(() => {
    root = mkRoot("uq-backoff");
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  test("仍在退避窗口内：一个请求都不发，条目原样保留且 attempts 不增", async () => {
    const dir = mkSession(root, "s1");
    markInBackoff(dir, 1);
    writeQueue(root, [{ session_id: "s1", file: "session.traj", attempts: 7, status: "pending" }]);

    const f = countFetch();
    const r = await mkMgr(root).processRetryQueue();
    f.restore();

    // 修复前：这里会发请求（countFetch 计数 1），且条目 attempts 被推到 8
    expect(f.calls()).toBe(0);
    expect(r.backoff).toBe(1);
    expect(r.uploaded).toBe(0);
    expect(r.retained).toBe(0);
    expect(r.remaining).toBe(1);
    const kept = readQueue(root);
    expect(kept).toHaveLength(1);
    // 本轮一个字节都没发，不该消耗重试预算
    expect(kept[0]!.attempts).toBe(7);
    expect(kept[0]!.status).toBe("pending");
  });

  test("已有 .upload-failed 终态：不上传，条目标 failed", async () => {
    const dir = mkSession(root, "s1");
    markTerminal(dir);
    writeQueue(root, [{ session_id: "s1", file: "session.traj", attempts: 3, status: "pending" }]);

    const f = countFetch();
    const r = await mkMgr(root).processRetryQueue();
    f.restore();

    expect(f.calls()).toBe(0);
    expect(r.markedFailed).toBe(1);
    expect(r.remaining).toBe(1);
    const kept = readQueue(root);
    expect(kept[0]!.status).toBe("failed");
  });

  test("队列上传失败：写 .upload-attempts，且会话目录 mtime 不变", async () => {
    const dir = mkSession(root, "s1");
    writeQueue(root, [{ session_id: "s1", file: "session.traj", attempts: 0, status: "pending" }]);
    const f = countFetch();

    // 第一次：真上传（失败）→ 生成 `.upload-cache` 并记 attempts=1
    await mkMgr(root).processRetryQueue();
    const attempts1 = JSON.parse(readFileSync(join(dir, UPLOAD_ATTEMPTS_FILE), "utf-8"));
    expect(attempts1.attempts).toBe(1);

    // 第二次用 ignoreBackoff 绕开刚写下的 1h 退避；此时压缩缓存命中、不会再写会话目录，
    // 于是「recordUploadFailure 保持目录 mtime」这件事才可断言。
    const mtimeBefore = statSync(dir).mtimeMs;
    await new Promise((r) => setTimeout(r, 10));
    await mkMgr(root).processRetryQueue({ ignoreBackoff: true });
    f.restore();

    const attempts2 = JSON.parse(readFileSync(join(dir, UPLOAD_ATTEMPTS_FILE), "utf-8"));
    expect(attempts2.attempts).toBe(2);
    // 记账是旁路信息，不该把目录 mtime 刷成「现在」（否则补传时间闸/LRU 判据全被带偏）
    expect(statSync(dir).mtimeMs).toBe(mtimeBefore);
  });

  test("累计到 MAX_AUTO_ATTEMPTS：条目直接进终态（与补传共用同一个失败计数）", async () => {
    const dir = mkSession(root, "s1");
    // 7 次：下一次失败就到 8 次的终态阈值
    writeFileSync(
      join(dir, UPLOAD_ATTEMPTS_FILE),
      JSON.stringify({ attempts: 7, lastAttemptMs: 0, lastError: "timeout" }),
    );
    writeQueue(root, [{ session_id: "s1", file: "session.traj", attempts: 0, status: "pending" }]);

    const f = countFetch();
    const r = await mkMgr(root).processRetryQueue();
    f.restore();

    expect(f.calls()).toBe(1); // 真的试了一次（attempts=7 的 lastAttemptMs=0，早过了退避）
    expect(r.markedFailed).toBe(1);
    expect(r.retained).toBe(0);
    expect(existsSync(join(dir, UPLOAD_FAILED_FILE))).toBe(true);
    expect(readQueue(root)[0]!.status).toBe("failed");
  });

  test("--upload-traces 手动路径（ignoreBackoff）：无视终态照传，成功后清掉两个记账文件", async () => {
    const dir = mkSession(root, "s1");
    markTerminal(dir);
    writeQueue(root, [{ session_id: "s1", file: "session.traj", attempts: 50, status: "failed" }]);

    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ status: "created", sha256: "" }), { status: 200 });
    }) as any;
    const r = await mkMgr(root).processRetryQueue({ ignoreBackoff: true });
    globalThis.fetch = origFetch;

    // 终态条目在手动路径下也要再试一次 —— 这一条锁住「修 B1 不能把 --upload-traces 一起废掉」
    expect(calls).toBe(1);
    expect(r.uploaded).toBe(1);
    expect(r.remaining).toBe(0);
    expect(existsSync(join(dir, UPLOAD_FAILED_FILE))).toBe(false);
    expect(existsSync(join(dir, UPLOAD_ATTEMPTS_FILE))).toBe(false);
  });

  test("同会话 traj 成功不会清掉 raw 刚记下的失败（会话级清理）", async () => {
    const dir = mkSession(root, "s1");
    writeFileSync(join(dir, "raw.jsonl"), '{"x":1}\n');
    writeQueue(root, [
      { session_id: "s1", file: "session.traj", attempts: 0, status: "pending" },
      { session_id: "s1", file: "raw.jsonl", attempts: 0, status: "pending" },
    ]);

    // traj 成功、raw 失败。multipart body 是 ReadableStream（拿不到字段文本），
    // 而 FILE_TYPE_MAP 的处理顺序固定为 traj → raw，所以按调用序号分流。
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      if (call === 1) {
        return new Response(JSON.stringify({ status: "created", sha256: "" }), { status: 200 });
      }
      return new Response("err", { status: 500 });
    }) as any;

    const r = await mkMgr(root).processRetryQueue();
    globalThis.fetch = origFetch;

    expect(r.uploaded).toBe(1);
    expect(r.retained).toBe(1);
    // 关键：raw 的失败记账不能被 traj 的成功清掉，否则「失败→清账→再失败」可以无限循环
    expect(existsSync(join(dir, UPLOAD_ATTEMPTS_FILE))).toBe(true);
    const a = JSON.parse(readFileSync(join(dir, UPLOAD_ATTEMPTS_FILE), "utf-8"));
    expect(a.attempts).toBe(1);
  });
});

describe("B2：去重与合并让队列收敛", () => {
  let root: string;
  beforeEach(() => {
    root = mkRoot("uq-dedupe");
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  test("同 key 已有 failed 条目时不再追加新 pending", async () => {
    mkSession(root, "s1");
    writeQueue(root, [{ session_id: "s1", file: "session.traj", attempts: 50, status: "failed" }]);

    // 服务端不可达 → uploadSession 走「直接入队」分支，正是原先无限追加的那条路径
    const mgr = mkMgr(root);
    (mgr as any).serverReachable = false;
    await mgr.uploadSession(join(root, "sessions", "s1"), "s1");

    // 修复前：这里变成 2 条（failed 不阻止追加 → 新的 pending → 50 次预算重新开始）
    expect(readQueue(root)).toHaveLength(1);
    expect(readQueue(root)[0]!.status).toBe("failed");
  });

  test("队列里 9 条同 key 记录 → 一次扫描后收敛成 1 条（保留 attempts 最大）", async () => {
    const dir = mkSession(root, "s1");
    markTerminal(dir); // 让收敛后的那条走终态分支，不发请求
    const entries: QueueLine[] = [];
    for (let i = 0; i < 8; i++) {
      entries.push({ session_id: "s1", file: "session.traj", attempts: 50, status: "failed" });
    }
    entries.push({ session_id: "s1", file: "session.traj", attempts: 23, status: "pending" });
    writeQueue(root, entries);

    const f = countFetch();
    const r = await mkMgr(root).processRetryQueue();
    f.restore();

    expect(r.total).toBe(9);
    expect(r.deduped).toBe(8);
    expect(r.remaining).toBe(1);
    expect(f.calls()).toBe(0);
    const kept = readQueue(root);
    expect(kept).toHaveLength(1);
    // 保留的是最接近终态的记账，不是那条「看起来很新」的 pending
    expect(kept[0]!.attempts).toBe(50);
    expect(kept[0]!.status).toBe("failed");
  });

  test("不同 key 的条目不会被合并", async () => {
    mkSession(root, "s1");
    mkSession(root, "s1", "raw.jsonl");
    writeQueue(root, [
      { session_id: "s1", file: "session.traj", attempts: 0, status: "pending" },
      { session_id: "s1", file: "raw.jsonl", attempts: 0, status: "pending" },
      { session_id: "s2", file: "session.traj", attempts: 0, status: "pending" },
    ]);
    const f = countFetch();
    const r = await mkMgr(root).processRetryQueue();
    f.restore();

    expect(r.deduped).toBe(0);
    // s2 目录不存在 → droppedMissingFile；s1 两个文件 → 都失败保留
    expect(r.remaining).toBe(2);
    expect(r.droppedMissingFile).toBe(1);
  });
});
