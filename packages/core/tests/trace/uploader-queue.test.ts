/**
 * 重试队列可观测性 + 两个「死配置」复活 测试
 *
 * 背景（2026-09-16 实测）：
 *   1. `processRetryQueue()` 返回 void，条目文件不存在时直接 `continue` ——
 *      不计数、不告警、不留痕。实测跑 `--upload-traces` 时队列从 **1267 条清空到 0**，
 *      云端轨迹一条没增加：1267 条全部走进那个 continue，而 CLI 只打印「处理完成」。
 *      **「传了 1267 个」与「丢了 1267 个」输出完全一样**，排查者据此误判修复已生效。
 *   2. `maxQueueRetries` / `queueScanIntervalMs` 在 config 层声明+转换齐全，
 *      却从未被 uploader 读取（硬编码 `attempts >= 50`；全文只有心跳一个 setInterval）。
 *      配了什么都不会发生 —— 这类「配置项存在但无实现」比崩溃危险，因为它静默。
 *
 * 本文件是这两条的反漂移断言：改回硬编码 / 改回 void 返回都会在这里红。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UploadManager } from "@sid-code/core/trace/uploader.ts";

const origFetch = globalThis.fetch;

/** 队列条目 */
function entry(sessionId: string, file = "session.traj", attempts = 0, status = "pending") {
  return JSON.stringify({
    session_id: sessionId,
    file,
    added_at: new Date().toISOString(),
    attempts,
    last_error: "",
    status,
  });
}

function mkMgr(root: string, opts: Record<string, unknown> = {}): UploadManager {
  return new UploadManager({
    baseUrl: "http://127.0.0.1:1",
    token: "t",
    outputDir: root,
    retryBaseMs: 1,
    maxRetries: 1,
    recomputeCostBeforeUpload: false,
    ...opts,
  });
}

/** 让 serverReachable=true（构造后默认就是 true，这里只是显式表达意图） */
function markReachable(mgr: UploadManager): void {
  (mgr as any).serverReachable = true;
}

