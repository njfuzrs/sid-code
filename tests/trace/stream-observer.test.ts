/**
 * stream-observer 单元测试
 *
 * 覆盖 hang 诊断可观测性的核心行为：
 * - armIneffectiveCheck：超时 fire 后若未 disarm → 发 TimeoutIneffective（缺口 2 进阶，事故指纹）
 * - armIneffectiveCheck：及时 disarm → 不发事件（超时正常生效）
 * - emitHttpConnected：独立 HttpConnected 事件（缺口 6）
 * - emitStreamPhase / 快照：headers_received 更新 http_status/ttfb（缺口 1/6）
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  initStreamObserver,
  resetStreamObserver,
  armIneffectiveCheck,
  emitHttpConnected,
  emitStreamPhase,
  emitTimeoutFired,
  getStreamSnapshot,
} from "../../src/trace/stream-observer.ts";

// 捕获所有写入的事件
let captured: Array<{ event: string; data: Record<string, unknown> }>;

beforeEach(() => {
  captured = [];
  initStreamObserver("test-session", "/tmp/test-session", (ev) => {
    captured.push({ event: ev.event, data: ev.data });
  });
});

afterEach(() => {
  resetStreamObserver();
});

const eventsOf = (name: string) => captured.filter((e) => e.event === name);

describe("armIneffectiveCheck（缺口 2 进阶）", () => {
  test("未 disarm → 宽限期后发出 TimeoutIneffective", async () => {
    armIneffectiveCheck(13, "turn_hard_timeout", "promise_race_not_settled_after_5s", 30);
    // 不调用 disarm，等待超过宽限期
    await new Promise((r) => setTimeout(r, 80));

    const ineffective = eventsOf("TimeoutIneffective");
    expect(ineffective.length).toBe(1);
    expect(inefFirst(ineffective).layer).toBe("turn_hard_timeout");
    expect(inefFirst(ineffective).index).toBe(13);
    expect(inefFirst(ineffective).reason).toBe("promise_race_not_settled_after_5s");
  });

  test("宽限期内 disarm → 不发出 TimeoutIneffective（超时正常生效）", async () => {
    const disarm = armIneffectiveCheck(13, "idle_timeout", "read_race_not_settled_after_5s", 60);
    // 立即 disarm，模拟 race 已 settle
    disarm();
    await new Promise((r) => setTimeout(r, 100));

    expect(eventsOf("TimeoutIneffective").length).toBe(0);
  });

  test("disarm 幂等 —— 多次调用无副作用", async () => {
    const disarm = armIneffectiveCheck(1, "header_timeout", "fetch_not_settled_after_5s", 30);
    disarm();
    disarm();
    disarm();
    await new Promise((r) => setTimeout(r, 60));
    expect(eventsOf("TimeoutIneffective").length).toBe(0);
  });
});

describe("emitHttpConnected（缺口 6）", () => {
  test("发出独立 HttpConnected 事件，含 status/content_type/ttfb", () => {
    emitHttpConnected(5, {
      status: 200,
      content_type: "text/event-stream",
      ttfb_ms: 1523,
      model: "deepseek-v4-pro",
    });
    const ev = eventsOf("HttpConnected");
    expect(ev.length).toBe(1);
    expect(ev[0].data.index).toBe(5);
    expect(ev[0].data.status).toBe(200);
    expect(ev[0].data.content_type).toBe("text/event-stream");
    expect(ev[0].data.ttfb_ms).toBe(1523);
  });
});

describe("emitStreamPhase 快照更新（缺口 1/6）", () => {
  test("headers_received 更新快照 http_status + ttfb", () => {
    emitStreamPhase(7, "fetch_sent", { model: "m" });
    emitStreamPhase(7, "headers_received", { http_status: 200, ttfb_ms: 800, model: "m" });

    const snap = getStreamSnapshot(7);
    expect(snap?.httpStatusReceived).toBe(true);
    expect(snap?.httpStatus).toBe(200);
    expect(snap?.ttfbMs).toBe(800);
    expect(snap?.phase).toBe("headers_received");

    // StreamPhase 事件也应写出
    expect(eventsOf("StreamPhase").length).toBe(2);
  });

  test("emitTimeoutFired 累积到快照 timeoutsFired", () => {
    emitStreamPhase(9, "sse_consuming", { model: "m" });
    emitTimeoutFired(9, "idle_timeout", { threshold_ms: 1000 });
    emitTimeoutFired(9, "content_progress_timeout", { threshold_ms: 2000 });

    const snap = getStreamSnapshot(9);
    expect(snap?.timeoutsFired).toEqual(["idle_timeout", "content_progress_timeout"]);
    expect(eventsOf("TimeoutFired").length).toBe(2);
  });
});

// ─── 辅助 ───
function inefFirst(list: Array<{ data: Record<string, unknown> }>) {
  return list[0].data as { layer: string; index: number; reason: string };
}
