import { describe, expect, test, afterEach } from "bun:test";
import {
  spanToPerfettoEvent,
  buildPerfettoTrace,
  isPerfettoEnabled,
} from "@sid-code/core/telemetry/perfetto.ts";
import type { SpanData } from "@sid-code/core/telemetry/types.ts";

// 本文件原先还覆盖 als-context.ts（AsyncLocalStorage 上下文传播）与 span-manager.ts
// （WeakRef + TTL 的 Span 生命周期管理）两个模块，spec 17 §6.1.1 / §6.1.2。
//
// 两个模块已于 2026-08-08 删除：它们是**能力已被取代后的残留**，不是接线缺口。
// 生产追踪链路走 bus.ts + context.ts 的 TraceContext：
//   - 父子关系由 TraceContext 的 spanStack 维护（pushSpan / popSpan），不用 ALS；
//   - 生命周期由 SpanHandle.end() 负责，每条 trace 一个新 TraceContext，栈随之回收，
//     没有 span-manager 的 WeakRef + 30 分钟 TTL 要防的那种孤儿泄漏。
// bus.ts 对两个模块是零引用，唯一消费者就是本文件——即"测试是唯一消费者"那类债。
//
// hook-probe.ts 里三个 pending span Map 曾被怀疑需要 TTL 兜底，已逐条核过：
//   - permissionSpans / hookSpans：对应的 4 个 hook 事件
//     （Before/AfterPermissionCheck、Before/AfterHookExecution）在生产中**从不 emit**，
//     两个 Map 恒空，无从泄漏；
//   - subagentSpans：SubagentStop 在 sub-agent.ts 两处调用点都在 finally 里，配对有保证。
// 若将来那 4 个事件真的接线，需要重新评估兜底清理——但那时该在 hook-probe 内解决，
// 不是复活一个平行的 span 注册表。

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
