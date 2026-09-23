/**
 * M4 热路径预算：logContextAssembled 单次耗时相对「一轮 LLM 往返下限」必须 <2%。
 *
 * 主规划原文「热路径影响 <2%」。startup_timing 噪声 57%，不能作主判据。
 * 这里测的是 emit 路径本身：同步 push + 对象展开，预期远低于 2%
 * （通常 <0.01%）。若接近 2%，说明埋点里混进了 O(n)（例如误调 estimateTokens）。
 *
 * 参照下限写死 50ms：真实 LLM 往返 p5 是秒级，50ms 已经极度保守。
 * 用固定下限而不是读本机轨迹，是为了这条测试在 CI runner 上也能跑、不依赖 ~/.sid-code。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { logContextAssembled } from "@sid-code/core/analytics/events.ts";
import { __resetAnalyticsForTest, attachAnalyticsSink } from "@sid-code/core/analytics/index.ts";

const ITERATIONS = 10_000;
/** 单轮 LLM 往返的保守下限（ms）。真实 p5 远大于此。 */
const ROUND_TRIP_FLOOR_MS = 50;
const BUDGET = 0.02;

describe("logContextAssembled 热路径预算", () => {
  beforeEach(() => {
    __resetAnalyticsForTest();
    attachAnalyticsSink({ logEvent: () => {} });
  });
  afterEach(() => __resetAnalyticsForTest());

  test("10000 次 emit 的单次耗时 / 50ms < 2%", () => {
    const payload = {
      turn: 3,
      messageCount: 12,
      estimatedTokens: 48_000,
      maxTokens: 200_000,
      compactionLevel: "none",
      blocking: false,
      calibrated: true,
      toolCount: 8,
    };
    // 预热，避免第一次 import / 内联缓存污染
    for (let i = 0; i < 100; i++) logContextAssembled(payload);

    const t0 = performance.now();
    for (let i = 0; i < ITERATIONS; i++) logContextAssembled(payload);
    const elapsed = performance.now() - t0;
    const perCallMs = elapsed / ITERATIONS;
    const ratio = perCallMs / ROUND_TRIP_FLOOR_MS;

    expect(ratio).toBeLessThan(BUDGET);
    //  sanity：如果有人把 estimateTokens 塞进门面，这条会先于 2% 红（毫秒级变几十毫秒）。
    expect(perCallMs).toBeLessThan(1);
  });
});
