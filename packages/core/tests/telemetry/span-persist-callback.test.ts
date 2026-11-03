/**
 * `TelemetryBus.onSpanPersisted` —— 「这个 span 真的落盘了」的确认回调。
 *
 * ## 为什么需要它
 *
 * 会话根 `invoke_agent` span 只在 `handleSessionEnd` 里 `end()`，而 `end()` **只是入队**
 * （`bus.ts` 的 `enqueueSpan`）。队列由每 5 秒的定时刷新与 shutdown 的 flush 阶段消费，
 * 信号退出（Ctrl+C / 关终端）两条都赶不上 —— 入队后紧跟 `process.exit`，根 span 与最后
 * 几秒的子 span 一起随进程消失。所以「删掉『这个根还欠一次 end』的占位标记」这件事不能
 * 挂在入队上，必须挂在**导出成功**上。
 *
 * 本文件钉的是 bus 侧的判据（方案文档 §二 B 的那张表）：
 *
 * | 配置 | 判据 |
 * | --- | --- |
 * | 有 jsonl 导出器（durable） | jsonl 这一批成功 |
 * | 只有 OTLP | OTLP 这一批成功 |
 * | 无导出器 | 由调用方直接当已落盘（不在本文件） |
 *
 * 失败侧（导出失败 / drain 超时 / 队列溢出）回调都不触发，且登记不能留在 Map 里。
 *
 * ## 落盘隔离
 *
 * 失败用例会走到 `noteExportFailure` → `getLogger().warn`，日志落在 `~/.sid-code/`。
 * 所以本文件把 `SID_CONFIG_DIR` 重定向到 tmpdir，并**存/恢复**原值（不是 delete：
 * 同进程跑多文件，delete 会抹掉 preload 的兜底）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TelemetryBus } from "@sid-code/core/telemetry/bus.ts";
import type { SpanData, TelemetryExporter } from "@sid-code/core/telemetry/types.ts";

const prevConfigDir = process.env.SID_CONFIG_DIR;
let testHome: string;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "sid-span-persist-"));
  process.env.SID_CONFIG_DIR = testHome;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(testHome, { recursive: true, force: true });
});

/** 造一条可直接入队的 span（不需要 SpanHandle） */
function makeSpan(spanId: string): SpanData {
  const start = Date.now();
  return {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId,
    name: "invoke_agent sid-code",
    kind: "invoke_agent",
    status: "ok",
    startTime: start,
    endTime: start + 1,
    durationMs: 1,
    attributes: {},
    events: [],
  };
}

interface FakeExporterOptions {
  /** 模拟本地落盘出口（jsonl） */
  durable?: boolean;
  /** 每次导出都失败（模拟端点不可达 / 磁盘满） */
  fail?: boolean;
  /** 导出耗时（模拟慢导出器） */
  delayMs?: number;
}

function fakeExporter(name: string, opts: FakeExporterOptions = {}): TelemetryExporter {
  const exporter: TelemetryExporter = {
    name,
    exportSpans: async () => {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.fail) throw new Error(`${name} 不可达`);
    },
    shutdown: async () => {},
  };
  if (opts.durable) exporter.durable = true;
  return exporter;
}

function createBus(...exporters: TelemetryExporter[]): TelemetryBus {
  // flushIntervalMs 拉到极大：这些用例必须由 `flush()` / `drain()` 显式驱动，
  // 否则定时器会在断言之间偷偷把队列清掉，用例变成时序彩票。
  const bus = new TelemetryBus({ enabled: true, batchSize: 100, flushIntervalMs: 999_999 });
  for (const e of exporters) bus.addExporter(e);
  return bus;
}

