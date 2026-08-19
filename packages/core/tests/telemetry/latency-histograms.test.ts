/**
 * TTFT / turns 两个 Histogram 的记录行为（P1 · metric 侧此前无分布）
 *
 * 覆盖三件事：
 * 1. 正常值落成带分桶的 histogram（而不是又一个 counter）；
 * 2. **无效值不落**——0 / 负数 / 缺 model 都是"观测失败"，不是"很快"；
 * 3. 标签形态——TTFT 必须带 model（跨路由汇总是假数），
 *    可选维度只在**已知**时才落（未知与 false 是两件事）。
 *
 * 落盘隔离：本文件只用 `initTelemetry({ enabled: true })` 且**不注册任何导出器**，
 * 断言全部走内存里的 `getCompletedMetrics()` —— 不写 `~/.sid-code/`，
 * 满足 `no-real-path-writes.test.ts` 的静态扫描门禁。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  initTelemetry,
  getTelemetryBus,
  shutdownTelemetry,
} from "@sid-code/core/telemetry/index.ts";
import {
  recordTtftHistogram,
  recordTurnsHistogram,
  TTFT_METRIC,
  TURNS_METRIC,
} from "@sid-code/core/telemetry/metrics/latency-histograms.ts";
import type { MetricPoint } from "@sid-code/core/telemetry/types.ts";

beforeEach(() => {
  // 不加导出器：metric 只进内存队列/历史，不落盘
  initTelemetry({ enabled: true, exporters: [] });
});

afterEach(async () => {
  await shutdownTelemetry();
});

const metricsOf = (name: string): MetricPoint[] =>
  getTelemetryBus()
    .getCompletedMetrics()
    .filter((m) => m.name === name);

describe("recordTtftHistogram", () => {
  test("正常值落成带分桶的 histogram，且带 model 维度", () => {
    recordTtftHistogram(3983, "deepseek-v4-pro");

    const [m] = metricsOf(TTFT_METRIC);
    expect(m).toBeDefined();
    expect(m.type).toBe("histogram");
    expect(m.value).toBe(3983);
    // model 是这个指标的命根子：同底层模型不同网关路由的 TTFT 差 17 倍，
    // 没有它就只能跨路由汇总，而那个数是假的。
    expect(m.attributes["gen_ai.request.model"]).toBe("deepseek-v4-pro");
    // 必须带分桶，否则导出器会把它降级成 gauge（等于这个 PR 白做）
    expect(m.buckets?.bounds.length).toBeGreaterThan(0);
  });

  test("桶边界必须严格递增，且覆盖到 30s 以上（慢尾巴才是用户流失点）", () => {
    recordTtftHistogram(100, "m");
    const bounds = metricsOf(TTFT_METRIC)[0].buckets!.bounds;
    for (let i = 1; i < bounds.length; i++) {
      expect(bounds[i]).toBeGreaterThan(bounds[i - 1]);
    }
    // 实测慢首字节有 102.8s 的样本，截在 10s 会把病态样本全压进同一个尾桶
    expect(bounds[bounds.length - 1]).toBeGreaterThanOrEqual(30_000);
  });

  test("0 / 负值不落——那是基准缺失或时钟异常，不是'很快'", () => {
    recordTtftHistogram(0, "m");
    recordTtftHistogram(-5, "m");
    recordTtftHistogram(Number.NaN, "m");
    expect(metricsOf(TTFT_METRIC).length).toBe(0);
  });

  test("缺 model 不落——没有它这个指标是废的，宁可缺样本也不要假分布", () => {
    recordTtftHistogram(1200, "");
    expect(metricsOf(TTFT_METRIC).length).toBe(0);
  });

  test("cacheHit 只在已知时落（未知与 false 是两件事）", () => {
    recordTtftHistogram(500, "m");
    recordTtftHistogram(600, "m", { cacheHit: false });

    const all = metricsOf(TTFT_METRIC);
    // 不传 → 键不存在（而不是落一个 false 把"未知"算进 miss 桶）
    expect("sidcode.cache_hit" in all[0].attributes).toBe(false);
    expect(all[1].attributes["sidcode.cache_hit"]).toBe(false);
  });
});

describe("recordTurnsHistogram", () => {
  test("正常值落成带分桶的 histogram，带受控 stop_reason", () => {
    recordTurnsHistogram(10, "end_turn", { hadHitl: false });

    const [m] = metricsOf(TURNS_METRIC);
    expect(m.type).toBe("histogram");
    expect(m.value).toBe(10);
    expect(m.attributes["sidcode.stop_reason"]).toBe("end_turn");
    expect(m.attributes["sidcode.had_hitl"]).toBe(false);
    expect(m.buckets?.bounds.length).toBeGreaterThan(0);
  });

  test("0 轮不落（那是'没发生过模型请求'，不是分布上的样本）", () => {
    recordTurnsHistogram(0, "error");
    expect(metricsOf(TURNS_METRIC).length).toBe(0);
  });

  test("hadHitl 未知时不落该键——含人等待的轮会污染分位", () => {
    recordTurnsHistogram(3, "end_turn");
    expect("sidcode.had_hitl" in metricsOf(TURNS_METRIC)[0].attributes).toBe(false);
  });
});

describe("遥测未启用时的姿态", () => {
  test("bus 禁用时静默丢弃，不抛异常（可观测性不影响主流程）", async () => {
    await shutdownTelemetry();
    initTelemetry({ enabled: false, exporters: [] });

    expect(() => recordTtftHistogram(500, "m")).not.toThrow();
    expect(() => recordTurnsHistogram(3, "end_turn")).not.toThrow();
    expect(metricsOf(TTFT_METRIC).length).toBe(0);
  });
});
