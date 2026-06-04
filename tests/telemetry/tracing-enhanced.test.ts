import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  runInInteractionContext,
  runInToolContext,
  getCurrentInteractionContext,
  getCurrentToolContext,
  getCurrentSpanContext,
  type SpanContext,
} from "../../src/telemetry/als-context.ts";
import {
  registerSpan,
  unregisterSpan,
  getActiveSpan,
  findActiveSpan,
  getActiveSpanCount,
  sweepOrphanSpans,
  shutdownSpanManager,
} from "../../src/telemetry/span-manager.ts";
import {
  spanToPerfettoEvent,
  buildPerfettoTrace,
  isPerfettoEnabled,
} from "../../src/telemetry/perfetto.ts";
import type { SpanData } from "../../src/telemetry/types.ts";

function ctx(id: string, kind = "chat", startTime = Date.now()): SpanContext {
  return { traceId: "t1", spanId: id, kind, name: `${kind} ${id}`, startTime, ended: false };
}

describe("AsyncLocalStorage 上下文传播（spec 17 §6.1.1）", () => {
  test("交互上下文自动传播到内部函数", () => {
    const c = ctx("span-1", "invoke_agent");
    runInInteractionContext(c, () => {
      expect(getCurrentInteractionContext()?.spanId).toBe("span-1");
    });
    // 退出后上下文清空
    expect(getCurrentInteractionContext()).toBeUndefined();
  });

  test("工具上下文嵌套在交互上下文内", () => {
    runInInteractionContext(ctx("i1", "invoke_agent"), () => {
      runInToolContext(ctx("t1", "execute_tool"), () => {
        expect(getCurrentInteractionContext()?.spanId).toBe("i1");
        expect(getCurrentToolContext()?.spanId).toBe("t1");
        // 当前 span 优先取工具级
        expect(getCurrentSpanContext()?.spanId).toBe("t1");
      });
      // 工具退出后回到交互级
      expect(getCurrentSpanContext()?.spanId).toBe("i1");
    });
  });

  test("异步函数内上下文保持", async () => {
    await runInInteractionContext(ctx("async-1"), async () => {
      await new Promise((r) => setTimeout(r, 5));
      expect(getCurrentInteractionContext()?.spanId).toBe("async-1");
    });
  });
});

describe("Span 生命周期管理（spec 17 §6.1.2）", () => {
  beforeEach(() => shutdownSpanManager());
  afterEach(() => shutdownSpanManager());

  test("注册与查询强引用 Span", () => {
    const c = ctx("s1");
    registerSpan("s1", c, true);
    expect(getActiveSpan("s1")?.spanId).toBe("s1");
    expect(getActiveSpanCount()).toBe(1);
  });

  test("注销移除 Span", () => {
    registerSpan("s1", ctx("s1"), true);
    unregisterSpan("s1");
    expect(getActiveSpan("s1")).toBeUndefined();
  });

  test("findActiveSpan 按 kind+name 查找", () => {
    registerSpan("s1", ctx("s1", "blocked_on_user"), true);
    const found = findActiveSpan("blocked_on_user", "blocked_on_user s1");
    expect(found?.spanId).toBe("s1");
  });

  test("sweepOrphanSpans 回收超时未结束的 Span", () => {
    const old = ctx("old", "chat", Date.now() - 31 * 60 * 1000); // 31 分钟前
    registerSpan("old", old, true);
    const reaped = sweepOrphanSpans();
    expect(reaped).toContain("old");
    expect(getActiveSpan("old")).toBeUndefined();
  });

  test("sweepOrphanSpans 保留未超时的 Span", () => {
    registerSpan("fresh", ctx("fresh"), true);
    sweepOrphanSpans();
    expect(getActiveSpan("fresh")?.spanId).toBe("fresh");
  });
});

describe("Perfetto 追踪（spec 17 §6.2）", () => {
  afterEach(() => {
    delete process.env.SID_CODE_PERFETTO_TRACE;
  });

  const sampleSpan: SpanData = {
    traceId: "trace-1",
    spanId: "span-1",
    parentSpanId: "parent-1",
    name: "chat gpt",
    kind: "chat",
    status: "ok",
    startTime: 1000,
    endTime: 1500,
    durationMs: 500,
    attributes: { "gen_ai.request.model": "claude" },
    events: [],
  };

  test("Span 转 Perfetto 事件（ms → μs）", () => {
    const ev = spanToPerfettoEvent(sampleSpan);
    expect(ev.ph).toBe("X");
    expect(ev.ts).toBe(1_000_000); // 1000ms → 1000000μs
    expect(ev.dur).toBe(500_000);
    expect(ev.cat).toBe("chat");
    expect(ev.args?.trace_id).toBe("trace-1");
    expect(ev.args?.parent_span_id).toBe("parent-1");
  });

  test("buildPerfettoTrace 包裹 traceEvents", () => {
    const trace = buildPerfettoTrace([sampleSpan]);
    expect(trace.traceEvents.length).toBe(1);
  });

  test("isPerfettoEnabled 读环境变量", () => {
    expect(isPerfettoEnabled()).toBe(false);
    process.env.SID_CODE_PERFETTO_TRACE = "1";
    expect(isPerfettoEnabled()).toBe(true);
  });
});
