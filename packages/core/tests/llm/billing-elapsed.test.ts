/**
 * 计费事件的耗时字段（D8，2026-11-10 成本口径核查）。
 *
 * ## 它防的是什么
 *
 * `/cost` 要显示「辅助调用耗时」，数据链是
 * `provider 计算墙钟耗时 → BilledRequest.elapsedMs → app.ts 的 billing 观察者
 * → recordSideCall.durationMs → getSideStats()`。
 * 这条链的任何一段断掉，面板上的耗时就是 0 或「—」，而**恢复「写死 0」的旧行为
 * 不会有任何编译错误** —— 所以中段必须由测试钉住。
 *
 * ## 为什么 undefined 和 0 必须区分
 *
 * `flushInFlightBilledRequests` 补记的 aborted 事件、以及任何没接计时的路径都拿不到
 * 耗时。把它们补成 0 会让汇总静默低估；正确做法是留 undefined，显示层写「—」。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  recordBilledRequest,
  recordNonStreamingBilledRequest,
  addBillingObserver,
  resetBillingSink,
  nextFetchId,
  type BilledRequest,
} from "../../src/llm/billing-sink.ts";

describe("BilledRequest.elapsedMs（D8）", () => {
  let seen: BilledRequest[];

  beforeEach(() => {
    resetBillingSink();
    seen = [];
    addBillingObserver((req) => seen.push(req));
  });
  afterEach(() => resetBillingSink());

  test("流式收口带的耗时原样到达观察者（app.ts 用它填 SideCallRecord）", () => {
    recordBilledRequest({
      fetchId: nextFetchId(),
      model: "test-model",
      provider: "openai",
      usage: { inputTokens: 1000, outputTokens: 100 },
      index: 1,
      agentId: "fork:memory-extract",
      callerLabel: "agent:fork",
      accounted: false,
      elapsedMs: 1234,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.elapsedMs).toBe(1234);
  });

  test("没有耗时（未采集）时字段缺席，不是 0", () => {
    recordBilledRequest({
      fetchId: nextFetchId(),
      model: "test-model",
      provider: "openai",
      usage: { inputTokens: 1000, outputTokens: 100 },
      index: 2,
      agentId: "fork:memory-extract",
      callerLabel: "agent:fork",
      accounted: false,
    });

    expect(seen[0]?.elapsedMs).toBeUndefined();
    expect("elapsedMs" in (seen[0] ?? {})).toBe(false);
  });

  test("非流式收口同样透传（两条路径口径一致，漏一条就低估）", () => {
    recordNonStreamingBilledRequest({
      fetchId: nextFetchId(),
      model: "test-model",
      provider: "anthropic",
      usage: { inputTokens: 500, outputTokens: 50 },
      elapsedMs: 5678,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.elapsedMs).toBe(5678);
  });
});
