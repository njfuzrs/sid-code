/**
 * 可观测性缺陷 22–27 / 29 / 30 回归（20260927 审计）
 *
 * 22：span 通道工具名脱敏（MCP 服务名不随 OTLP 外发）
 * 23：recordError 的错误摘要过脱敏、按字节截断
 * 24：billing-sink 时段计数随会话复位
 * 25：fetchId 去重双桶轮换，满桶瞬间不全体失保
 * 26：TTFB 跨路由禁令的结构门禁（provider 级 ttfb 字段一出现即红）
 * 27：HITL 确认耗时进 metric 通道
 * 29：shutdown 排空两条队列，而非只 flush 一个 batch
 * 30：forked-agent 的工具执行进 analytics 与 span
 *
 * ⚠ 落盘隔离：hook-probe 的 SessionStart 会写根 span 标记，按 CONTRIBUTING 约定重定向。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TelemetryBus } from "@sid-code/core/telemetry/bus.ts";
import { TelemetryHookProbe } from "@sid-code/core/telemetry/hook-probe.ts";
import { TokenMeter } from "@sid-code/core/telemetry/metrics/token-meter.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { ATTR } from "@sid-code/core/telemetry/types.ts";
import type { MetricPoint, SpanData, TelemetryExporter } from "@sid-code/core/telemetry/types.ts";
import { maskedErrorSummary } from "@sid-code/core/telemetry/content-tracing.ts";
import {
  addBillingObserver,
  getPriceTierCounts,
  recordBilledRequest,
  recordPriceTier,
  resetBillingSink,
  resetPriceTierCounts,
  type BilledRequest,
} from "@sid-code/core/llm/billing-sink.ts";
import {
  HITL_WAIT_METRIC,
  recordHitlWaitHistogram,
} from "@sid-code/core/telemetry/metrics/latency-histograms.ts";
import { initTelemetry, shutdownTelemetry } from "@sid-code/core/telemetry/index.ts";
import { runForkedAgent, type ForkedAgentContext } from "@sid-code/core/agent/forked-agent.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { __resetAnalyticsForTest, attachAnalyticsSink } from "@sid-code/core/analytics/index.ts";

const prevConfigDir = process.env.SID_CONFIG_DIR;
let testHome: string;
beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "sid-obs-d22-home-"));
  process.env.SID_CONFIG_DIR = testHome;
});
afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(testHome, { recursive: true, force: true });
});

function collectingExporter(opts?: { delayMs?: number }) {
  const spans: SpanData[] = [];
  const metrics: MetricPoint[] = [];
  const exporter: TelemetryExporter = {
    name: "mock",
    exportSpans: async (batch) => {
      if (opts?.delayMs) await Bun.sleep(opts.delayMs);
      spans.push(...batch);
    },
    exportMetrics: async (batch) => {
      metrics.push(...batch);
    },
    shutdown: async () => {},
  };
  return { spans, metrics, exporter };
}

// ─────────────────────────────────────────────────────────────

describe("缺陷 22 / 23：span 通道的工具名与错误摘要脱敏", () => {
  let bus: TelemetryBus;
  let spans: SpanData[];
  let hookSystem: HookSystem;

  beforeEach(() => {
    const c = collectingExporter();
    spans = c.spans;
    bus = new TelemetryBus({ enabled: true, batchSize: 100, flushIntervalMs: 999999 });
    bus.addExporter(c.exporter);
    const probe = new TelemetryHookProbe(bus, new TokenMeter(bus, () => 0), {
      provider: "anthropic",
      model: "claude-sonnet-4",
    } as any);
    hookSystem = new HookSystem();
    probe.registerHooks(hookSystem);
  });

  test("MCP 工具：span name 与 gen_ai.tool.name 都不含服务名", async () => {
    await hookSystem.fireSessionStartEvent("startup", { model: "claude-sonnet-4" });
    await hookSystem.firePostToolUseEvent(
      "mcp__acme-internal-jira__create_ticket",
      {},
      { output: "ok" },
      false,
      "t1",
      { duration_ms: 5 },
    );
    await hookSystem.fireSessionEndEvent("exit");
    await bus.flush();
    const tool = spans.find((s) => s.kind === "execute_tool")!;
    expect(tool.attributes[ATTR.TOOL_NAME]).toBe("mcp_tool");
    expect(tool.name).toBe("execute_tool mcp_tool");
    expect(JSON.stringify(spans)).not.toContain("acme-internal-jira");
  });

  test("内置工具名保持原样（脱敏不误伤）", async () => {
    await hookSystem.fireSessionStartEvent("startup", { model: "claude-sonnet-4" });
    await hookSystem.firePostToolUseEvent("read", {}, { output: "x" }, false, "t2", {
      duration_ms: 1,
    });
    await hookSystem.fireSessionEndEvent("exit");
    await bus.flush();
    expect(spans.find((s) => s.kind === "execute_tool")!.attributes[ATTR.TOOL_NAME]).toBe("read");
  });

  test("失败路径的 error.message 过脱敏：工具返回值里的密钥不原样外发", async () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    await hookSystem.fireSessionStartEvent("startup", { model: "claude-sonnet-4" });
    await hookSystem.firePostToolUseEvent(
      "bash",
      { command: "env" },
      { output: `AWS_ACCESS_KEY_ID=${secret}` },
      true,
      "t3",
      { duration_ms: 1 },
    );
    await hookSystem.fireSessionEndEvent("exit");
    await bus.flush();
    const tool = spans.find((s) => s.kind === "execute_tool")!;
    expect(tool.status).toBe("error");
    expect(JSON.stringify(tool)).not.toContain(secret);
  });

  test("maskedErrorSummary 按 UTF-8 字节截断且不切坏多字节字符", () => {
    const out = maskedErrorSummary("中".repeat(200), 200);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(200);
    expect(out).not.toContain("�");
    expect(out.length).toBe(66); // 200 / 3 向下取整
  });
});

// ─────────────────────────────────────────────────────────────

describe("缺陷 24 / 25：billing-sink 的会话复位与去重窗口", () => {
  beforeEach(() => resetBillingSink());
  afterEach(() => resetBillingSink());

  const req = (fetchId: string): BilledRequest =>
    ({
      fetchId,
      index: 0,
      model: "m",
      provider: "openai",
      accounted: false,
      usage: { inputTokens: 1, outputTokens: 1 },
    }) as BilledRequest;

  test("resetPriceTierCounts 清时段计数但保留观察者", () => {
    const seen: string[] = [];
    addBillingObserver((r) => seen.push(r.fetchId));
    recordPriceTier("peak");
    recordPriceTier("offpeak");
    expect(getPriceTierCounts()).toEqual({ peak: 1, tiered: 2 });
    resetPriceTierCounts();
    expect(getPriceTierCounts()).toEqual({ peak: 0, tiered: 0 });
    recordBilledRequest(req("after-reset"));
    expect(seen).toEqual(["after-reset"]);
  });

  test("resetPriceTierCounts 有生产调用点（会话开始时清零）", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "src", "trace", "collector.ts"),
      "utf-8",
    );
    expect(src).toMatch(/\bresetPriceTierCounts\(\)/);
  });

  test("满桶轮换瞬间，紧邻轮换前的 fetchId 仍受保护（不重复入账）", () => {
    let charged = 0;
    addBillingObserver(() => charged++);
    for (let i = 0; i < 4096; i++) recordBilledRequest(req(`f${i}`));
    expect(charged).toBe(4096);
    // 第 4097 个触发轮换；随后 f4095 的第二次 emit 必须被挡住
    recordBilledRequest(req("f4096"));
    recordBilledRequest(req("f4095"));
    recordBilledRequest(req("f0"));
    expect(charged).toBe(4097);
  });
});

// ─────────────────────────────────────────────────────────────

describe("缺陷 26：TTFB 不得出现 provider 级汇总字段（结构门禁）", () => {
  const SRC_ROOTS = ["core", "cli"].map((p) => join(import.meta.dir, "..", "..", "..", p, "src"));
  /** 唯一允许定义 ttfb 分位字段的模块：按 model 分组的单一事实源 */
  const ALLOWED = join("trace", "latency-by-model.ts");

  function walk(dir: string, acc: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      const full = join(dir, e);
      if (statSync(full).isDirectory()) walk(full, acc);
      else if (/\.tsx?$/.test(e)) acc.push(full);
    }
    return acc;
  }

  /** 字段声明 / 对象字面量键：`ttfb_p50?:`、`ttfbP95:`、`ttfb_avg =` 等 */
  const FIELD = /\bttfb_?(p\d{2}|avg|mean|median)\b\s*\??\s*[:=]/i;

  function violations(files: Array<{ rel: string; text: string }>): string[] {
    const out: string[] = [];
    for (const { rel, text } of files) {
      if (rel.endsWith(ALLOWED)) continue;
      text.split("\n").forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
        if (FIELD.test(code)) out.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    return out;
  }

  test("生产源码里 latency-by-model.ts 之外没有任何 ttfb 分位/均值字段", () => {
    const files = SRC_ROOTS.flatMap((root) =>
      walk(root).map((full) => ({
        rel: full.slice(root.length + 1),
        text: readFileSync(full, "utf-8"),
      })),
    );
    expect(files.length).toBeGreaterThan(100); // 防扫到空目录假绿
    const v = violations(files);
    expect(v, `TTFB 只能按 model 分组（见 latency-by-model.ts 头注释）：\n${v.join("\n")}`).toEqual(
      [],
    );
  });

  test("变异自证：在别处声明 provider 级 ttfb_p50 会被抓到；注释里提及不误报", () => {
    expect(
      violations([{ rel: "trace/digest.ts", text: "interface X {\n  ttfb_p50?: number;\n}" }]),
    ).toHaveLength(1);
    expect(
      violations([{ rel: "trace/digest.ts", text: "const s = { ttfbP95: 1 };" }]),
    ).toHaveLength(1);
    expect(
      violations([
        {
          rel: "trace/digest.ts",
          text: "   * ⚠️ 本结构里**没有** provider 级的 `ttfb_p50` 对应项",
        },
      ]),
    ).toHaveLength(0);
    expect(
      violations([{ rel: "trace/latency-by-model.ts", text: "  ttfb_p50?: number;" }]),
    ).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────

describe("缺陷 27：HITL 确认耗时进 metric 通道", () => {
  afterEach(async () => {
    await shutdownTelemetry();
  });

  test("recordHitlWaitHistogram 落 histogram（秒），工具名脱敏", () => {
    const bus = initTelemetry({ enabled: true, flushIntervalMs: 999999 });
    recordHitlWaitHistogram(2500, "mcp__secret-srv__do", "allow", "user");
    const pts = bus.getCompletedMetrics().filter((m: MetricPoint) => m.name === HITL_WAIT_METRIC);
    expect(pts).toHaveLength(1);
    expect(pts[0]!.value).toBe(2.5);
    expect(pts[0]!.type).toBe("histogram");
    expect(pts[0]!.attributes["gen_ai.tool.name"]).toBe("mcp_tool");
    expect(pts[0]!.attributes["sidcode.permission.outcome"]).toBe("allow");
  });

  test("接进主循环的弹窗路径（生产调用点存在）", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "src", "query", "tool-executor.ts"),
      "utf-8",
    );
    expect(src).toMatch(/\brecordHitlWaitHistogram\(/);
  });
});

// ─────────────────────────────────────────────────────────────

describe("缺陷 29：shutdown 等在途导出落地", () => {
  test("慢导出器：达阈值触发的后台批次在 shutdown 返回前全部送达", async () => {
    // 后台批次慢（80ms）、shutdown 自己那批快（0ms）：旧实现只 await 自己那批，
    // 返回时前 3 批还在路上 —— 均匀延迟测不出来（先发的先到），所以必须做成不对称。
    const got: SpanData[] = [];
    let calls = 0;
    const bus = new TelemetryBus({
      enabled: true,
      batchSize: 10,
      maxQueueSize: 1000,
      flushIntervalMs: 999999,
    });
    bus.addExporter({
      name: "slow-first",
      exportSpans: async (batch) => {
        if (calls++ < 3) await Bun.sleep(80);
        got.push(...batch);
      },
      shutdown: async () => {},
    });
    const c = { spans: got };
    // 35 条 ⇒ 3 批在 end() 时后台触发（fire-and-forget），5 条留给 shutdown 那次 flush
    for (let i = 0; i < 35; i++) bus.startSpan("chat", `s${i}`).end();
    await bus.shutdown();
    expect(c.spans).toHaveLength(35);
  });

  test("导出器卡死时有总时限，不挂住退出", async () => {
    const c = collectingExporter({ delayMs: 10_000 });
    const bus = new TelemetryBus({ enabled: true, batchSize: 5, flushIntervalMs: 999999 });
    bus.addExporter(c.exporter);
    for (let i = 0; i < 12; i++) bus.startSpan("chat", `s${i}`).end();
    const t0 = Date.now();
    await bus.drain(100);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

// ─────────────────────────────────────────────────────────────

describe("缺陷 30：forked-agent 的工具执行可观测", () => {
  const events: Array<{ name: string; meta: Record<string, unknown> }> = [];

  beforeEach(() => {
    events.length = 0;
    __resetAnalyticsForTest();
    attachAnalyticsSink({ logEvent: (name, meta) => events.push({ name, meta: meta as any }) });
  });
  afterEach(async () => {
    __resetAnalyticsForTest();
    await shutdownTelemetry();
  });

  function provider() {
    let call = 0;
    const scripts: any[][] = [
      [
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "t1", name: "read" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"file_path":"/tmp/a"}' },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { outputTokens: 1 } },
      ],
    ];
    return {
      name: () => "mock",
      defaultModel: () => "mock-model",
      async *sendMessageStream() {
        const ev = scripts[call++] ?? [
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { outputTokens: 1 } },
        ];
        for (const e of ev) yield e;
      },
    };
  }

  class EchoTool {
    name() {
      return "read";
    }
    description() {
      return "读";
    }
    inputSchema() {
      return { type: "object", properties: { file_path: { type: "string" } } };
    }
    async execute() {
      return { output: "content" };
    }
    readOnly() {
      return true;
    }
  }

  test("成功的工具调用：tool_call + tool_success 各一条，且产出 execute_tool span", async () => {
    const bus = initTelemetry({ enabled: true, flushIntervalMs: 999999 });
    const registry = new ToolRegistry();
    registry.register(new EchoTool() as any);
    const ctx: ForkedAgentContext = {
      systemPrompt: "s",
      messages: [],
      provider: provider() as any,
      toolRegistry: registry,
      model: "mock-model",
      statefulTools: [],
    };
    await runForkedAgent(ctx, {
      promptMessages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      canUseTool: () => ({ behavior: "allow" }),
      maxTurns: 3,
      querySource: "test_forked",
    });
    await Bun.sleep(0);
    const names = events.map((e) => e.name);
    expect(names.filter((n) => n === "tool_call")).toHaveLength(1);
    expect(names.filter((n) => n === "tool_success")).toHaveLength(1);
    const span = bus.getCompletedSpans().find((s) => s.kind === "execute_tool");
    expect(span).toBeDefined();
    expect(span!.attributes["sidcode.execution_context"]).toBe("forked");
    expect(span!.attributes["sidcode.forked.query_source"]).toBe("test_forked");
    expect(span!.attributes[ATTR.SUCCESS]).toBe(true);
  });

  test("工具不存在：记 tool_failure(invalid_input)", async () => {
    initTelemetry({ enabled: true, flushIntervalMs: 999999 });
    const ctx: ForkedAgentContext = {
      systemPrompt: "s",
      messages: [],
      provider: provider() as any,
      toolRegistry: new ToolRegistry(),
      model: "mock-model",
      statefulTools: [],
    };
    await runForkedAgent(ctx, {
      promptMessages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      canUseTool: () => ({ behavior: "allow" }),
      maxTurns: 3,
      querySource: "test_forked",
    });
    await Bun.sleep(0);
    const fail = events.find((e) => e.name === "tool_failure");
    expect(fail).toBeDefined();
    expect(fail!.meta.failure_kind ?? fail!.meta.kind).toBe("invalid_input");
  });
});
