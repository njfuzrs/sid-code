/**
 * 导出失败告警节流（20261022 官网 observability 页核查 D2）
 *
 * 原先失败只打 debug，非 --debug 时零痕迹；直接全改 warn 又会每 5s 刷一次。
 * 锁三件事：连续失败只 WARN 一次；成功→失败再 WARN 一次；shutdown 汇总次数与最后错误。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { TelemetryBus } from "@sid-code/core/telemetry/bus.ts";
import { initLogger, LogLevel } from "@sid-code/core/debug/logger.ts";
import type { TelemetryExporter } from "@sid-code/core/telemetry/types.ts";

function captureTelemetryWarns(): { lines: string[]; restore: () => void } {
  const logger = initLogger({ enabled: true, level: LogLevel.WARN, fileOnly: true });
  const lines: string[] = [];
  const orig = logger.warn.bind(logger);
  (logger as any).warn = (mod: string, msg: string, ...rest: unknown[]) => {
    if (mod === "TELEMETRY") lines.push(msg);
    return orig(mod, msg, ...rest);
  };
  return { lines, restore: () => ((logger as any).warn = orig) };
}

function setup(failing: { spans: boolean; metrics: boolean }) {
  const exporter: TelemetryExporter = {
    name: "otlp",
    exportSpans: async () => {
      if (failing.spans) throw new Error("ECONNREFUSED");
    },
    exportMetrics: async () => {
      if (failing.metrics) throw new Error("HTTP 404");
    },
    shutdown: async () => {},
  };
  const bus = new TelemetryBus({ enabled: true, batchSize: 10_000, flushIntervalMs: 999_999 });
  bus.addExporter(exporter);
  return bus;
}

async function flushOneSpan(bus: TelemetryBus): Promise<void> {
  bus.startSpan("chat", "c").end();
  await bus.flush();
}

let cap: ReturnType<typeof captureTelemetryWarns>;
afterEach(() => {
  cap?.restore();
  initLogger({ enabled: false });
});

describe("D2 导出失败告警节流", () => {
  test("端点持续不通：连续 flush 10 次只 WARN 1 条（不刷屏，但不再零痕迹）", async () => {
    cap = captureTelemetryWarns();
    const bus = setup({ spans: true, metrics: false });
    for (let i = 0; i < 10; i++) await flushOneSpan(bus);
    const fails = cap.lines.filter((l) => l.includes("导出失败 (otlp)"));
    expect(fails).toHaveLength(1);
    expect(fails[0]).toContain("ECONNREFUSED");
  });

  test("由成功转为失败：再多 WARN 恰好 1 条", async () => {
    cap = captureTelemetryWarns();
    const failing = { spans: true, metrics: false };
    const bus = setup(failing);
    await flushOneSpan(bus);
    await flushOneSpan(bus);
    failing.spans = false;
    await flushOneSpan(bus);
    failing.spans = true;
    await flushOneSpan(bus);
    await flushOneSpan(bus);
    expect(cap.lines.filter((l) => l.includes("导出失败 (otlp)"))).toHaveLength(2);
  });

  test("traces 与 metrics 分开节流；shutdown 汇总次数与最后一次错误", async () => {
    cap = captureTelemetryWarns();
    const bus = setup({ spans: true, metrics: true });
    for (let i = 0; i < 3; i++) {
      bus.recordMetric({ name: "m", value: 1, timestamp: Date.now(), attributes: {} } as any);
      await flushOneSpan(bus);
    }
    expect(cap.lines.filter((l) => l.startsWith("span导出失败"))).toHaveLength(1);
    expect(cap.lines.filter((l) => l.startsWith("指标导出失败"))).toHaveLength(1);

    await bus.shutdown();
    const summary = cap.lines.filter((l) => l.includes("导出失败汇总"));
    expect(summary).toHaveLength(2);
    expect(summary.find((l) => l.includes("otlp/traces"))).toContain("共 3 次");
    expect(summary.find((l) => l.includes("otlp/metrics"))).toContain("HTTP 404");
  });

  test("从未失败：不产生任何导出相关 WARN", async () => {
    cap = captureTelemetryWarns();
    const bus = setup({ spans: false, metrics: false });
    for (let i = 0; i < 3; i++) await flushOneSpan(bus);
    await bus.shutdown();
    expect(cap.lines.filter((l) => l.includes("导出失败"))).toEqual([]);
  });
});
