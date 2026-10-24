/**
 * §6 缓存缺陷的 digest 验收口径（PromptCacheLayout / ColdCacheClear 聚合）
 */

import { describe, test, expect } from "bun:test";
import { aggregatePromptCacheStats } from "@sid-code/core/trace/digest.ts";

const HOUR = 60 * 60 * 1000;

describe("aggregatePromptCacheStats", () => {
  test("两类事件都没有 → null（老会话 / 非 Anthropic，不画这一段）", () => {
    expect(aggregatePromptCacheStats([{ event: "BeforeModel", data: {} }])).toBeNull();
  });

  test("断点落在 reminder 上的次数单独计数，分母一并给出", () => {
    const s = aggregatePromptCacheStats([
      {
        event: "PromptCacheLayout",
        data: { transient_blocks: 2, message_breakpoint_on_transient: false },
      },
      {
        event: "PromptCacheLayout",
        data: { transient_blocks: 0, message_breakpoint_on_transient: false },
      },
      {
        event: "PromptCacheLayout",
        data: { transient_blocks: 1, message_breakpoint_on_transient: true },
      },
    ])!;
    expect(s.layoutRequests).toBe(3);
    expect(s.requestsWithTransient).toBe(2);
    expect(s.breakpointOnTransient).toBe(1);
  });

  test("冷清理间隔低于阈值计为回归；未知间隔也计为回归（违反「不知道即热」）", () => {
    const s = aggregatePromptCacheStats([
      {
        event: "ColdCacheClear",
        data: { gap_ms: 2 * HOUR, threshold_ms: HOUR, cleared: 3, saved_chars: 900 },
      },
      {
        event: "ColdCacheClear",
        data: { gap_ms: 114_000, threshold_ms: HOUR, cleared: 1, saved_chars: 100 },
      },
      {
        event: "ColdCacheClear",
        data: { gap_ms: -1, threshold_ms: HOUR, cleared: 1, saved_chars: 50 },
      },
    ])!;
    expect(s.coldClears).toBe(3);
    expect(s.coldClearedItems).toBe(5);
    expect(s.coldClearedChars).toBe(1050);
    expect(s.coldClearsUnderThreshold).toBe(2);
    expect(s.minColdGapMs).toBe(114_000);
  });
});
