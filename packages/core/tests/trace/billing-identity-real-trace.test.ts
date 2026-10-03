/**
 * B47：计费恒等式落到真实轨迹 —— `BilledRequest` 落 events.jsonl + digest 逐会话复算。
 *
 * 此前恒等式只在 `billing-identity-invariant.test.ts` 里用造出来的事件断言，
 * 计费事件不落盘，真实会话没法数。本文件锁两件事：
 *   ① `recordBilledRequest` 去重后确实落一条 `BilledRequest`（重复 fetchId 不重复落）；
 *   ② `computeProcessPathology` 在两边不等时报 `billingIdentityBroken`，老轨迹不误报。
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { computeProcessPathology } from "../../src/trace/digest.ts";
import { initStreamObserver, resetStreamObserver } from "../../src/trace/stream-observer.ts";
import { recordBilledRequest, resetBillingSink, nextFetchId } from "../../src/llm/billing-sink.ts";

function ev(event: string, data: Record<string, unknown> = {}) {
  return { event, session_id: "s", timestamp: "2026-10-02T06:00:00.000Z", data };
}

describe("① BilledRequest 落盘", () => {
  let written: any[] = [];
  beforeEach(() => {
    written = [];
    resetBillingSink();
    initStreamObserver("s-b47", "/tmp", (e) => written.push(e));
  });
  afterEach(() => {
    resetStreamObserver();
    resetBillingSink();
  });

  test("去重后每个 fetch 恰好落一条，含身份与 usage", () => {
    const fid = nextFetchId();
    const req = {
      fetchId: fid,
      model: "m",
      provider: "openai",
      usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 80 },
      index: 3,
      agentId: "fork:memory-extract",
      accounted: false,
    };
    recordBilledRequest(req);
    recordBilledRequest(req); // 同一 fetch 两条出口都 emit —— 只能落一条
    recordBilledRequest({ ...req, fetchId: nextFetchId(), agentId: undefined, accounted: true });

    const billed = written.filter((e) => e.event === "BilledRequest");
    expect(billed.length).toBe(2);
    expect(billed[0].data).toMatchObject({
      fetch_id: fid,
      index: 3,
      agent_id: "fork:memory-extract",
      accounted: false,
      charged: true,
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 80,
    });
    // 主循环：已入账，消费侧不加钱
    expect(billed[1].data.accounted).toBe(true);
    expect(billed[1].data.charged).toBe(false);
    expect(billed[1].data.agent_id).toBeUndefined();
  });
});

describe("② digest 复算恒等式", () => {
  const conn = (status = 200, ct = "text/event-stream") =>
    ev("HttpConnected", { status, content_type: ct });
  const billed = () => ev("BilledRequest", { fetch_id: "f" });

  test("相等 → 不报", () => {
    const events = [conn(), conn(), conn(), billed(), billed(), billed()];
    const p = computeProcessPathology([] as any, events as any);
    expect(p.billableConnections).toBe(3);
    expect(p.billedRequests).toBe(3);
    expect(p.billingIdentityBroken).toBe(false);
  });

  test("计费事件少于建连 → 报（有调用链漏记）", () => {
    const events = [conn(), conn(), conn(), billed(), billed()];
    const p = computeProcessPathology([] as any, events as any);
    expect(p.billingIdentityBroken).toBe(true);
  });

  test("计费事件多于建连 → 报（去重失效）", () => {
    const events = [conn(), billed(), billed()];
    const p = computeProcessPathology([] as any, events as any);
    expect(p.billingIdentityBroken).toBe(true);
  });

  test("非 2xx 与 text/html 错误页不进左边（厂商不计费，不该误报）", () => {
    const events = [conn(), conn(429), conn(200, "text/html; charset=utf-8"), billed()];
    const p = computeProcessPathology([] as any, events as any);
    expect(p.billableConnections).toBe(1);
    expect(p.billingIdentityBroken).toBe(false);
  });

  test("老轨迹（无 BilledRequest）不判 —— 否则全部历史会话报红", () => {
    const events = [conn(), conn()];
    const p = computeProcessPathology([] as any, events as any);
    expect(p.billedRequests).toBeUndefined();
    expect(p.billingIdentityBroken).toBe(false);
  });
});
