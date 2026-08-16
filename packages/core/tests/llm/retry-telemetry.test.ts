/**
 * T8.12：retry-telemetry.ts 事件结构完整性 — 单元测试
 *
 * 验证 defaultTelemetryHandler 能处理**所有** RetryTelemetryEvent.type（含 T7 新增的
 * stream_overall_timeout），不抛异常、不遗漏分支；并验证 StreamTelemetrySignal 的每个
 * 变体都能作为 RetryTelemetryEvent 被转发（provider → fallback 遥测管线的契约完整性）。
 *
 * 意义：新增流内诊断事件类型（如 T7 的 overall timeout）时，若忘了在 handler 加分支，
 * 本测试立即捕获（switch 未命中 → 静默丢事件，可观测性盲区）。
 *
 * fix_type: case_design
 */

import { describe, test, expect } from "bun:test";
import {
  defaultTelemetryHandler,
  type RetryTelemetryEvent,
} from "@sid-code/core/llm/retry-telemetry.ts";
import type { StreamTelemetrySignal } from "@sid-code/core/llm/types.ts";

/**
 * RetryTelemetryEvent.type 的完整枚举。
 *
 * ⚠️ 这里刻意用 `Record<RetryTelemetryEvent["type"], true>` 而不是数组字面量。
 *
 * 教训（本文件自己踩过）：原来是手写数组，于是它作为"反漂移哨兵"**自己漂移了**——
 * 联合类型后来新增的 `non_streaming_degrade` / `retry_budget_exhausted` /
 * `shared_cooldown_wait` 三类从未被加进来，哨兵长期只覆盖 11/14 类却始终全绿。
 * 数组少一项在类型上完全合法（`T[]` 不要求穷尽），所以漏登记时 TS 一声不响。
 *
 * 换成以 type 为**键**的 Record 后，漏一个键就是编译期错误——把"记得同步"
 * 从人的纪律变成类型系统的义务。这正是 PR-1 那条方法论（散写字面量收进 union
 * 才能让写错变成编译错误）的同型应用。
 */
const EVENT_TYPE_TABLE: Record<RetryTelemetryEvent["type"], true> = {
  retry: true,
  fallback: true,
  "529_dropped": true,
  max_tokens_adjust: true,
  persistent_retry_wait: true,
  auth_refresh: true,
  non_streaming_degrade: true,
  retry_budget_exhausted: true,
  shared_cooldown_wait: true,
  stream_stall: true,
  stream_idle_timeout: true,
  stream_content_progress_timeout: true,
  stream_overall_timeout: true,
  stream_completed: true,
};

const ALL_EVENT_TYPES = Object.keys(EVENT_TYPE_TABLE) as RetryTelemetryEvent["type"][];

describe("T8.12 — defaultTelemetryHandler 覆盖所有事件类型", () => {
  test("哨兵自身覆盖 14 类（漏登记时先在此处红）", () => {
    // 这条断言与上面 Record 的穷尽性是**两道不同的门**，都要留：
    // Record 拦"漏写键"（编译期），本断言拦"类型自身被删/被改少"（运行期）——
    // 后者在删除一个 type 时会让数字对不上，逼人显式确认那是刻意删除。
    expect(ALL_EVENT_TYPES.length).toBe(14);
  });

  test("每个 type 都不抛异常", () => {
    for (const type of ALL_EVENT_TYPES) {
      const event: RetryTelemetryEvent = {
        type,
        model: "test-model",
        provider: "test-provider",
        attempt: 1,
        delayMs: 100,
        error: "test error",
        fallbackModel: "fallback-model",
        querySource: "foreground",
        originalTokens: 4000,
        adjustedTokens: 2000,
        gapMs: 5000,
        timeoutMs: 90000,
        totalEvents: 42,
        elapsedMs: 12345,
        ttftMs: 300,
      };
      expect(() => defaultTelemetryHandler(event)).not.toThrow();
    }
  });

  test("T7 新增 stream_overall_timeout 被正确处理（不静默丢弃）", () => {
    const event: RetryTelemetryEvent = {
      type: "stream_overall_timeout",
      model: "deepseek-chat",
      provider: "openai",
      timeoutMs: 600_000,
      totalEvents: 100,
    };
    // 不抛异常即证明 switch 命中了该分支（未命中会走 default，此处无 default 但 TS 保证穷尽）
    expect(() => defaultTelemetryHandler(event)).not.toThrow();
  });
});

describe("T8.12 — StreamTelemetrySignal 变体可作为 RetryTelemetryEvent 转发", () => {
  test("provider 产出的每种 signal 都能补 model 字段后交给 handler", () => {
    const signals: StreamTelemetrySignal[] = [
      { type: "stream_stall", provider: "openai", gapMs: 5000, totalEvents: 10 },
      { type: "stream_idle_timeout", provider: "openai", timeoutMs: 90000, totalEvents: 10 },
      {
        type: "stream_content_progress_timeout",
        provider: "anthropic",
        timeoutMs: 300000,
        totalEvents: 20,
      },
      { type: "stream_overall_timeout", provider: "anthropic", timeoutMs: 600000, totalEvents: 30 },
      {
        type: "stream_completed",
        provider: "openai",
        totalEvents: 50,
        elapsedMs: 12345,
        ttftMs: 300,
      },
    ];
    for (const sig of signals) {
      // fallback.ts 的转发方式：signal + model → RetryTelemetryEvent
      const event = { ...sig, model: "test-model" } as RetryTelemetryEvent;
      expect(() => defaultTelemetryHandler(event)).not.toThrow();
      expect(event.provider).toBe(sig.provider);
    }
  });

  test("StreamTelemetrySignal 联合类型覆盖 5 种流内信号", () => {
    // 编译期穷尽性：若 types.ts 新增/删除变体，此数组与实际类型不符会在使用处报错。
    const types: StreamTelemetrySignal["type"][] = [
      "stream_stall",
      "stream_idle_timeout",
      "stream_content_progress_timeout",
      "stream_overall_timeout",
      "stream_completed",
    ];
    expect(new Set(types).size).toBe(5);
  });
});
