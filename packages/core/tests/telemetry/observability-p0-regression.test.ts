/**
 * 可观测性审计（20260927）P0×5 + 缺陷 1/2/3 的回归门禁
 *
 * 每条都锁**修复前会红**的那个形态，不锁实现细节：
 *   缺陷 1  4 个 hook 事件无 fire 点 ⇒ 声明处必须标「预留」
 *   缺陷 2  并发子代理的 span 父子关系不串台
 *   缺陷 3  chat span 在「无 usage」「AfterModel 不 fire」两条路径上照样 end 入队
 *   缺陷 12 Anthropic 族 cache_savings 不再恒 0
 *   缺陷 21 隐私级别禁用遥测时 OTLP 不外发
 *   缺陷 28 内容级 tracing 的 _preview 属性过脱敏
 *   缺陷 32 子代理成本按 model 回算，savings 不等于全价
 *   缺陷 35 隐私级别禁用遥测时磁盘缓存不重放、不删
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TelemetryBus } from "@sid-code/core/telemetry/bus.ts";
import { TelemetryHookProbe } from "@sid-code/core/telemetry/hook-probe.ts";
import { TokenMeter } from "@sid-code/core/telemetry/metrics/token-meter.ts";
import { OtlpTelemetryExporter } from "@sid-code/core/telemetry/exporters/otlp.ts";
import { initTelemetry, shutdownTelemetry } from "@sid-code/core/telemetry/index.ts";
import { runInSpanScope } from "@sid-code/core/telemetry/span-scope.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { EventDiskCache } from "@sid-code/core/analytics/disk-cache.ts";
import { setConfiguredPrivacyLevel } from "@sid-code/core/analytics/privacy-level.ts";
import { clearContentTracingState } from "@sid-code/core/telemetry/content-tracing.ts";
import { __resetFeatureFlagsForTest } from "@sid-code/core/analytics/feature-flags.ts";
import type { MetricPoint, SpanData, TelemetryExporter } from "@sid-code/core/telemetry/types.ts";
import type { Usage } from "@sid-code/core/llm/types.ts";

const ENV_KEYS = [
  "SID_CODE_DISABLE_TELEMETRY",
  "SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "SID_CODE_CONTENT_TRACING",
];
let savedEnv: Record<string, string | undefined> = {};
let savedConfigDir: string | undefined;
let testHome: string;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  savedConfigDir = process.env.SID_CONFIG_DIR;
  testHome = mkdtempSync(join(tmpdir(), "sid-obs-p0-"));
  process.env.SID_CONFIG_DIR = testHome;
  setConfiguredPrivacyLevel(null);
  __resetFeatureFlagsForTest();
  clearContentTracingState();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  if (savedConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = savedConfigDir;
  rmSync(testHome, { recursive: true, force: true });
  setConfiguredPrivacyLevel(null);
  __resetFeatureFlagsForTest();
  clearContentTracingState();
});

/** 简化定价：input 1$/M、cache_read 0.1×、cache_write 1.25×、output 5$/M，口径同 normalizeCacheUsage */
function priceFor(_model: string, usage: Usage, provider?: string): number {
  const hit = usage.cacheReadInputTokens ?? 0;
  const write = usage.cacheCreationInputTokens ?? 0;
  const uncached =
    provider === "anthropic" ? usage.inputTokens : Math.max(0, usage.inputTokens - hit - write);
  return (uncached * 1 + hit * 0.1 + write * 1.25 + usage.outputTokens * 5) / 1_000_000;
}

function setup(tokenMeter: TokenMeter | null = null) {
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
  const meter = tokenMeter === null ? null : new TokenMeter(bus, priceFor);
  const probe = new TelemetryHookProbe(bus, meter, {
    model: "claude-sonnet-4",
    provider: "anthropic",
    sessionId: "obs-p0",
  });
  const hookSystem = new HookSystem();
  probe.registerHooks(hookSystem);
  return { bus, spans, metrics, hookSystem };
}

const req = { model: "claude-sonnet-4", messages: [{ role: "user", content: "hi" }] };
const tick = () => new Promise((r) => setTimeout(r, 0));

