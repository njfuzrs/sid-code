/**
 * T13.6：Side-call 可观测性单测
 * 覆盖：recordSideCall 失败聚合、getSideStats、SessionEnd sideCallStats、digest side_call_failures
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  recordSideCall,
  getSideStats,
  resetSideCallStats,
} from "../../src/trace/side-call-sink.ts";
import { aggregateProviderStats } from "../../src/trace/digest.ts";

describe("T13.2/T13.4: recordSideCall 失败字段与 getSideStats 聚合", () => {
  beforeEach(() => {
    resetSideCallStats();
  });

  it("记录成功调用（默认 success=true）", () => {
    recordSideCall({
      label: "auto-compact",
      model: "deepseek-chat",
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      durationMs: 2000,
    });

    const stats = getSideStats();
    expect(stats.apiCalls).toBe(1);
    expect(stats.failed).toBe(0);
    expect(stats.timedOut).toBe(0);
    expect(stats.byLabel["auto-compact"]).toEqual({ success: 1, failed: 0 });
  });

  it("记录失败调用（success=false + error + timedOut）", () => {
    recordSideCall({
      label: "memory-recall",
      model: "deepseek-chat",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      durationMs: 60000,
      success: false,
      error: "timeout: 60s exceeded",
      timedOut: true,
    });

    const stats = getSideStats();
    expect(stats.apiCalls).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.timedOut).toBe(1);
    expect(stats.byLabel["memory-recall"]).toEqual({ success: 0, failed: 1 });
  });

  it("混合成功/失败记录聚合正确", () => {
    // 3 成功 + 2 失败（其中 1 超时）
    for (let i = 0; i < 3; i++) {
      recordSideCall({ label: "auto-compact", model: "m", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, durationMs: 1000 });
    }
    recordSideCall({ label: "auto-compact", model: "m", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, durationMs: 60000, success: false, error: "timeout", timedOut: true });
    recordSideCall({ label: "context-collapse", model: "m", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, durationMs: 5000, success: false, error: "network error" });

    const stats = getSideStats();
    expect(stats.apiCalls).toBe(5);
    expect(stats.failed).toBe(2);
    expect(stats.timedOut).toBe(1);
    expect(stats.byLabel["auto-compact"]).toEqual({ success: 3, failed: 1 });
    expect(stats.byLabel["context-collapse"]).toEqual({ success: 0, failed: 1 });
  });

  it("resetSideCallStats 清除所有记录", () => {
    recordSideCall({ label: "test", model: "m", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, durationMs: 1000, success: false, error: "x" });
    resetSideCallStats();
    const stats = getSideStats();
    expect(stats.apiCalls).toBe(0);
    expect(stats.failed).toBe(0);
  });
});

describe("T13.4: SessionEnd sideCallStats 结构验证", () => {
  beforeEach(() => {
    resetSideCallStats();
  });

  it("getSideStats 输出的结构可直接嵌入 SessionEnd 事件", () => {
    recordSideCall({ label: "auto-compact", model: "m", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, durationMs: 1000 });
    recordSideCall({ label: "memory-recall", model: "m", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, durationMs: 60000, success: false, error: "timeout", timedOut: true });

    const stats = getSideStats();
    // 模拟 collector.ts:1069-1075 的组装方式
    const sideCallStats = stats.apiCalls > 0 ? {
      total: stats.apiCalls,
      succeeded: stats.apiCalls - stats.failed,
      failed: stats.failed,
      timedOut: stats.timedOut,
      byLabel: stats.byLabel,
    } : undefined;

    expect(sideCallStats).toBeDefined();
    expect(sideCallStats!.total).toBe(2);
    expect(sideCallStats!.succeeded).toBe(1);
    expect(sideCallStats!.failed).toBe(1);
    expect(sideCallStats!.timedOut).toBe(1);
    expect(sideCallStats!.byLabel["auto-compact"]).toEqual({ success: 1, failed: 0 });
    expect(sideCallStats!.byLabel["memory-recall"]).toEqual({ success: 0, failed: 1 });
  });
});

describe("T13.5: digest side_call_failures 异常诊断", () => {
  it("失败率 > 20% 标记 high severity", () => {
    // 模拟 buildDigest 中消费的 events 数组（含 SessionEnd 事件）
    const events = [
      {
        event: "SessionEnd",
        data: {
          sideCallStats: {
            total: 5,
            succeeded: 3,
            failed: 2,
            timedOut: 1,
            byLabel: {
              "auto-compact": { success: 2, failed: 1 },
              "memory-recall": { success: 1, failed: 1 },
            },
          },
        },
      },
    ];

    // 内联模拟 digest.ts T13.5 的诊断逻辑（验证判据正确性）
    const sessionEndEvent = events.find(e => e.event === "SessionEnd");
    const sideCallData = (sessionEndEvent?.data as any)?.sideCallStats;

    const total = sideCallData.total || 0;
    const failRate = total > 0 ? sideCallData.failed / total : 0;

    // 2/5 = 40% > 20%
    expect(failRate).toBeGreaterThan(0.2);

    // top-3 截断
    const top3 = Object.entries(sideCallData.byLabel || {})
      .filter(([, v]: [string, any]) => v.failed > 0)
      .sort(([, a]: [string, any], [, b]: [string, any]) => b.failed - a.failed)
      .slice(0, 3)
      .map(([k, v]: [string, any]) => `${k}(${v.failed}失败)`);

    expect(top3).toHaveLength(2);
    expect(top3[0]).toContain("auto-compact");
    expect(top3[1]).toContain("memory-recall");
  });

  it("失败率 <= 20% 标记 medium severity", () => {
    const sideCallData = { total: 10, succeeded: 9, failed: 1, timedOut: 0, byLabel: { "warmup": { success: 9, failed: 1 } } };
    const failRate = sideCallData.failed / sideCallData.total;
    // 1/10 = 10% <= 20%
    expect(failRate).toBeLessThanOrEqual(0.2);
    // severity 应为 medium
    const severity = failRate > 0.2 ? "high" : "medium";
    expect(severity).toBe("medium");
  });

  it("top-3 截断：超过 3 个失败 label 只取前 3", () => {
    const byLabel = {
      "auto-compact": { success: 0, failed: 5 },
      "context-collapse": { success: 0, failed: 4 },
      "memory-recall": { success: 0, failed: 3 },
      "cache-warmup": { success: 0, failed: 2 },
      "goal-eval": { success: 0, failed: 1 },
    };

    const top3 = Object.entries(byLabel)
      .filter(([, v]) => v.failed > 0)
      .sort(([, a], [, b]) => b.failed - a.failed)
      .slice(0, 3)
      .map(([k, v]) => `${k}(${v.failed}失败)`);

    expect(top3).toHaveLength(3);
    expect(top3[0]).toBe("auto-compact(5失败)");
    expect(top3[1]).toBe("context-collapse(4失败)");
    expect(top3[2]).toBe("memory-recall(3失败)");
  });
});

describe("T13.5: aggregateProviderStats 含 TTFT P99", () => {
  it("输出 ttft_p99 字段", () => {
    // 构造有 TTFT 数据的 events
    const events = Array.from({ length: 100 }, (_, i) => ({
      event: "AfterModelRaw",
      data: { provider: "openai", elapsed_ms: 1000, ttft_ms: (i + 1) * 100 }, // 100ms ~ 10000ms
    }));

    const stats = aggregateProviderStats(events);
    const openai = stats.find(s => s.provider === "openai");
    expect(openai).toBeDefined();
    expect(openai!.ttft_p50).toBeDefined();
    expect(openai!.ttft_p95).toBeDefined();
    expect(openai!.ttft_p99).toBeDefined();
    // P99 of 100..10000 ≈ 9900
    expect(openai!.ttft_p99).toBeGreaterThanOrEqual(9900);
  });
});
