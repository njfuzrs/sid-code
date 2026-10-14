/**
 * /perf 计算层测试。纯函数，不落盘 —— 索引行全部内存构造。
 *
 * 重点防三类「看起来对」的假数：无样本渲染成 0、样本不足也下结论、cost=0 塌成「省 100%」。
 */
import { describe, expect, test } from "bun:test";
import {
  buildByVersion,
  buildSessionPerf,
  buildTrend,
  compareWindows,
  pct,
  renderSessionPerf,
  renderTrend,
  windowStats,
  MIN_TREND_SAMPLES,
} from "@sid-code/core/trace/perf-report.ts";
import { aggregateSessionMetrics } from "@sid-code/core/trace/digest.ts";
import {
  buildSessionIndexEntry,
  type SessionIndexEntry,
} from "@sid-code/core/trace/session-index.ts";

const NOW = 1_800_000_000;
const DAY = 86400;

function row(over: Partial<SessionIndexEntry> & { session_id: string }): SessionIndexEntry {
  return {
    ts: NOW - DAY,
    app_version: "0.1.700",
    model: "m1",
    exit_status: "end_turn",
    duration_ms: 1000,
    turns: 3,
    total_steps: 5,
    cost_usd: 0.01,
    tokens_sent: 1000,
    tokens_received: 200,
    ttft_n: 0,
    e2e_n: 0,
    real_errors: 0,
    anomalies_count: 0,
    pathological: [],
    compactions: 0,
    defense_triggered: false,
    ...over,
  };
}

function many(n: number, ts: number, over: Partial<SessionIndexEntry>, tag: string) {
  return Array.from({ length: n }, (_, i) => row({ session_id: `${tag}${i}`, ts, ...over }));
}

describe("pct", () => {
  test("空样本是 undefined 不是 0", () => {
    expect(pct([], 0.5)).toBeUndefined();
  });
  test("未排序输入也取对分位", () => {
    expect(pct([30, 10, 20], 0.5)).toBe(20);
  });
});

describe("windowStats", () => {
  test("缺失字段不进样本，n 如实报", () => {
    const s = windowStats([
      row({ session_id: "a", ttft_p50: 1000, ttft_n: 3, tps: 40 }),
      row({ session_id: "b" }),
    ]);
    expect(s.metrics.ttft_p50).toEqual({ value: 1000, n: 1 });
    expect(s.metrics.tps_p50).toEqual({ value: 40, n: 1 });
    expect(s.metrics.gen_p95).toEqual({ value: undefined, n: 0 });
  });

  test("cost=0 的会话（未计价）不进成本分布", () => {
    const s = windowStats([
      row({ session_id: "a", cost_usd: 0 }),
      row({ session_id: "b", cost_usd: 0 }),
      row({ session_id: "c", cost_usd: 0.2 }),
    ]);
    expect(s.metrics.cost_p50).toEqual({ value: 0.2, n: 1 });
  });
});