// ───────────────────────── 缺陷 1 ─────────────────────────
describe("缺陷 1：两类 SpanKind 恒不产生，声明处必须标注", () => {
  const src = (p: string) => readFileSync(join(import.meta.dir, "../../src", p), "utf-8");

  test("4 个依赖事件仍无 fire 方法（接线后这条会红，届时同步删掉各处「预留」）", () => {
    const handler = src("hook/event-handler.ts");
    for (const e of [
      "BeforePermissionCheck",
      "AfterPermissionCheck",
      "BeforeHookExecution",
      "AfterHookExecution",
    ]) {
      expect(handler).not.toContain(`HookEventName.${e}`);
    }
  });

  test("types.ts / hook-probe.ts / hook/types.ts / perfetto.ts 四处都标了「预留」", () => {
    expect(src("telemetry/types.ts")).toMatch(/"blocked_on_user"\s*\/\/\s*预留/);
    expect(src("telemetry/types.ts")).toMatch(/"hook_execution";\s*\/\/\s*预留/);
    expect(src("telemetry/hook-probe.ts")).toMatch(/预留：这 4 个事件全仓无 fire 点/);
    expect(src("telemetry/perfetto.ts")).toMatch(/预留：这两类 span 当前恒不产生/);
    const hookTypes = src("hook/types.ts");
    for (const e of [
      "BeforePermissionCheck",
      "AfterPermissionCheck",
      "BeforeHookExecution",
      "AfterHookExecution",
    ]) {
      const re = new RegExp(`/\\*\\*\\s*预留[^*]*\\*/\\s*${e} =`);
      expect(hookTypes).toMatch(re);
    }
  });
});

// ───────────────────────── 缺陷 2 ─────────────────────────
describe("缺陷 2：并发子代理的 span 不串台", () => {
  test("TraceContext 结束按 id 移除：A 先结束不弹掉 B", async () => {
    const bus = new TelemetryBus({ enabled: true });
    const root = bus.startSpan("invoke_agent", "root");
    const a = bus.startSpan("chat", "a");
    const b = bus.startSpan("chat", "b");
    a.end();
    expect(bus.getTraceContext()!.currentSpanId).toBe(b.spanId);
    b.end();
    expect(bus.getTraceContext()!.currentSpanId).toBe(root.spanId);
  });

  test("三个成员并发：每个成员的 chat / tool span 都挂在自己的 invoke_agent 下", async () => {
    const { bus, spans, hookSystem } = setup();
    await hookSystem.fireSessionStartEvent("startup", { model: "claude-sonnet-4" });

    const runMember = async (id: string) => {
      await hookSystem.fireSubagentStartEvent(id, "task", undefined, { model: "claude-sonnet-4" });
      await runInSpanScope(id, async () => {
        await hookSystem.fireBeforeModelEvent(req);
        await tick(); // 让其它成员插进来交错执行
        await hookSystem.firePostToolUseEvent("read", {}, { output: "x" }, false, `${id}-t`);
        await tick();
        await hookSystem.fireAfterModelEvent(req, {
          text: id,
          usage: { inputTokens: 1, outputTokens: 1 },
          stop_reason: "end_turn",
        });
      });
      await hookSystem.fireSubagentStopEvent({ agent_id: id, agent_type: "task", success: true });
    };
    await Promise.all(["m1", "m2", "m3"].map(runMember));
    await hookSystem.fireSessionEndEvent("exit", { total_cost_usd: 0 });
    await bus.flush();

    const root = spans.find((s) => s.kind === "invoke_agent" && !s.parentSpanId)!;
    expect(root).toBeDefined();
    for (const id of ["m1", "m2", "m3"]) {
      const agent = spans.find((s) => s.attributes["sidcode.subagent.id"] === id)!;
      expect(agent.parentSpanId).toBe(root.spanId); // 不是别的成员
      const chat = spans.find((s) => s.kind === "chat" && s.parentSpanId === agent.spanId);
      expect(chat).toBeDefined();
      const tool = spans.find(
        (s) => s.kind === "execute_tool" && s.attributes["gen_ai.tool.call.id"] === `${id}-t`,
      )!;
      expect(tool.parentSpanId).toBe(agent.spanId);
    }
    // 全部 chat span 都落盘（并发 BeforeModel 不再互相覆盖）
    expect(spans.filter((s) => s.kind === "chat")).toHaveLength(3);
    // 收尾后共享栈清空，无幽灵 parent
    expect(bus.getTraceContext()!.depth).toBe(0);
  });
});

