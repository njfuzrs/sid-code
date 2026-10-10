/**
 * 2026-10-08 端到端核出的两处口径问题的回归门禁（不在 20260927 审计的 38 条里）
 *
 *   A. chat span 的 TTFT 只在可视文本轮次有值：纯 tool_use / thinking 轮恒 undefined，
 *      违反「首个任意内容 chunk、每次 fetch 单独计」铁律。
 *      正解：取 lifecycle 层 StreamPhase(first_content) 的同一个值（takeFirstContentTtft）。
 *   B. 同一次调用的 cache_savings 在 span 属性与 metric 上是两个数（实测 0.0661 vs 0.0858）。
 *      正解：主循环用 SessionState.calculateSavings（带 baseURL，/cost 同源）算一次，
 *      经 AfterModel 透传，TokenMeter.record 不再自算。
 *
 * 每条都锁「修复前会红」的形态。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initStreamObserver,
  resetStreamObserver,
  emitStreamPhase,
  takeFirstContentTtft,
  clearStreamSnapshot,
  clearAllSnapshots,
  cleanupAgentSnapshots,
} from "@sid-code/core/trace/stream-observer.ts";
import { currentSseDumpContext } from "@sid-code/core/llm/sse-chunk-dumper.ts";
import { TelemetryBus } from "@sid-code/core/telemetry/bus.ts";
import { TelemetryHookProbe } from "@sid-code/core/telemetry/hook-probe.ts";
import { TokenMeter } from "@sid-code/core/telemetry/metrics/token-meter.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import type { MetricPoint, SpanData, TelemetryExporter } from "@sid-code/core/telemetry/types.ts";
import type { Usage } from "@sid-code/core/llm/types.ts";

const src = (p: string) => readFileSync(join(import.meta.dir, "../../src", p), "utf-8");

// ───────────────────────── A. TTFT ─────────────────────────
describe("A：AfterModel 的 TTFT 取自 first_content（首个任意内容 chunk）", () => {
  beforeEach(() => initStreamObserver("ttft-session", "/tmp/ttft-session", () => {}));
  afterEach(() => resetStreamObserver());

  const loopId = () => currentSseDumpContext().loopId;

  test("没有任何可视文本（纯 tool_use 轮）也能取到 TTFT", () => {
    // provider 只 emit first_content，不经过任何文本回调 —— 修复前主循环在这种轮次拿不到值
    emitStreamPhase(7, "first_content", { ttft_ms: 9614, model: "claude-opus-5-5" });
    expect(takeFirstContentTtft(7)).toBe(9614);
  });

  test("读一次即清：下一轮没有 first_content 时不会读到旧值", () => {
    emitStreamPhase(7, "first_content", { ttft_ms: 5623, model: "m" });
    expect(takeFirstContentTtft(7)).toBe(5623);
    expect(takeFirstContentTtft(7)).toBeUndefined();
  });

  test("同一 index 内重试：取的是被采纳那次（最后一次）fetch 的值，不跨重试累计", () => {
    emitStreamPhase(3, "first_content", { ttft_ms: 40_000, model: "m" });
    emitStreamPhase(3, "first_content", { ttft_ms: 1_200, model: "m" });
    expect(takeFirstContentTtft(3)).toBe(1_200);
  });

  test("与快照生命周期解耦：race settle 时清快照，不能顺带清掉 TTFT", () => {
    // loop.ts 在 race finally 里就 clearStreamSnapshot，AfterModel 在那之后才组装
    emitStreamPhase(4, "first_content", { ttft_ms: 800, model: "m" });
    clearStreamSnapshot(4);
    expect(takeFirstContentTtft(4)).toBe(800);
  });

  test("按 agentId 隔离：子代理的 first_content 不会被主循环同 index 读走", () => {
    emitStreamPhase(10001, "first_content", { ttft_ms: 1629, model: "sub" }, "agent-x");
    expect(takeFirstContentTtft(10001)).toBeUndefined();
    expect(takeFirstContentTtft(10001, undefined, "agent-x")).toBe(1629);
  });

  test("非法值（0 / 非数）不入表", () => {
    emitStreamPhase(5, "first_content", { ttft_ms: 0, model: "m" });
    emitStreamPhase(6, "first_content", { ttft_ms: "x", model: "m" });
    expect(takeFirstContentTtft(5)).toBeUndefined();
    expect(takeFirstContentTtft(6)).toBeUndefined();
  });

  test("loop / agent / 会话收尾都会清表（不泄漏）", () => {
    emitStreamPhase(1, "first_content", { ttft_ms: 1, model: "m" });
    clearAllSnapshots(loopId());
    expect(takeFirstContentTtft(1)).toBeUndefined();

    emitStreamPhase(2, "first_content", { ttft_ms: 2, model: "m" }, "agent-y");
    cleanupAgentSnapshots("agent-y");
    expect(takeFirstContentTtft(2, undefined, "agent-y")).toBeUndefined();

    emitStreamPhase(3, "first_content", { ttft_ms: 3, model: "m" });
    resetStreamObserver();
    expect(takeFirstContentTtft(3)).toBeUndefined();
  });

  test("结构：主循环两处 AfterModel 的 ttft_ms 都来自 takeFirstContentTtft，不再用文本回调计时", () => {
    const loop = src("query/loop.ts");
    // 修复前的形态：在 processStream 的 onText 回调里 `ttftMs = performance.now() - ttftStart`
    expect(loop).not.toMatch(/ttftStart/);
    expect(loop).not.toMatch(/ttft_ms:\s*ttftMs\b/);
    const takes = loop.match(/ttft_ms:\s*takeFirstContentTtft\(/g) ?? [];
    // 主循环一轮 + 总结轮
    expect(takes.length).toBe(2);
  });
});

// ───────────────────────── B. cache_savings ─────────────────────────

/**
 * 两套刻意不同的定价：TokenMeter 自算用 meterPrice，调用方权威值用另一个数。
 * 若 record() 仍自算，metric 会等于 meterPrice 推出的值而不是透传值 —— 这条就会红。
 */
