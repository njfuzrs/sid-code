/**
 * N12 门禁：side_call_stats resume 回灌 —— 会话维度 = 基线 + 本进程，且不双计成本。
 *
 * 时序照生产：restoreSession（hydrate）先于 doInit 里 TraceCollector 的 SessionStart
 * （resetSideCallStats）。所以 reset 必须不清基线，否则回灌当场失效。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  recordSideCall,
  getSideStats,
  getSessionSideStats,
  hydrateSideCallBaseline,
  resetSideCallStats,
  resetSessionSideStats,
  setSideCostObserver,
} from "@sid-code/core/trace/side-call-sink.ts";

/** 文档 N12.3b 的真实实样 */
const DISK_SAMPLE = {
  apiCalls: 4,
  costUSD: 0.07202700356000453,
  tokensSent: 215830,
  tokensReceived: 242,
  failed: 0,
  timedOut: 0,
  byLabel: {
    "title-generation": { success: 3, failed: 0 },
    "agent:fork": { success: 1, failed: 0 },
  },
};

const call = (label: string, ok = true) =>
  recordSideCall({
    label,
    model: "m",
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    durationMs: 1,
    costUSD: 0.01,
    success: ok,
    timedOut: !ok,
  });

describe("N12：影子调用会话基线", () => {
  beforeEach(() => {
    resetSessionSideStats();
    resetSideCallStats();
  });
  afterEach(() => {
    setSideCostObserver(() => {});
    resetSessionSideStats();
    resetSideCallStats();
  });

  test("生产时序：hydrate → SessionStart reset → 新调用 ⇒ 会话维度 = 基线 + 新调用，6 个字段都在", () => {
    expect(hydrateSideCallBaseline(DISK_SAMPLE)).toBe(true);
    resetSideCallStats(); // TraceCollector.handleSessionStart
    call("title-generation");
    call("recall", false);

    const s = getSessionSideStats();
    expect(s.apiCalls).toBe(6);
    expect(s.tokensSent).toBe(215830 + 200);
    expect(s.tokensReceived).toBe(242 + 20);
    expect(s.failed).toBe(1);
    expect(s.timedOut).toBe(1);
    expect(s.byLabel).toEqual({
      "title-generation": { success: 4, failed: 0 },
      "agent:fork": { success: 1, failed: 0 },
      recall: { success: 0, failed: 1 },
    });
    expect(s.costUSD).toBeCloseTo(DISK_SAMPLE.costUSD + 0.02, 12);
    // 进程维度（trajectory 口径）不含历史 —— 不变
    expect(getSideStats().apiCalls).toBe(2);
  });

  test("hydrate 不触发 costObserver（成本已经经 usage_stats.sideCostUSD 回灌，再通知就翻倍）", () => {
    let observed = 0;
    setSideCostObserver((c) => (observed += c));
    hydrateSideCallBaseline(DISK_SAMPLE);
    expect(observed).toBe(0);
  });

  test("/clear：会话维度归零，进程维度保留给 trajectory；之后的新调用照常计入", () => {
    hydrateSideCallBaseline(DISK_SAMPLE);
    call("a");
    resetSessionSideStats();
    expect(getSessionSideStats().apiCalls).toBe(0);
    expect(getSessionSideStats().byLabel).toEqual({});
    expect(getSideStats().apiCalls).toBe(1);
    call("b");
    expect(getSessionSideStats().apiCalls).toBe(1);
    expect(Object.keys(getSessionSideStats().byLabel)).toEqual(["b"]);
  });

  test("形态不合法整条拒绝（宁可从零开始也不拿半截脏数据当基线）", () => {
    expect(hydrateSideCallBaseline(null)).toBe(false);
    expect(hydrateSideCallBaseline({ apiCalls: "4" })).toBe(false);
    expect(hydrateSideCallBaseline({ ...DISK_SAMPLE, tokensSent: -1 })).toBe(false);
    expect(hydrateSideCallBaseline({ ...DISK_SAMPLE, byLabel: ["title-generation"] })).toBe(false);
    expect(getSessionSideStats().apiCalls).toBe(0);
  });

  test("旧版本快照缺 failed / timedOut / byLabel ⇒ 按 0 / 空回灌", () => {
    expect(
      hydrateSideCallBaseline({ apiCalls: 2, costUSD: 0.1, tokensSent: 5, tokensReceived: 1 }),
    ).toBe(true);
    const s = getSessionSideStats();
    expect(s).toEqual({
      apiCalls: 2,
      costUSD: 0.1,
      tokensSent: 5,
      tokensReceived: 1,
      failed: 0,
      timedOut: 0,
      byLabel: {},
    });
  });

  test("getSessionSideStats 返回副本：改返回值不污染基线", () => {
    hydrateSideCallBaseline(DISK_SAMPLE);
    getSessionSideStats().byLabel["agent:fork"]!.success = 999;
    expect(getSessionSideStats().byLabel["agent:fork"]!.success).toBe(1);
  });
});