// ───────────────────────── 缺陷 3 ─────────────────────────
describe("缺陷 3：chat span 在异常路径上也 end 入队", () => {
  test("响应无 usage：span 照样落盘、标 usage.missing、不留在栈上", async () => {
    const { bus, spans, hookSystem } = setup();
    await hookSystem.fireSessionStartEvent("startup", { model: "claude-sonnet-4" });
    await hookSystem.fireBeforeModelEvent(req);
    await hookSystem.fireAfterModelEvent(req, { text: "截断", stop_reason: undefined });
    await hookSystem.firePostToolUseEvent("read", {}, { output: "x" }, false, "t1");
    await bus.flush();

    const chat = spans.find((s) => s.kind === "chat")!;
    expect(chat).toBeDefined();
    expect(chat.attributes["sidcode.usage.missing"]).toBe(true);
    const root = bus.getTraceContext()!.currentSpanId;
    const tool = spans.find((s) => s.kind === "execute_tool")!;
    // 修复前 tool 的 parent 是那个永不落盘的 chat span
    expect(tool.parentSpanId).toBe(root!);
  });

  test("AfterModel 没 fire：下一轮 BeforeModel 把上一轮收掉（标 error）", async () => {
    const { bus, spans, hookSystem } = setup();
    await hookSystem.fireSessionStartEvent("startup", { model: "claude-sonnet-4" });
    await hookSystem.fireBeforeModelEvent(req); // 这一轮流中途抛异常，AfterModel 不 fire
    await hookSystem.fireBeforeModelEvent(req);
    await hookSystem.fireAfterModelEvent(req, {
      text: "ok",
      usage: { inputTokens: 1, outputTokens: 1 },
      stop_reason: "end_turn",
    });
    await bus.flush();
    const chats = spans.filter((s) => s.kind === "chat");
    expect(chats).toHaveLength(2);
    expect(chats[0]!.status).toBe("error");
    expect(chats[0]!.attributes["sidcode.span.abandoned"]).toBe("after_model_not_fired");
    expect(chats[1]!.parentSpanId).toBe(chats[0]!.parentSpanId); // 不挂在被抛弃的那个下面
  });

  test("最后一轮 AfterModel 没 fire：SessionEnd 收掉，且早于根 span", async () => {
    const { bus, spans, hookSystem } = setup();
    await hookSystem.fireSessionStartEvent("startup", { model: "claude-sonnet-4" });
    await hookSystem.fireBeforeModelEvent(req);
    await hookSystem.fireSessionEndEvent("exit", { total_cost_usd: 0 });
    await bus.flush();
    const idxChat = spans.findIndex((s) => s.kind === "chat");
    const idxRoot = spans.findIndex((s) => s.kind === "invoke_agent");
    expect(idxChat).toBeGreaterThanOrEqual(0);
    expect(idxChat).toBeLessThan(idxRoot);
    expect(spans[idxChat]!.attributes["sidcode.span.abandoned"]).toBe("session_end");
  });
});

