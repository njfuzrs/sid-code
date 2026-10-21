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
import {
  recordBilledRequest,
  resetBillingSink,
  nextFetchId,
  markFetchInFlight,
  flushInFlightBilledRequests,
  inFlightFetchCount,
} from "../../src/llm/billing-sink.ts";

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

/**
 * 发现 13（20261020 ce7ea52e）：abort 后 provider 生成器被丢下、finally 永不执行，
 * 那次已建连的 fetch 在 events 里只有 HttpConnected 没有 BilledRequest（实测 index 1316，1359 vs 1358）。
 * 会话收尾由 flushInFlightBilledRequests 补记 `reason:"aborted"`；恒等式把它算进右边，
 * 没登记过的建连仍判漏记。
 */
describe("③ 在途 fetch 收尾补记（发现 13）", () => {
  let written: any[] = [];
  beforeEach(() => {
    written = [];
    resetBillingSink();
    initStreamObserver("s-f13", "/tmp", (e) => written.push(e));
  });
  afterEach(() => {
    resetStreamObserver();
    resetBillingSink();
  });

  const snap =
    (fetchId: string, input = 0) =>
    () => ({
      fetchId,
      model: "m",
      provider: "openai",
      usage: { inputTokens: input, outputTokens: 0 },
      index: 1316,
      accounted: false,
    });

  test("正常收口自动注销；被丢下的在收尾补记 aborted 且只记一次", () => {
    const done = nextFetchId();
    const dropped = nextFetchId();
    markFetchInFlight(done, snap(done));
    markFetchInFlight(dropped, snap(dropped, 803619));
    recordBilledRequest({ ...snap(done)(), accounted: true });
    expect(inFlightFetchCount()).toBe(1);

    expect(flushInFlightBilledRequests()).toBe(1);
    expect(flushInFlightBilledRequests()).toBe(0); // 幂等

    const billed = written.filter((e) => e.event === "BilledRequest");
    expect(billed.length).toBe(2);
    const aborted = billed.find((e) => e.data.fetch_id === dropped);
    expect(aborted.data.reason).toBe("aborted");
    expect(aborted.data.input_tokens).toBe(803619);
    expect(aborted.data.accounted).toBe(false);
    expect(billed.find((e) => e.data.fetch_id === done).data.reason).toBeUndefined();
  });

  test("补记之后生成器又被正常 return：真实那条被去重吃掉，不双记", () => {
    const fid = nextFetchId();
    markFetchInFlight(fid, snap(fid));
    flushInFlightBilledRequests();
    recordBilledRequest({ ...snap(fid, 999)(), accounted: true });
    expect(written.filter((e) => e.event === "BilledRequest").length).toBe(1);
  });

  test("digest：aborted 补记算进右边 → 恒等式成立，并单列条数", () => {
    const conn = () => ev("HttpConnected", { status: 200 });
    const events = [
      conn(),
      conn(),
      ev("BilledRequest", { fetch_id: "a" }),
      ev("BilledRequest", { fetch_id: "b", reason: "aborted" }),
    ];
    const p = computeProcessPathology([] as any, events as any);
    expect(p.billingIdentityBroken).toBe(false);
    expect(p.abortedBilledRequests).toBe(1);
  });

  test("digest：没有补记的建连仍判漏记（ce7ea52e 修复前的形态）", () => {
    const conn = () => ev("HttpConnected", { status: 200 });
    const p = computeProcessPathology(
      [] as any,
      [conn(), conn(), ev("BilledRequest", { fetch_id: "a" })] as any,
    );
    expect(p.billingIdentityBroken).toBe(true);
    expect(p.abortedBilledRequests).toBeUndefined();
  });
});

describe("④ 接线（源码断言）", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const read = (rel: string) => readFileSync(join(import.meta.dir, "../../src", rel), "utf-8");

  test("collector 收尾在 resetStreamObserver 之前补记（之后事件写不进 events.jsonl）", () => {
    const src = read("trace/collector.ts");
    const body = src.slice(src.indexOf("private async handleSessionEnd("));
    const flush = body.indexOf("flushInFlightBilledRequests();");
    const reset = body.indexOf("resetStreamObserver();");
    expect(flush).toBeGreaterThan(0);
    expect(reset).toBeGreaterThan(flush);
  });

  test("三条流式路径都登记在途（Chat Completions / Responses / Anthropic）", () => {
    expect(read("llm/openai.ts").split("markFetchInFlight(billingFetchId").length - 1).toBe(2);
    expect(read("llm/anthropic.ts").split("markFetchInFlight(billingFetchId").length - 1).toBe(1);
  });
});
