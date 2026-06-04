import { describe, expect, test, beforeEach } from "bun:test";
import {
  logEvent,
  attachAnalyticsSink,
  hasAnalyticsSink,
  getQueuedEventCount,
  __resetAnalyticsForTest,
  type AnalyticsSink,
  type EventMetadata,
} from "../../src/analytics/index.ts";

describe("analytics 零依赖事件 API（spec 17 §3.1）", () => {
  beforeEach(() => {
    __resetAnalyticsForTest();
  });

  test("Sink 未绑定时事件暂存到队列", () => {
    logEvent("test_event", { count: 1 });
    expect(getQueuedEventCount()).toBe(1);
    expect(hasAnalyticsSink()).toBe(false);
  });

  test("绑定 Sink 后异步排空队列", async () => {
    logEvent("event_a", { count: 1 });
    logEvent("event_b", { flag: true });

    const received: Array<{ name: string; meta: EventMetadata }> = [];
    const sink: AnalyticsSink = {
      logEvent: (name, meta) => received.push({ name, meta }),
    };
    attachAnalyticsSink(sink);

    // 排空在 microtask 中进行
    await Promise.resolve();
    await Promise.resolve();

    expect(received.length).toBe(2);
    expect(received[0].name).toBe("event_a");
    expect(received[1].name).toBe("event_b");
    expect(getQueuedEventCount()).toBe(0);
  });

  test("绑定后新事件直接发送到 Sink，不入队", () => {
    const received: string[] = [];
    attachAnalyticsSink({ logEvent: (name) => received.push(name) });

    logEvent("direct_event", {});
    expect(received).toEqual(["direct_event"]);
    expect(getQueuedEventCount()).toBe(0);
  });

  test("attachAnalyticsSink 幂等——第二次绑定不生效", () => {
    const first: string[] = [];
    const second: string[] = [];
    attachAnalyticsSink({ logEvent: (n) => first.push(n) });
    attachAnalyticsSink({ logEvent: (n) => second.push(n) });

    logEvent("e1", {});
    expect(first).toEqual(["e1"]);
    expect(second).toEqual([]);
  });

  test("Sink 抛错被静默吞掉，不影响主流程", () => {
    attachAnalyticsSink({
      logEvent: () => {
        throw new Error("sink boom");
      },
    });
    // 不应抛出
    expect(() => logEvent("e", {})).not.toThrow();
  });

  test("队列溢出保护——超过上限丢弃最旧事件", () => {
    for (let i = 0; i < 1100; i++) {
      logEvent(`e${i}`, { n: i });
    }
    expect(getQueuedEventCount()).toBe(1000);
  });
});