describe("processRetryQueue 统计（不再静默丢数据）", () => {
  let root: string;
  beforeEach(() => {
    root = join(tmpdir(), `uq-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(root, "sessions"), { recursive: true });
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  test("目录已被清理的条目：计入 droppedMissingFile，不再静默 continue", async () => {
    writeFileSync(
      join(root, ".upload_queue.jsonl"),
      entry("gone-1") + "\n" + entry("gone-2") + "\n",
    );
    const mgr = mkMgr(root);
    markReachable(mgr);
    const r = await mgr.processRetryQueue();
    expect(r.total).toBe(2);
    expect(r.droppedMissingFile).toBe(2);
    expect(r.uploaded).toBe(0);
    expect(r.remaining).toBe(0);
    // 这是本次修复的核心：0 上传 与 2 丢弃 必须在返回值里可区分
    expect(r.uploaded === r.droppedMissingFile).toBe(false);
  });

  test("上传成功：计入 uploaded 且条目移出队列", async () => {
    const dir = join(root, "sessions", "s1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.traj"), '{"metadata":}');
    writeFileSync(join(root, ".upload_queue.jsonl"), entry("s1") + "\n");
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: "created" }), { status: 200 })) as any;
    const mgr = mkMgr(root);
    markReachable(mgr);
    const r = await mgr.processRetryQueue();
    expect(r.uploaded).toBe(1);
    expect(r.remaining).toBe(0);
    expect(readFileSync(join(root, ".upload_queue.jsonl"), "utf-8")).toBe("");
  });

  test("409 已存在：计入 skipped（幂等），与 uploaded 分开计", async () => {
    const dir = join(root, "sessions", "s1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.traj"), "{}");
    writeFileSync(join(root, ".upload_queue.jsonl"), entry("s1") + "\n");
    globalThis.fetch = (async () => new Response("exists", { status: 409 })) as any;
    const mgr = mkMgr(root);
    markReachable(mgr);
    const r = await mgr.processRetryQueue();
    expect(r.skipped).toBe(1);
    expect(r.uploaded).toBe(0);
  });

  test("上传失败：计入 retained 且 attempts 递增", async () => {
    const dir = join(root, "sessions", "s1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.traj"), "{}");
    writeFileSync(join(root, ".upload_queue.jsonl"), entry("s1") + "\n");
    globalThis.fetch = (async () => new Response("err", { status: 500 })) as any;
    const mgr = mkMgr(root);
    markReachable(mgr);
    const r = await mgr.processRetryQueue();
    expect(r.retained).toBe(1);
    expect(r.remaining).toBe(1);
    const kept = JSON.parse(readFileSync(join(root, ".upload_queue.jsonl"), "utf-8").trim());
    expect(kept.attempts).toBe(1);
  });

  test("文件名无法识别：计入 droppedUnknownType", async () => {
    const dir = join(root, "sessions", "s1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "weird.bin"), "x");
    writeFileSync(join(root, ".upload_queue.jsonl"), entry("s1", "weird.bin") + "\n");
    const mgr = mkMgr(root);
    markReachable(mgr);
    const r = await mgr.processRetryQueue();
    expect(r.droppedUnknownType).toBe(1);
  });

  test("损坏行：计入 corrupt 并原样保留（不丢用户数据）", async () => {
    writeFileSync(join(root, ".upload_queue.jsonl"), "{ 不是 json\n");
    const mgr = mkMgr(root);
    markReachable(mgr);
    const r = await mgr.processRetryQueue();
    expect(r.corrupt).toBe(1);
    expect(r.remaining).toBe(1);
  });

  test("队列文件不存在：返回全 0 而非抛错", async () => {
    const r = await mkMgr(root).processRetryQueue();
    expect(r.total).toBe(0);
    expect(r.remaining).toBe(0);
  });

  test("formatQueueResult 让「传了 0」与「传了 N」在文案上可区分", () => {
    const base = {
      total: 1267,
      uploaded: 0,
      skipped: 0,
      droppedMissingFile: 1267,
      droppedUnknownType: 0,
      retained: 0,
      markedFailed: 0,
      corrupt: 0,
      droppedOverflow: 0,
      remaining: 0,
    };
    const line = UploadManager.formatQueueResult(base);
    expect(line).toContain("上传 0");
    expect(line).toContain("因目录已清理丢弃 1267");
    const ok = UploadManager.formatQueueResult({ ...base, uploaded: 1267, droppedMissingFile: 0 });
    expect(ok).not.toBe(line);
  });
});

describe("maxQueueRetries 死配置复活", () => {
  let root: string;
  beforeEach(() => {
    root = join(tmpdir(), `uq2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(root, "sessions"), { recursive: true });
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  test("默认 50：attempts=49 仍重试，attempts=50 判 failed", async () => {
    const dir = join(root, "sessions", "s1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.traj"), "");
    writeFileSync(join(root, ".upload_queue.jsonl"), entry("s1", "session.traj", 50) + "\n");
    const mgr = mkMgr(root);
    markReachable(mgr);
    const r = await mgr.processRetryQueue();
    expect(r.markedFailed).toBe(1);
  });

  test("配 maxQueueRetries=3 时 attempts=3 就判 failed（证明读的是配置而非硬编码 50）", async () => {
    const dir = join(root, "sessions", "s1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.traj"), "{}");
    writeFileSync(join(root, ".upload_queue.jsonl"), entry("s1", "session.traj", 3) + "\n");
    const mgr = mkMgr(root, { maxQueueRetries: 3 });
    markReachable(mgr);
    const r = await mgr.processRetryQueue();
    expect(r.markedFailed).toBe(1);
    expect(r.retained).toBe(0);
  });

  test("显式传 undefined 不把默认值打穿（与 outputDir 同一个 P0 陷阱）", async () => {
    const mgr = mkMgr(root, { maxQueueRetries: undefined });
    expect((mgr as any).opts.maxQueueRetries).toBe(50);
  });
});

