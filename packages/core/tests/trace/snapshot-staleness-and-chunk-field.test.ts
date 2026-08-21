/**
 * PR11：快照新鲜度（§4.2）与 chunk 字段归一（§4.3）
 *
 * ## §4.2 拦的是什么
 *
 * 上一轮排查里价值最高也最耗时的发现：`chunksReceived: 0` 看起来是权威的实时状态，
 * 实际是一份可能几分钟未更新的陈旧快照，而**没有任何字段标注这份快照的时效性**。
 * 于是第一反应是去找"两个计数器谁被吞了"，绕了大圈才定位到写入条件。
 *
 * 要害在于两种情况的**观测结果完全相同**：
 *   · 流真卡死（写入方还在 tick，数字不动）
 *   · 写入方自己没在写（数字同样不动）
 * 而修法完全不同。没有快照年龄，两者不可分辨。
 *
 * ## §4.3 拦的是什么
 *
 * 同一个"收到多少 chunk"的语义有四个字段名散在四类事件里，无法跨事件 group by，
 * 三轮排查里相当一部分工作量花在按时间戳手工交叉比对上。
 *
 * fix_type: case_design
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  initStreamObserver,
  resetStreamObserver,
  emitStreamPhase,
  emitStreamStall,
  emitWatchdogKill,
  updateStreamStats,
  getStreamSnapshot,
  snapshotStaleness,
  chunkCountFields,
  readChunkCount,
  makeFetchAbsoluteTimeoutSignal,
  SNAPSHOT_STALE_MS,
} from "@sid-code/core/trace/stream-observer.ts";

let captured: Array<{ event: string; data: Record<string, unknown> }>;

beforeEach(() => {
  captured = [];
  initStreamObserver("pr11-session", "/tmp/pr11-session", (ev) => {
    captured.push({ event: ev.event, data: ev.data });
  });
});

afterEach(() => resetStreamObserver());

describe("PR11 §4.2 — 快照新鲜度", () => {
  test("新建快照不是陈旧的（置 0 会让刚建的快照立刻假阳性）", () => {
    emitStreamPhase(1, "fetch_sent", { model: "m" });
    const snap = getStreamSnapshot(1)!;
    expect(snap.statsUpdatedAt).toBeGreaterThan(0);
    expect(snapshotStaleness(snap).stale).toBe(false);
    expect(snapshotStaleness(snap).ageMs).toBeLessThan(1_000);
  });

  test("超过阈值即判陈旧（注入 now，不靠真等 90s）", () => {
    emitStreamPhase(2, "fetch_sent", { model: "m" });
    const snap = getStreamSnapshot(2)!;
    const future = snap.statsUpdatedAt + SNAPSHOT_STALE_MS + 1;
    expect(snapshotStaleness(snap, future).stale).toBe(true);
    // 边界：恰好等于阈值算陈旧（>=），差 1ms 不算。
    expect(snapshotStaleness(snap, snap.statsUpdatedAt + SNAPSHOT_STALE_MS).stale).toBe(true);
    expect(snapshotStaleness(snap, snap.statsUpdatedAt + SNAPSHOT_STALE_MS - 1).stale).toBe(false);
  });

  test("写入方即使数字没变也刷新新鲜度（本字段的全部意义）", async () => {
    emitStreamPhase(3, "sse_consuming", { model: "m" });
    updateStreamStats(3, { chunksReceived: 5 });
    const t1 = getStreamSnapshot(3)!.statsUpdatedAt;
    await new Promise((r) => setTimeout(r, 5));
    // 单调取大 → chunksReceived 不会变（3 < 5），但"有人在写"这件事必须被记录。
    // 只在数字变化时刷新，就退回"陈旧与无进展分不开"的老问题。
    updateStreamStats(3, { chunksReceived: 3 });
    const snap = getStreamSnapshot(3)!;
    expect(snap.chunksReceived, "单调取大：不该被小值覆盖").toBe(5);
    expect(snap.statsUpdatedAt, "数字没变但新鲜度必须前进").toBeGreaterThan(t1);
  });

  test("WatchdogKill 带上快照年龄（total_chunks:0 的两种成因要能分辨）", () => {
    emitStreamPhase(4, "sse_consuming", { model: "m" });
    emitWatchdogKill(4, {
      phase: "sse_consuming",
      last_content_progress_ms: 900_000,
      total_chunks: 0,
      empty_chunks: 0,
      elapsed_ms: 900_000,
      model: "m",
    });
    const kill = captured.find((e) => e.event === "WatchdogKill")!;
    expect(kill.data.snapshot_age_ms).toBeTypeOf("number");
  });
});

describe("PR11 §4.5 — fetch 硬顶留痕必须可 disarm（否则记出假超时）", () => {
  test("未 disarm：到点 abort → 落一条 TimeoutFired", async () => {
    emitStreamPhase(10, "sse_consuming", { model: "m" });
    const armed = makeFetchAbsoluteTimeoutSignal(10, 10, { model: "m", path: "test" })!;
    expect(armed.signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    const fired = captured.filter(
      (e) => e.event === "TimeoutFired" && e.data.layer === "fetch_absolute_timeout",
    );
    expect(fired.length).toBe(1);
    expect(fired[0]!.data.threshold_ms).toBe(10);
    // 标注 runtime_abort：这一层的 abort 由 runtime 发出、不带我们的白名单 reason，
    // 不标的话读轨迹的人会把它误判成用户取消。
    expect(fired[0]!.data.runtime_abort).toBe(true);
  });

  test("已 disarm：到点仍 abort，但**不许**落事件（这是本次审查抓到的真 bug）", async () => {
    // `AbortSignal.timeout(ms)` 到点一定 abort，与 fetch 是否早已成功结束无关 ——
    // signal 不知道自己已经没人用了。所以"只挂监听器不解除"会让一条 20s 读完的流
    // 在第 1800s 落一条 fetch_absolute_timeout：**一个从未发生过的超时**。
    //
    // 这比"没有留痕"更糟：没留痕只是缺数据，假事件会让"这一层开了几枪"
    // 变成纯噪声，且噪声量正比于**成功**请求数 —— 越健康的部署，数据越脏。
    emitStreamPhase(11, "sse_consuming", { model: "m" });
    const armed = makeFetchAbsoluteTimeoutSignal(10, 11, { model: "m", path: "test" })!;
    armed.disarm(); // 模拟流正常结束走 finally
    await new Promise((r) => setTimeout(r, 40));
    expect(armed.signal.aborted, "计时机制本身不变：signal 仍会到点 abort").toBe(true);
    expect(
      captured.filter((e) => e.event === "TimeoutFired"),
      "disarm 之后不该有任何超时事件",
    ).toEqual([]);
  });

  test("disarm 幂等（finally 可能与其他清理路径重复调）", () => {
    const armed = makeFetchAbsoluteTimeoutSignal(5_000, 12)!;
    expect(() => {
      armed.disarm();
      armed.disarm();
    }).not.toThrow();
  });

  test("未配置阈值 → 返回 undefined（不装这个 signal）", () => {
    expect(makeFetchAbsoluteTimeoutSignal(undefined, 13)).toBeUndefined();
  });
});

describe("PR11 §4.3 — chunk 计数字段归一", () => {
  test("规范字段与口径标注成对出现", () => {
    expect(chunkCountFields(42, "chunks")).toEqual({
      chunk_count: 42,
      chunk_count_kind: "chunks",
    });
    // 口径必须跟着走：events 与 chunks 是两个不同的数（事件数 ≤ chunk 数），
    // 只带数字不带口径会让聚合把两者混着平均，得出一个谁也不描述的值。
    expect(chunkCountFields(7, "events").chunk_count_kind).toBe("events");
  });

  test("非数字不产字段（缺数据 ≠ 收到 0 个）", () => {
    expect(chunkCountFields(undefined, "chunks")).toEqual({});
    expect(chunkCountFields(NaN, "chunks")).toEqual({});
    expect(chunkCountFields(Infinity, "chunks")).toEqual({});
  });

  test("读取优先规范名，缺失时回退四个历史名（老轨迹不能静默变 0）", () => {
    // 这是"加新名而不重命名"的全部理由：本机 50 个会话的历史轨迹里没有
    // chunk_count，重命名会让它们在新读取方眼里全变 0 —— 而 0 满足一切健康检查。
    expect(readChunkCount({ chunk_count: 9, chunk_count_kind: "events" })).toEqual({
      count: 9,
      kind: "events",
      field: "chunk_count",
    });
    expect(readChunkCount({ total_chunks: 5 })!.count).toBe(5);
    expect(readChunkCount({ chunks_received: 6 })!.count).toBe(6);
    expect(readChunkCount({ chunks: 7 })!.count).toBe(7);
    expect(readChunkCount({ totalEvents: 8 })).toEqual({
      count: 8,
      kind: "events",
      field: "totalEvents",
    });
    // 规范名优先于历史名（同时存在时不该读到旧值）
    expect(readChunkCount({ chunk_count: 1, total_chunks: 99 })!.count).toBe(1);
    // 没有这个语义时返回 undefined 而不是 0 —— 0 是个结论，不是缺数据。
    expect(readChunkCount({ foo: 1 })).toBeUndefined();
    expect(readChunkCount(undefined)).toBeUndefined();
  });

  test("StreamStall / WatchdogKill 都带规范字段，且老字段原样保留", () => {
    emitStreamPhase(5, "sse_consuming", { model: "m" });
    emitStreamStall(5, { no_content_progress_ms: 40_000, total_chunks: 11, empty_chunks: 2 });
    const stall = captured.find((e) => e.event === "StreamStall")!;
    expect(stall.data.chunk_count).toBe(11);
    expect(stall.data.chunk_count_kind).toBe("chunks");
    expect(stall.data.total_chunks, "老字段必须原样保留（老读取方逐字节不变）").toBe(11);
  });
});
