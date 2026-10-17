/**
 * PR-5：思考三态入轨迹 + side-call 埋点 + digest 泄漏率（20261016 思考开关排查 §4.7 / §8.8）。
 *
 * 核心判据：side-call 的「关思考」效果必须能从 events.jsonl 复算，不能再是 raw.jsonl 的恒 n=0。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  recordBilledRequest,
  resetBillingSink,
  nextFetchId,
  observedThinkingIntent,
} from "../../src/llm/billing-sink.ts";
import { initStreamObserver, resetStreamObserver } from "../../src/trace/stream-observer.ts";
import { thinkingWireLabel, buildThinkingWire } from "../../src/llm/anthropic.ts";
import { aggregateThinkingLeakStats } from "../../src/trace/digest.ts";
import { SIDE_CALL_NO_THINK } from "../../src/llm/side-call-timeout.ts";

type Ev = { event?: string; data?: Record<string, unknown> };

describe("BilledRequest 落盘 thinking 三字段", () => {
  let written: Ev[];
  beforeEach(() => {
    resetBillingSink();
    written = [];
    initStreamObserver("s-test", "/tmp", (e) => written.push(e as Ev));
  });
  afterEach(() => {
    resetStreamObserver();
    resetBillingSink();
  });

  test("side-call 的 thinking_wire / thinking_in_response / thinking_intent 进 events.jsonl", () => {
    recordBilledRequest({
      fetchId: nextFetchId(),
      model: "claude-sonnet-5",
      provider: "anthropic",
      usage: { inputTokens: 10, outputTokens: 5 },
      index: 900_003,
      callerLabel: "title_generation",
      accounted: false,
      thinkingWire: "disabled",
      thinkingInResponse: false,
      thinkingIntent: false,
    });
    const d = written.find((e) => e.event === "BilledRequest")!.data!;
    expect(d.thinking_wire).toBe("disabled");
    expect(d.thinking_in_response).toBe(false);
    expect(d.thinking_intent).toBe(false);
    expect(d.caller).toBe("title_generation");
  });

  test("未接线的路径不写字段（缺省 ≠ 没发）", () => {
    recordBilledRequest({
      fetchId: nextFetchId(),
      model: "m",
      provider: "openai",
      usage: { inputTokens: 1, outputTokens: 1 },
      index: 1,
      accounted: true,
    });
    const d = written.find((e) => e.event === "BilledRequest")!.data!;
    expect("thinking_wire" in d).toBe(false);
    expect("thinking_intent" in d).toBe(false);
  });
});

describe("observedThinkingIntent", () => {
  test("thinkingIntent 优先；SIDE_CALL_NO_THINK 推断为 false；enabled:true 不反推", () => {
    expect(
      observedThinkingIntent({ thinkingIntent: { thinking: false }, thinking: { enabled: true } }),
    ).toBe(false);
    expect(observedThinkingIntent({ thinking: { ...SIDE_CALL_NO_THINK } })).toBe(false);
    expect(observedThinkingIntent({ thinking: { enabled: true } })).toBeUndefined();
    expect(observedThinkingIntent({})).toBeUndefined();
  });
});

describe("thinkingWireLabel 读的是线上实发的 param", () => {
  const p = (enabled: boolean) => ({
    model: "x",
    messages: [],
    maxTokens: 1,
    thinking: { enabled, budgetTokens: 0 },
  });
  test("Sonnet 5 off → disabled；未注册旧模型 off → omitted", () => {
    expect(thinkingWireLabel(buildThinkingWire(p(false), "claude-sonnet-5").param)).toBe(
      "disabled",
    );
    expect(thinkingWireLabel(buildThinkingWire(p(false), "claude-3-haiku-20240307").param)).toBe(
      "omitted",
    );
  });
});

describe("aggregateThinkingLeakStats", () => {
  const br = (data: Record<string, unknown>): Ev => ({ event: "BilledRequest", data });

  test("老轨迹（无 thinking_wire）→ undefined，不报 0%", () => {
    expect(aggregateThinkingLeakStats([br({ accounted: true, model: "m" })])).toBeUndefined();
  });

  test("主循环 / 非主循环分开算，分母只含意图关的 fetch；恒思考模型单列", () => {
    const stats = aggregateThinkingLeakStats([
      // 主循环：意图关、发了 omitted、仍思考 → 泄漏（D1 的形态）
      br({
        accounted: true,
        model: "claude-sonnet-5",
        thinking_wire: "omitted",
        thinking_intent: false,
        thinking_in_response: true,
      }),
      // 主循环：意图关、disabled、没思考
      br({
        accounted: true,
        model: "claude-sonnet-5",
        thinking_wire: "disabled",
        thinking_intent: false,
        thinking_in_response: false,
      }),
      // 主循环：意图开 → 不进分母
      br({
        accounted: true,
        model: "claude-sonnet-5",
        thinking_wire: "adaptive",
        thinking_intent: true,
        thinking_in_response: true,
      }),
      // 恒思考模型：意图关但线上 adaptive → 单列，不进分母
      br({
        accounted: true,
        model: "claude-opus-5-5",
        thinking_wire: "adaptive",
        thinking_intent: false,
        thinking_in_response: true,
      }),
      // side-call：意图关、disabled、没思考
      br({
        accounted: false,
        caller: "recall",
        model: "claude-sonnet-5",
        thinking_wire: "disabled",
        thinking_intent: false,
        thinking_in_response: false,
      }),
      // side-call：意图关、omitted、思考了
      br({
        accounted: false,
        caller: "compact",
        model: "deepseek-v4-pro",
        thinking_wire: "omitted",
        thinking_intent: false,
        thinking_in_response: true,
      }),
    ])!;
    expect(stats.main).toEqual({ offRequests: 2, leaked: 1, rate: 0.5 });
    expect(stats.nonMain).toEqual({ offRequests: 2, withThinking: 1, rate: 0.5 });
    expect(stats.offButSentOn).toBe(1);
    expect(stats.byModel["deepseek-v4-pro"]).toEqual({ offRequests: 1, withThinking: 1 });
  });

  test("有埋点但没有意图关的请求 → rate 为 undefined（无样本不落 0）", () => {
    const stats = aggregateThinkingLeakStats([
      br({
        accounted: true,
        model: "m",
        thinking_wire: "adaptive",
        thinking_intent: true,
        thinking_in_response: true,
      }),
    ])!;
    expect(stats.main.rate).toBeUndefined();
    expect(stats.nonMain.rate).toBeUndefined();
  });
});