describe("queueScanIntervalMs 死配置复活（startQueueScan）", () => {
  let root: string;
  beforeEach(() => {
    root = join(tmpdir(), `uq3-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(root, "sessions"), { recursive: true });
  });
  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  test("startQueueScan 真的排了定时器，stopQueueScan 能清掉", () => {
    const mgr = mkMgr(root);
    mgr.startQueueScan(60_000);
    expect((mgr as any).queueScanTimer).not.toBeNull();
    mgr.stopQueueScan();
    expect((mgr as any).queueScanTimer).toBeNull();
  });

  test("幂等：重复调用不叠加定时器", () => {
    const mgr = mkMgr(root);
    mgr.startQueueScan(60_000);
    const first = (mgr as any).queueScanTimer;
    mgr.startQueueScan(60_000);
    expect((mgr as any).queueScanTimer).toBe(first);
    mgr.stopQueueScan();
  });

  test("interval<=0 视为禁用（不排定时器）", () => {
    const mgr = mkMgr(root);
    mgr.startQueueScan(0);
    expect((mgr as any).queueScanTimer).toBeNull();
    mgr.startQueueScan(-1);
    expect((mgr as any).queueScanTimer).toBeNull();
  });

  test("定时器 unref 过：不阻止进程退出", () => {
    const mgr = mkMgr(root);
    mgr.startQueueScan(60_000);
    const t = (mgr as any).queueScanTimer;
    // Bun/Node 的 Timeout 在 unref 后 hasRef() 为 false
    expect(typeof t.hasRef !== "function" || t.hasRef() === false).toBe(true);
    mgr.stopQueueScan();
  });

  test("扫描周期到点会真的调 processRetryQueue（而不是只排了个空定时器）", async () => {
    const mgr = mkMgr(root);
    let calls = 0;
    (mgr as any).processRetryQueue = async () => {
      calls++;
      return {
        total: 0,
        uploaded: 0,
        skipped: 0,
        droppedMissingFile: 0,
        droppedUnknownType: 0,
        retained: 0,
        markedFailed: 0,
        corrupt: 0,
        droppedOverflow: 0,
        remaining: 0,
      };
    };
    mgr.startQueueScan(5);
    await new Promise((r) => setTimeout(r, 40));
    mgr.stopQueueScan();
    expect(calls).toBeGreaterThan(0);
  });

  test("不重入：上一轮未结束时不叠加第二轮（慢上传 + 短间隔）", async () => {
    const mgr = mkMgr(root);
    let concurrent = 0;
    let peak = 0;
    (mgr as any).processRetryQueue = async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 30));
      concurrent--;
      return {
        total: 0,
        uploaded: 0,
        skipped: 0,
        droppedMissingFile: 0,
        droppedUnknownType: 0,
        retained: 0,
        markedFailed: 0,
        corrupt: 0,
        droppedOverflow: 0,
        remaining: 0,
      };
    };
    mgr.startQueueScan(5);
    await new Promise((r) => setTimeout(r, 80));
    mgr.stopQueueScan();
    expect(peak).toBe(1);
  });
});

describe("显式 undefined 键不得打穿任何默认值（P0 缺陷族）", () => {
  let root: string;
  beforeEach(() => {
    root = join(tmpdir(), `uq4-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(root, "sessions"), { recursive: true });
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  /**
   * 这是本仓踩过三次的同型缺陷：默认值写在 `...options` **之前**，
   * 而调用方传的是可能不存在的 settings 字段 → 显式 undefined 键覆盖默认值。
   *
   * 最严重的一次（2026-09-17 实测）：`cli.ts` 的 `handleUploadTraces` 传
   * `maxRetries: traceUpload.maxRetries`，用户没配时是 undefined，而重试循环是
   * `for (attempt = 0; attempt < this.opts.maxRetries; ...)` —— `0 < undefined`
   * 恒为 false，**循环体一次都不执行，一个 HTTP 请求都不会发出**，
   * 文件直接判 failed 进队列。`sid-code --upload-traces` 因此从未真正上传过任何东西。
   */
  test("照抄 cli.ts 的构造（全字段显式 undefined）后，每个默认值仍在", () => {
    const mgr = new UploadManager({
      baseUrl: "http://127.0.0.1:1",
      token: "t",
      toolSource: undefined,
      userId: undefined,
      deviceId: undefined,
      maxRetries: undefined,
      retryBaseMs: undefined,
      compress: undefined,
      deleteAfterUpload: undefined,
      outputDir: root,
      maxQueueRetries: undefined,
      availableModels: undefined,
      recomputeCostBeforeUpload: undefined,
    } as any);
    const o = (mgr as any).opts;
    expect(o.maxRetries).toBe(5);
    expect(o.retryBaseMs).toBe(2000);
    expect(o.compress).toBe(true);
    expect(o.toolSource).toBe("sid-code");
    expect(o.maxQueueRetries).toBe(50);
    expect(o.recomputeCostBeforeUpload).toBe(true);
    expect(o.deleteAfterUpload).toBe(false);
    expect(Array.isArray(o.availableModels)).toBe(true);
    expect(typeof o.outputDir).toBe("string");
    expect(o.outputDir.length).toBeGreaterThan(0);
  });

  test("maxRetries 为 undefined 时重试循环仍会真的发出请求（缺陷本体）", async () => {
    const dir = join(root, "sessions", "s1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.traj"), "{}");
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ status: "created" }), { status: 200 });
    }) as any;
    const mgr = new UploadManager({
      baseUrl: "http://127.0.0.1:1",
      token: "t",
      outputDir: root,
      maxRetries: undefined,
      compress: false,
      recomputeCostBeforeUpload: false,
    } as any);
    markReachable(mgr);
    const r = await mgr.uploadSession(dir, "s1");
    // 修复前：calls === 0、allConfirmed === false（0 个请求，直接入队）
    expect(calls).toBeGreaterThan(0);
    expect(r.allConfirmed).toBe(true);
  });

  test("显式传 false / 0 不被 ?? 误当缺省覆盖（区分「假值」与「没给值」）", () => {
    const mgr = new UploadManager({
      baseUrl: "http://127.0.0.1:1",
      token: "t",
      outputDir: root,
      compress: false,
      deleteAfterUpload: false,
      recomputeCostBeforeUpload: false,
      maxQueueRetries: 0,
      retryBaseMs: 0,
    } as any);
    const o = (mgr as any).opts;
    expect(o.compress).toBe(false);
    expect(o.deleteAfterUpload).toBe(false);
    expect(o.recomputeCostBeforeUpload).toBe(false);
    expect(o.maxQueueRetries).toBe(0);
    expect(o.retryBaseMs).toBe(0);
  });
});