function meterPrice(_model: string, usage: Usage): number {
  return (usage.inputTokens * 1 + (usage.cacheReadInputTokens ?? 0) * 0.1) / 1_000_000;
}

function setupProbe() {
  const spans: SpanData[] = [];
  const metrics: MetricPoint[] = [];
  const exporter: TelemetryExporter = {
    name: "mock",
    exportSpans: async (b) => void spans.push(...b),
    exportMetrics: async (b) => void metrics.push(...b),
    shutdown: async () => {},
  };
  const bus = new TelemetryBus({ enabled: true, batchSize: 10_000, flushIntervalMs: 999_999 });
  bus.addExporter(exporter);
  const probe = new TelemetryHookProbe(bus, new TokenMeter(bus, meterPrice), {
    model: "claude-sonnet-4",
    provider: "anthropic",
    sessionId: "savings-caliber",
  });
  const hookSystem = new HookSystem();
  probe.registerHooks(hookSystem);
  return { bus, spans, metrics, hookSystem };
}

const req = { model: "claude-sonnet-4", messages: [{ role: "user", content: "hi" }] };
const usage = { inputTokens: 1_000, outputTokens: 50, cacheReadInputTokens: 20_000 };

describe("B：同一次调用的 cache_savings，span 属性与 metric 必须是同一个数", () => {
  // TelemetryHookProbe 在 SessionStart 时会落 pending-root-spans：必须隔离到临时目录，
  // 存/恢复原值（不无条件 delete，见 no-real-path-writes.test.ts 的说明）
  let savedConfigDir: string | undefined;
  let testHome: string;
  beforeEach(() => {
    savedConfigDir = process.env.SID_CONFIG_DIR;
    testHome = mkdtempSync(join(tmpdir(), "sid-savings-caliber-"));
    process.env.SID_CONFIG_DIR = testHome;
  });
  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = savedConfigDir;
    rmSync(testHome, { recursive: true, force: true });
  });

  test("AfterModel 带 cache_savings_usd 时，metric 原样采用而不是自算", async () => {
    const { bus, spans, metrics, hookSystem } = setupProbe();
    await hookSystem.fireSessionStartEvent("startup", { model: "claude-sonnet-4" });
    await hookSystem.fireBeforeModelEvent(req);
    await hookSystem.fireAfterModelEvent(req, {
      text: "",
      stop_reason: "tool_use",
      usage,
      cost_usd: 0.0089268,
      cache_savings_usd: 0.0661336,
    });
    await bus.flush();

    const chat = spans.find((s) => s.kind === "chat")!;
    const sav = metrics.filter((m) => m.name === "sidcode.cost.cache_savings_usd");
    expect(sav).toHaveLength(1);
    expect(sav[0]!.value).toBe(chat.attributes["sidcode.cost.cache_savings_usd"] as number);
    expect(sav[0]!.value).toBe(0.0661336);
  });

  test("对照：载荷不带 cache_savings_usd 时（子代理等路径）仍由 TokenMeter 自算，不是死断言", () => {
    const meter = new TokenMeter(null, meterPrice);
    const self = meter.record({ model: "m", provider: "anthropic", usage, costUSD: 0.001 });
    const given = meter.record({
      model: "m",
      provider: "anthropic",
      usage,
      costUSD: 0.001,
      cacheSavingsUSD: 0.0661336,
    });
    expect(self.cacheSavingsUSD).not.toBe(0.0661336);
    expect(given.cacheSavingsUSD).toBe(0.0661336);
  });

  test("结构：主循环两处 AfterModel 的 savings 都走 SessionState.calculateSavings 且带 baseURL", () => {
    const loop = src("query/loop.ts");
    // 只匹配真实调用（注释里提到旧名不算）
    expect(loop).not.toMatch(/\.calculateCacheSavings\(/);
    const calls = loop.match(/sessionState\.calculateSavings\([^)]*config\.baseURL/g) ?? [];
    expect(calls.length).toBe(2);
  });

  test("结构：TokenMeter 不再提供第二个 savings 入口", () => {
    // 只匹配方法定义行（注释里提到旧名不算）
    expect(src("telemetry/metrics/token-meter.ts")).not.toMatch(/^\s*calculateCacheSavings\s*\(/m);
  });
});