// ───────────────────────── 缺陷 12 / 32 ─────────────────────────
describe("缺陷 12 / 32：TokenMeter 的成本与节省", () => {
  const usage: Usage = {
    inputTokens: 1_000, // Anthropic：未命中余量
    outputTokens: 100,
    cacheReadInputTokens: 9_000,
  };

  test("缺陷 12：Anthropic 族有命中时 savings > 0，且等于 promptTotal 全价 − 实际", () => {
    const meter = new TokenMeter(null, priceFor);
    const actual = priceFor("claude", usage, "anthropic");
    const { cacheSavingsUSD } = meter.record({
      model: "claude-sonnet-4",
      provider: "anthropic",
      usage,
      costUSD: actual,
    });
    const full = (10_000 * 1 + 100 * 5) / 1_000_000;
    expect(cacheSavingsUSD).toBeCloseTo(full - actual, 12);
    expect(cacheSavingsUSD).toBeGreaterThan(0);
  });

  test("缺陷 12：OpenAI 族口径不变（inputTokens 已含命中）", () => {
    const meter = new TokenMeter(null, priceFor);
    const oai: Usage = { inputTokens: 10_000, outputTokens: 100, cacheReadInputTokens: 9_000 };
    const actual = priceFor("gpt", oai, "openai");
    const { cacheSavingsUSD } = meter.record({
      model: "gpt-5",
      provider: "openai",
      usage: oai,
      costUSD: actual,
    });
    expect(cacheSavingsUSD).toBeCloseTo((9_000 * 0.9) / 1_000_000, 12);
  });

  test("缺陷 32：costUSD 缺省时按 model 定价回算", () => {
    const meter = new TokenMeter(null, priceFor);
    const { costUSD, cacheSavingsUSD } = meter.record({
      model: "claude-sonnet-4",
      provider: "anthropic",
      usage,
    });
    expect(costUSD).toBeCloseTo(priceFor("c", usage, "anthropic"), 12);
    const full = (10_000 + 500) / 1_000_000;
    expect(cacheSavingsUSD).toBeLessThan(full); // 修复前 = 全价
  });

  test("缺陷 32：子代理经 SubagentStop 发出的 cost metric 非 0、savings 不等于全价", async () => {
    const { bus, metrics, hookSystem } = setup(new TokenMeter(null, priceFor));
    await hookSystem.fireSessionStartEvent("startup", { model: "claude-sonnet-4" });
    await hookSystem.fireSubagentStartEvent("a1", "explore", undefined, {});
    await hookSystem.fireSubagentStopEvent({
      agent_id: "a1",
      agent_type: "explore",
      model: "claude-sonnet-4",
      provider: "anthropic",
      usage,
    });
    await bus.flush();
    const cost = metrics.filter((m) => m.name === "sidcode.cost.usd");
    expect(cost).toHaveLength(1);
    expect(cost[0]!.value).toBeCloseTo(priceFor("c", usage, "anthropic"), 12);
    const sav = metrics.find((m) => m.name === "sidcode.cost.cache_savings_usd")!;
    expect(sav.value).toBeCloseTo((10_500 - 1_000 - 900 - 500) / 1_000_000, 12);
  });
});

