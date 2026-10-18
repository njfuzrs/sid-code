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
      effortWire: "omitted",
      thinkingInResponse: false,
      thinkingIntent: false,
    });
    const d = written.find((e) => e.event === "BilledRequest")!.data!;
    expect(d.thinking_wire).toBe("disabled");
    // E9：线上实发 effort 档进 events.jsonl
    expect(d.effort_wire).toBe("omitted");
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
    expect("effort_wire" in d).toBe(false);
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

  /** 新口径记录：默认 toggle + 设置 off */
  const off = (data: Record<string, unknown>): Ev =>
    br({ thinking_setting: "off", thinking_control: "toggle", thinking_intent: false, ...data });

  test("主循环 / 非主循环分开算，分母只含「设置 off × toggle」；恒思考 / 无开关族单列", () => {
    const stats = aggregateThinkingLeakStats([
      // 主循环（无 agent_id / caller）：设置关、发了 omitted、仍思考 → 泄漏（D1 的形态）
      off({
        accounted: true,
        model: "claude-sonnet-5",
        thinking_wire: "omitted",
        thinking_in_response: true,
      }),
      // 主循环：设置关、disabled、没思考
      off({
        accounted: true,
        model: "claude-sonnet-5",
        thinking_wire: "disabled",
        thinking_in_response: false,
      }),
      // 主循环：设置开 → 不进分母
      br({
        accounted: true,
        model: "claude-sonnet-5",
        thinking_wire: "adaptive",
        thinking_setting: "on",
        thinking_control: "toggle",
        thinking_intent: true,
        thinking_in_response: true,
      }),
      // Anthropic 恒思考：线上 adaptive → 关不掉，不进分母
      off({
        accounted: true,
        model: "claude-opus-5-5",
        thinking_control: "locked-on",
        thinking_wire: "adaptive",
        thinking_in_response: true,
      }),
      // side-call：设置关、disabled、没思考
      off({
        accounted: false,
        caller: "recall",
        model: "claude-sonnet-5",
        thinking_wire: "disabled",
        thinking_in_response: false,
      }),
      // 子代理经 usage-sink 入账（S13 把 accounted 改写成 true）：仍属非主循环
      off({
        accounted: true,
        accounted_by: "usage-sink",
        agent_id: "a1",
        model: "claude-sonnet-5",
        thinking_wire: "disabled",
        thinking_in_response: true,
      }),
      // side-call：设置关、omitted、思考了
      off({
        accounted: false,
        caller: "compact",
        model: "deepseek-v4-pro",
        thinking_wire: "omitted",
        thinking_in_response: true,
      }),
    ])!;
    expect(stats.main).toEqual({ offRequests: 2, leaked: 1, rate: 0.5 });
    expect(stats.nonMain).toEqual({ offRequests: 3, withThinking: 2, rate: 2 / 3 });
    expect(stats.lockedOn).toBe(1);
    expect(stats.byModel["deepseek-v4-pro"]).toEqual({ offRequests: 1, withThinking: 1 });
  });

  test("R1：OpenAI 族恒思考（omitted + 有 reasoning）记「关不掉」，不记主循环泄漏", () => {
    // GLM-5.3 的 off 在 openai.ts 被降级为不下发 → 线上 omitted；修前只拦 enabled/adaptive，
    // 这条会落进主循环分母并计 1 次泄漏。
    const stats = aggregateThinkingLeakStats([
      off({
        accounted: true,
        model: "glm-5.3",
        thinking_control: "locked-on",
        thinking_wire: "omitted",
        thinking_in_response: true,
      }),
    ])!;
    expect(stats.main.offRequests).toBe(0);
    expect(stats.main.leaked).toBe(0);
    expect(stats.lockedOn).toBe(1);
  });

  test("R1：无开关族（gpt-5.x / kimi）单列，不进分母", () => {
    const stats = aggregateThinkingLeakStats([
      off({
        accounted: true,
        model: "gpt-5.6",
        thinking_control: "none",
        thinking_wire: "omitted",
        thinking_in_response: true,
      }),
    ])!;
    expect(stats.main.offRequests).toBe(0);
    expect(stats.noToggle).toBe(1);
  });

  test("R6：auto 解析成关不进分母，单列参考", () => {
    const stats = aggregateThinkingLeakStats([
      br({
        accounted: true,
        model: "claude-opus-4-8",
        thinking_wire: "omitted",
        thinking_setting: "auto",
        thinking_control: "toggle",
        thinking_intent: false,
        thinking_in_response: true,
      }),
    ])!;
    expect(stats.main.offRequests).toBe(0);
    expect(stats.autoResolvedOff).toBe(1);
  });

  test("R5：没有 thinking_wire 的记录计入 uninstrumented；老口径记录计入 legacy、不进分母", () => {
    const stats = aggregateThinkingLeakStats([
      br({ accounted: true, model: "gpt-5.6" }),
      br({
        accounted: true,
        model: "claude-sonnet-5",
        thinking_wire: "omitted",
        thinking_intent: false,
        thinking_in_response: true,
      }),
    ])!;
    expect(stats.uninstrumented).toBe(1);
    expect(stats.legacy).toBe(1);
    expect(stats.main.offRequests).toBe(0);
  });

  test("R10：展示 ≠ 实发——两者都给出才比，omitted 且服务端默认未知记不可判", () => {
    const stats = aggregateThinkingLeakStats([
      // 后缀真名（M2）：展示关，线上不发、注册表无精确命中 → 不可判
      off({
        accounted: true,
        model: "gw",
        thinking_wire: "omitted",
        thinking_shown: false,
      }),
      // 展示关、线上 disabled → 一致
      off({
        accounted: true,
        model: "claude-sonnet-5",
        thinking_wire: "disabled",
        thinking_shown: false,
        thinking_wire_thinks: false,
      }),
      // 展示关、线上却 adaptive → 不一致
      off({
        accounted: true,
        model: "x",
        thinking_wire: "adaptive",
        thinking_shown: false,
        thinking_wire_thinks: true,
      }),
      // none 族不比
      off({
        accounted: true,
        model: "gpt-5.6",
        thinking_control: "none",
        thinking_wire: "omitted",
        thinking_shown: true,
        thinking_wire_thinks: false,
      }),
    ])!;
    expect(stats.shownVsWire).toEqual({ compared: 2, mismatched: 1, unknown: 1, rate: 0.5 });
  });

  test("有埋点但没有设置关的请求 → rate 为 undefined（无样本不落 0）", () => {
    const stats = aggregateThinkingLeakStats([
      br({
        accounted: true,
        model: "m",
        thinking_wire: "adaptive",
        thinking_setting: "on",
        thinking_control: "toggle",
        thinking_intent: true,
        thinking_in_response: true,
      }),
    ])!;
    expect(stats.main.rate).toBeUndefined();
    expect(stats.nonMain.rate).toBeUndefined();
  });
});
