/**
 * 可观测性缺陷 15–20 回归（20260927 审计）
 *
 * 15：非流式请求的计费收口（BilledRequest + HttpConnected 成对、恒等式同口径）
 * 16：非流式影子调用无 usage 时仍入账一次（usageMissing）
 * 17：bus 暴露未结束 span 的快照（根 span 在会话中可见）
 * 19：history 截断计数
 * 20：JSONL 写前轮转 + 轮转代枚举
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenAIProvider } from "@sid-code/core/llm/openai.ts";
import { AnthropicProvider } from "@sid-code/core/llm/anthropic.ts";
import {
  addBillingObserver,
  resetBillingSink,
  shouldChargeBilledRequest,
  BILLING_SELF_REPORTED_LABELS,
  type BilledRequest,
} from "@sid-code/core/llm/billing-sink.ts";
import { sendNonStreamingSideCall } from "@sid-code/core/llm/side-call-nonstreaming.ts";
import { initStreamObserver, resetStreamObserver } from "@sid-code/core/trace/stream-observer.ts";
import { getSideStats, resetSideCallStats } from "@sid-code/core/trace/side-call-sink.ts";
import { TelemetryBus } from "@sid-code/core/telemetry/bus.ts";
import { JsonlExporter, listJsonlGenerations } from "@sid-code/core/telemetry/exporters/jsonl.ts";
import type { SpanData } from "@sid-code/core/telemetry/types.ts";

const params = {
  model: "m",
  messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
  maxTokens: 8,
};

describe("缺陷 15：非流式计费收口", () => {
  let billed: BilledRequest[];
  let events: Array<{ event: string; data: any }>;
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    resetBillingSink();
    resetSideCallStats();
    billed = [];
    events = [];
    addBillingObserver((r) => billed.push(r));
    initStreamObserver("s1", "/nonexistent", (e: any) => events.push(e));
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    resetBillingSink();
    resetStreamObserver();
  });

  const mockFetch = (status: number, body: unknown) => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
  };

  test("OpenAI Chat 非流式：BilledRequest 与 HttpConnected 各一条（恒等式同口径）", async () => {
    mockFetch(200, {
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 5 },
    });
    const p = new OpenAIProvider("k", "gpt-4o", "https://example.invalid/v1");
    await p.sendMessageNonStreaming(params);
    expect(billed).toHaveLength(1);
    expect(billed[0]!.usage.inputTokens).toBe(100);
    // 主循环身份（无 ALS）⇒ accounted，不加钱
    expect(billed[0]!.accounted).toBe(true);
    const names = events.map((e) => e.event);
    expect(names.filter((n) => n === "HttpConnected")).toHaveLength(1);
    expect(names.filter((n) => n === "BilledRequest")).toHaveLength(1);
  });

  test("非 2xx：两边都不记（与 digest 只数 2xx HttpConnected 同口径）", async () => {
    mockFetch(500, { error: "boom" });
    const p = new OpenAIProvider("k", "gpt-4o", "https://example.invalid/v1");
    await expect(p.sendMessageNonStreaming(params)).rejects.toThrow();
    expect(billed).toHaveLength(0);
    expect(events.filter((e) => e.event === "HttpConnected")).toHaveLength(0);
  });

  test("2xx 但无 usage：仍发一条 0 token 的 BilledRequest（花了钱就必须可见）", async () => {
    mockFetch(200, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
    const p = new OpenAIProvider("k", "gpt-4o", "https://example.invalid/v1");
    await p.sendMessageNonStreaming(params);
    expect(billed).toHaveLength(1);
    expect(billed[0]!.usage.inputTokens).toBe(0);
  });

  test("Anthropic 非流式同样收口", async () => {
    const p = new AnthropicProvider("k", "claude-sonnet-4-20250514");
    (p as any).client.messages.create = async () => ({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 30 },
    });
    await p.sendMessageNonStreaming(params);
    expect(billed).toHaveLength(1);
    expect(billed[0]!.usage.cacheReadInputTokens).toBe(30);
    expect(events.filter((e) => e.event === "HttpConnected")).toHaveLength(1);
  });

  test("影子调用经 sendNonStreamingSideCall：带 caller 且不被消费侧二次加钱", async () => {
    mockFetch(200, {
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 1 },
    });
    const p = new OpenAIProvider("k", "gpt-4o", "https://example.invalid/v1");
    await sendNonStreamingSideCall(p, params, undefined, {
      querySource: "tool_classifier",
      label: "tool-classifier",
    });
    expect(billed).toHaveLength(1);
    expect(billed[0]!.callerLabel).toBe("tool_classifier");
    expect(billed[0]!.accounted).toBe(false);
    expect(shouldChargeBilledRequest(billed[0]!)).toBe(false);
    // 钱由 recordSideCall 记一次
    const stats = getSideStats();
    expect(stats.apiCalls).toBe(1);
    expect(stats.byLabel["tool-classifier"]).toEqual({ success: 1, failed: 0 });
  });
});

describe("缺陷 16：非流式影子调用无 usage 也入账", () => {
  beforeEach(() => resetSideCallStats());

  test("usage 缺失 ⇒ 记一次调用，标 usageMissing", async () => {
    const provider = {
      sendMessageNonStreaming: async () => ({
        role: "assistant",
        content: [],
        stopReason: "end_turn",
        usage: undefined,
      }),
    } as any;
    await sendNonStreamingSideCall(provider, params, undefined, {
      querySource: "cache_warmup",
      label: "cache-warmup",
    });
    const stats = getSideStats();
    expect(stats.apiCalls).toBe(1);
    expect(stats.usageMissing).toBe(1);
    expect(stats.tokensSent).toBe(0);
  });

  test("五个调用点的 querySource 都登记在白名单（否则消费侧会二次加钱）", () => {
    for (const q of [
      "cache_warmup",
      "tool_classifier",
      "bash_classifier",
      "web_fetch_extract",
      "title_generation",
    ]) {
      expect(BILLING_SELF_REPORTED_LABELS.has(q)).toBe(true);
    }
  });
});

describe("缺陷 17 / 19：bus 的会话内读路径", () => {
  test("未结束的根 span 出现在 getActiveSpans，end 后移入 history 且不重复", () => {
    const bus = new TelemetryBus({ enabled: true, exporters: [] });
    const root = bus.startSpan("invoke_agent", "agent");
    const chat = bus.startSpan("chat", "chat m");
    chat.end();
    expect(bus.getCompletedSpans().map((s) => s.spanId)).toEqual([chat.spanId]);
    const active = bus.getActiveSpans();
    expect(active.map((s) => s.spanId)).toEqual([root.spanId]);
    expect(active[0]!.status).toBe("unset");
    // 快照不进导出队列 / history
    expect(bus.getCompletedSpans()).toHaveLength(1);
    root.end();
    expect(bus.getActiveSpans()).toHaveLength(0);
    expect(bus.getCompletedSpans()).toHaveLength(2);
  });

  test("history 超 500 条时累计截断数", () => {
    const bus = new TelemetryBus({ enabled: true, exporters: [], maxQueueSize: 10_000 });
    for (let i = 0; i < 503; i++) bus.startSpan("chat", `c${i}`).end();
    expect(bus.getCompletedSpans()).toHaveLength(500);
    expect(bus.getEvictedSpanCount()).toBe(3);
  });

  test("遥测关闭时不返回活跃快照", () => {
    const bus = new TelemetryBus({ enabled: false });
    bus.startSpan("chat", "c");
    expect(bus.getActiveSpans()).toHaveLength(0);
  });
});

describe("缺陷 20：JSONL 轮转", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sid-jsonl-rot-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const span = (i: number, pad: number): SpanData => ({
    traceId: "t",
    spanId: `s${i}`,
    name: "x".repeat(pad),
    kind: "chat",
    status: "ok",
    startTime: 0,
    endTime: 1,
    durationMs: 1,
    attributes: {},
    events: [],
  });

  test("写前检查：已有内容时，本批越线先轮转，当前文件不超上限", async () => {
    const ex = new JsonlExporter({ outputDir: dir, maxFileSize: 1000, maxFiles: 5 });
    await ex.exportSpans([span(1, 600)]);
    await ex.exportSpans([span(2, 600)]); // 600+600 > 1000 ⇒ 先轮转
    expect(statSync(join(dir, "traces.jsonl")).size).toBeLessThanOrEqual(1000);
    expect(readdirSync(dir).sort()).toEqual(["traces.1.jsonl", "traces.jsonl"]);
  });

  test("listJsonlGenerations 从旧到新列出全部代", async () => {
    const ex = new JsonlExporter({ outputDir: dir, maxFileSize: 1000, maxFiles: 5 });
    for (let i = 0; i < 3; i++) await ex.exportSpans([span(i, 600)]);
    const gens = listJsonlGenerations(dir, "traces").map((p) => p.slice(dir.length + 1));
    expect(gens).toEqual(["traces.2.jsonl", "traces.1.jsonl", "traces.jsonl"]);
    // 三代合起来正好是全部数据，没有静默丢
    const ids = listJsonlGenerations(dir, "traces").flatMap((p) =>
      require("node:fs")
        .readFileSync(p, "utf8")
        .trim()
        .split("\n")
        .map((l: string) => JSON.parse(l).spanId),
    );
    expect(ids).toEqual(["s0", "s1", "s2"]);
  });

  test("目录为空时返回空数组", () => {
    expect(listJsonlGenerations(dir, "metrics")).toEqual([]);
  });
});