describe("落盘成功才触发回调（durable 判据）", () => {
  test("jsonl 成功、OTLP 失败 → 回调触发（OTLP 长期不通是预期形态，不能拖着本地根不删）", async () => {
    const bus = createBus(
      fakeExporter("jsonl", { durable: true }),
      fakeExporter("otlp", { fail: true }),
    );
    let called = 0;
    bus.onSpanPersisted("root", () => called++);
    bus.enqueueSpan(makeSpan("root"));

    await bus.flush();
    expect(called).toBe(1);
  });

  test("只有 OTLP 且失败 → 回调不触发（没有本地出口，标记要留到下次启动重建）", async () => {
    const bus = createBus(fakeExporter("otlp", { fail: true }));
    let called = 0;
    bus.onSpanPersisted("root", () => called++);
    bus.enqueueSpan(makeSpan("root"));

    await bus.flush();
    expect(called).toBe(0);
  });

  test("只有 OTLP 且成功 → 回调触发（没有 durable 时看全部导出器）", async () => {
    const bus = createBus(fakeExporter("otlp"));
    let called = 0;
    bus.onSpanPersisted("root", () => called++);
    bus.enqueueSpan(makeSpan("root"));

    await bus.flush();
    expect(called).toBe(1);
  });

  test("回调抛错不影响导出，也不影响同批其它登记", async () => {
    const bus = createBus(fakeExporter("jsonl", { durable: true }));
    bus.onSpanPersisted("a", () => {
      throw new Error("删标记失败");
    });
    let bCalled = 0;
    bus.onSpanPersisted("b", () => bCalled++);
    bus.enqueueSpan(makeSpan("a"));
    bus.enqueueSpan(makeSpan("b"));

    await expect(bus.flush()).resolves.toBeUndefined();
    expect(bCalled).toBe(1);
    expect(bus.getPendingPersistenceCount()).toBe(0);
  });
});

describe("drain 的返回值：排空与否", () => {
  test("慢导出器超过预算 → drain 返回 false，根的回调不触发（信号路径据此打 drained=false）", async () => {
    const bus = createBus(fakeExporter("jsonl", { durable: true, delayMs: 300 }));
    let called = 0;
    bus.onSpanPersisted("root", () => called++);
    bus.enqueueSpan(makeSpan("root"));

    const drained = await bus.drain(30);
    expect(drained).toBe(false);
    expect(called).toBe(0);

    // 收尾：让在途那批落地，避免测试结束时留下未完成的 promise
    await bus.drain(2_000);
  });

  test("预算充足 → drain 返回 true 且回调触发", async () => {
    const bus = createBus(fakeExporter("jsonl", { durable: true }));
    let called = 0;
    bus.onSpanPersisted("root", () => called++);
    bus.enqueueSpan(makeSpan("root"));

    const drained = await bus.drain(1_000);
    expect(drained).toBe(true);
    expect(called).toBe(1);
  });
});

describe("队列溢出：登记必须被清掉（不泄漏）", () => {
  test("根被丢最旧的 10% 挤掉 → 回调不触发，登记表清空", async () => {
    // maxQueueSize=10 → 每次溢出丢 1 条；第 11 次入队时最旧的 root 被丢
    const bus = new TelemetryBus({
      enabled: true,
      batchSize: 1_000,
      flushIntervalMs: 999_999,
      maxQueueSize: 10,
    });
    bus.addExporter(fakeExporter("jsonl", { durable: true }));

    let called = 0;
    bus.onSpanPersisted("root", () => called++);
    bus.enqueueSpan(makeSpan("root"));
    for (let i = 0; i < 10; i++) bus.enqueueSpan(makeSpan(`filler-${i}`));

    // 登记不能在 Map 里堆到进程退出：这批 span 永远不会进 flushSpans
    expect(bus.getPendingPersistenceCount()).toBe(0);

    await bus.flush();
    expect(called).toBe(0);
  });

  test("没有被挤掉的登记在导出后照常触发", async () => {
    const bus = createBus(fakeExporter("jsonl", { durable: true }));
    bus.onSpanPersisted("root", () => {});
    bus.enqueueSpan(makeSpan("root"));
    expect(bus.getPendingPersistenceCount()).toBe(1);
    await bus.flush();
    expect(bus.getPendingPersistenceCount()).toBe(0);
  });
});

describe("未启用 / 无导出器时由调用方直接处理", () => {
  test("hasExporters() 如实反映注册状态（hook-probe 据此决定要不要等回调）", () => {
    const bus = createBus();
    expect(bus.hasExporters()).toBe(false);
    bus.addExporter(fakeExporter("jsonl", { durable: true }));
    expect(bus.hasExporters()).toBe(true);
  });
});
