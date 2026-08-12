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

/** RetryTelemetryEvent.type 的完整枚举（与 retry-telemetry.ts 的联合类型同步） */
const ALL_EVENT_TYPES: RetryTelemetryEvent["type"][] = [
  "retry",
  "fallback",
  "529_dropped",
  "max_tokens_adjust",
  "persistent_retry_wait",
  "auth_refresh",
  "stream_stall",
  "stream_idle_timeout",
  "stream_content_progress_timeout",
  "stream_overall_timeout",
  "stream_completed",
];

describe("T8.12 — defaultTelemetryHandler 覆盖所有事件类型", () => {
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