describe("compareWindows / buildTrend", () => {
  test("TTFT 变大判变差且超 20% 加警告", () => {
    const idx = [
      ...many(MIN_TREND_SAMPLES, NOW - DAY, { ttft_p50: 3000 }, "cur"),
      ...many(MIN_TREND_SAMPLES, NOW - 8 * DAY, { ttft_p50: 1000 }, "prev"),
    ];
    const t = buildTrend(idx, { days: 7, nowSec: NOW });
    const r = t.rows.find((x) => x.key === "ttft_p50")!;
    expect(r.verdict).toBe("worse");
    expect(r.warn).toBe(true);
    expect(r.change).toBeCloseTo(2);
  });

  test("tok/s 变大是改善（方向与延迟相反）", () => {
    const idx = [
      ...many(MIN_TREND_SAMPLES, NOW - DAY, { tps: 60 }, "cur"),
      ...many(MIN_TREND_SAMPLES, NOW - 8 * DAY, { tps: 40 }, "prev"),
    ];
    const r = buildTrend(idx, { days: 7, nowSec: NOW }).rows.find((x) => x.key === "tps_p50")!;
    expect(r.verdict).toBe("better");
    expect(r.warn).toBe(false);
  });

  test("任一侧样本不足只报数不下结论（变异：去掉 n 门槛这条会红）", () => {
    const idx = [
      ...many(MIN_TREND_SAMPLES, NOW - DAY, { ttft_p50: 9000 }, "cur"),
      ...many(MIN_TREND_SAMPLES - 1, NOW - 8 * DAY, { ttft_p50: 1000 }, "prev"),
    ];
    const r = buildTrend(idx, { days: 7, nowSec: NOW }).rows.find((x) => x.key === "ttft_p50")!;
    expect(r.verdict).toBe("insufficient");
    expect(r.warn).toBe(false);
  });

  test("<10% 记 ≈", () => {
    const cur = windowStats(many(6, 0, { ttft_p50: 1050 }, "c"));
    const prev = windowStats(many(6, 0, { ttft_p50: 1000 }, "p"));
    expect(compareWindows(cur, prev).find((x) => x.key === "ttft_p50")!.verdict).toBe("same");
  });

  test("incomplete 增量行不进趋势", () => {
    const t = buildTrend([row({ session_id: "x", exit_status: "incomplete", ttft_p50: 1 })], {
      days: 7,
      nowSec: NOW,
    });
    expect(t.current.sessions).toBe(0);
  });

  test("TTFT 按模型分组，分母是会话数", () => {
    const t = buildTrend(
      [
        row({ session_id: "a", model: "m1", ttft_p50: 1000 }),
        row({ session_id: "b", model: "m1" }),
        row({ session_id: "c", model: "m2", ttft_p50: 5000 }),
      ],
      { days: 7, nowSec: NOW },
    );
    expect(t.ttftByModel.find((m) => m.model === "m1")).toEqual({
      model: "m1",
      sessions: 2,
      p50: 1000,
      n: 1,
    });
  });

  test("渲染中无样本写「无样本」不写 0", () => {
    const text = renderTrend(buildTrend([row({ session_id: "a" })], { days: 7, nowSec: NOW }));
    expect(text).toContain("无样本");
    expect(text).not.toMatch(/TTFT P50\s+0ms/);
  });
});

describe("buildByVersion", () => {
  test("按语义版本排序，缺版本号的行单独报数", () => {
    const v = buildByVersion(
      [
        row({ session_id: "a", app_version: "0.1.10" }),
        row({ session_id: "b", app_version: "0.1.9" }),
        row({ session_id: "c", app_version: undefined }),
      ],
      10,
    );
    expect(v.versions.map((x) => x.version)).toEqual(["0.1.9", "0.1.10"]);
    expect(v.rowsWithoutVersion).toBe(1);
  });
});

describe("buildSessionPerf", () => {
  test("模型/工具占比与无样本渲染", () => {
    const r = buildSessionPerf({
      sessionId: "s",
      model: "m",
      metrics: { ttft_n: 0, e2e_n: 0 },
      modelTimeMs: 3000,
      toolDurationMs: 1000,
    });
    expect(r.split!.toolShare).toBeCloseTo(0.25);
    const text = renderSessionPerf(r);
    expect(text).toContain("首字延迟 TTFT   无样本");
    expect(text).toContain("工具 25%");
  });

  test("tps 非有限值不展示", () => {
    expect(buildSessionPerf({ sessionId: "s", model: "m", tps: Infinity }).tps).toBeUndefined();
  });
});

describe("采集侧接线：gen_p95 与索引性能字段", () => {
  test("aggregateSessionMetrics 从 stream_completed 取纯生成耗时", () => {
    const m = aggregateSessionMetrics(
      [
        { event: "RetryTelemetry", data: { type: "stream_completed", elapsedMs: 1000 } },
        { event: "RetryTelemetry", data: { type: "stream_completed", elapsedMs: 3000 } },
        { event: "RetryTelemetry", data: { type: "retry", elapsedMs: 99999 } },
      ],
      { trajCorrupt: false },
    );
    expect(m.gen_n).toBe(2);
    expect(m.gen_p95).toBe(3000);
  });

  test("buildSessionIndexEntry 只落有限正数的性能字段", () => {
    const base = { session_id: "s", model: "m", exit_status: "end_turn" };
    const e = buildSessionIndexEntry(base, {
      ts: 1,
      perf: { tps: 42, gen_p95: 800, gen_n: 3, tool_duration_ms: 500, context_peak_ratio: 0.6 },
    });
    expect(e).toMatchObject({
      tps: 42,
      gen_p95: 800,
      gen_n: 3,
      tool_duration_ms: 500,
      context_peak_ratio: 0.6,
    });
    const bad = buildSessionIndexEntry(base, {
      ts: 1,
      perf: { tps: Infinity, gen_p95: 800, gen_n: 0, tool_duration_ms: 0, context_peak_ratio: NaN },
    });
    for (const k of ["tps", "gen_p95", "gen_n", "tool_duration_ms", "context_peak_ratio"]) {
      expect(k in bad).toBe(false);
    }
  });
});