// ───────────────────────── 缺陷 21 ─────────────────────────
describe("缺陷 21：隐私级别禁用遥测时 OTLP 不外发", () => {
  const otlpCfg = {
    enabled: true,
    exporters: [{ type: "otlp" as const, options: { endpoint: "http://127.0.0.1:9" } }],
  };

  afterEach(async () => {
    await shutdownTelemetry();
  });

  for (const [label, apply] of [
    ["SID_CODE_DISABLE_TELEMETRY=1", () => (process.env.SID_CODE_DISABLE_TELEMETRY = "1")],
    [
      "SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
      () => (process.env.SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"),
    ],
    ["配置 privacy_level=no-telemetry", () => setConfiguredPrivacyLevel("no-telemetry")],
  ] as const) {
    test(`${label}：initTelemetry 不注册 OTLP 导出器`, () => {
      apply();
      const bus = initTelemetry(otlpCfg);
      expect((bus as any).exporters).toHaveLength(0);
    });
  }

  test("default 隐私级别下照常注册（不是恒拦的死断言）", () => {
    const bus = initTelemetry(otlpCfg);
    expect((bus as any).exporters).toHaveLength(1);
  });

  test("纵深：已注册的导出器在出网前再判一次", async () => {
    const exp = new OtlpTelemetryExporter({ endpoint: "http://127.0.0.1:9" });
    let calls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      process.env.SID_CODE_DISABLE_TELEMETRY = "1";
      const span = new TelemetryBus({ enabled: true }).startSpan("chat", "c");
      await exp.exportSpans([
        {
          ...(span as any),
          spanId: "s",
          traceId: "t",
          name: "c",
          kind: "chat",
          status: "ok",
          startTime: 0,
          endTime: 1,
          durationMs: 1,
          attributes: {},
          events: [],
        },
      ]);
      await exp.exportMetrics([
        { name: "m", value: 1, timestamp: 0, attributes: {}, type: "counter" },
      ]);
      expect(calls).toBe(0);
      delete process.env.SID_CODE_DISABLE_TELEMETRY;
      await exp.exportMetrics([
        { name: "m", value: 1, timestamp: 0, attributes: {}, type: "counter" },
      ]);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

// ───────────────────────── 缺陷 28 ─────────────────────────
describe("缺陷 28：_preview 属性过脱敏", () => {
  test("system_prompt_preview / output_preview 不含原文密钥", async () => {
    process.env.SID_CODE_CONTENT_TRACING = "1";
    const { bus, spans, hookSystem } = setup();
    const secret = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    await hookSystem.fireSessionStartEvent("startup", { model: "claude-sonnet-4" });
    await hookSystem.fireBeforeModelEvent({ ...req, system: `key=${secret}` });
    await hookSystem.fireAfterModelEvent(req, {
      text: `你给的 key ${secret} 已失效`,
      usage: { inputTokens: 1, outputTokens: 1 },
      stop_reason: "end_turn",
    });
    await bus.flush();
    const chat = spans.find((s) => s.kind === "chat")!;
    const sys = String(chat.attributes["sidcode.content.system_prompt_preview"]);
    const out = String(chat.attributes["sidcode.content.output_preview"]);
    expect(sys).not.toContain(secret);
    expect(out).not.toContain(secret);
    expect(sys.startsWith("key=sk-ant-")).toBe(true); // 保头：确实是脱敏而不是丢掉
    // 字节数与 event 的 content_bytes 同口径（脱敏后）
    const evt = chat.events.find((e) => e.name === "content.system_prompt")!;
    expect(chat.attributes["sidcode.content.system_prompt_bytes"]).toBe(
      evt.attributes!.content_bytes,
    );
  });
});

// ───────────────────────── 缺陷 35 ─────────────────────────
describe("缺陷 35：隐私级别禁用遥测时磁盘缓存不重放、不删", () => {
  function seed(dir: string): string {
    const f = join(dir, "failed_events-prev-session.jsonl");
    writeFileSync(
      f,
      JSON.stringify({ eventName: "e", metadata: {}, timestamp: 1, attempts: 0 }) + "\n",
    );
    return f;
  }

  test("no-telemetry：sendFn 不被调用，文件原样保留", async () => {
    const dir = mkdtempSync(join(testHome, "cache-"));
    seed(dir);
    process.env.SID_CODE_DISABLE_TELEMETRY = "1";
    let sent = 0;
    await new EventDiskCache({ cacheDir: dir, sessionId: "s", maxRetries: 8 }).retryPreviousBatches(
      async () => void sent++,
    );
    expect(sent).toBe(0);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  test("default：照常重放并删除（不是恒拦的死断言）", async () => {
    const dir = mkdtempSync(join(testHome, "cache-"));
    seed(dir);
    let sent = 0;
    await new EventDiskCache({ cacheDir: dir, sessionId: "s", maxRetries: 8 }).retryPreviousBatches(
      async () => void sent++,
    );
    expect(sent).toBe(1);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  test("init-helpers：远程上报后端的注册判据是 isTelemetryDisabled，不是 shouldLoadRemoteConfig", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/query/init-helpers.ts"), "utf-8");
    const sec = src.slice(src.indexOf("// 3. 注册后端"));
    expect(sec).toContain("const allowRemoteReport = !isTelemetryDisabled();");
    expect(sec).not.toMatch(/if \(shouldLoadRemoteConfig\(\)\) \{\s*const \{ resolveEndpoint \}/);
    expect(sec).not.toContain("backends && shouldLoadRemoteConfig()");
  });
});
