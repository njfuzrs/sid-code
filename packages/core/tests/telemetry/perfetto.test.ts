/**
 * 缺陷 38：Perfetto 导出（span 树的第三个出口）此前 78 行零测试。
 * 覆盖：ms→μs 换算、默认路径不落 cwd、截断在文件里可见、TID 映射。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import {
  spanToPerfettoEvent,
  buildPerfettoTrace,
  writePerfettoTrace,
  defaultPerfettoPath,
} from "@sid-code/core/telemetry/perfetto.ts";
import { TelemetryBus } from "@sid-code/core/telemetry/bus.ts";
import type { SpanData } from "@sid-code/core/telemetry/types.ts";

function span(over: Partial<SpanData> = {}): SpanData {
  return {
    traceId: "t".repeat(32),
    spanId: "s".repeat(16),
    name: "chat m",
    kind: "chat",
    status: "ok",
    startTime: 1_700_000_000_123,
    endTime: 1_700_000_000_373,
    durationMs: 250,
    attributes: {},
    events: [],
    ...over,
  } as SpanData;
}

let tmp: string;
let savedDir: string | undefined;
let savedEnv: string | undefined;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sid-perfetto-"));
  savedDir = process.env.SID_CONFIG_DIR;
  savedEnv = process.env.SID_CODE_PERFETTO_TRACE;
  process.env.SID_CONFIG_DIR = tmp;
});
afterEach(() => {
  if (savedDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = savedDir;
  if (savedEnv === undefined) delete process.env.SID_CODE_PERFETTO_TRACE;
  else process.env.SID_CODE_PERFETTO_TRACE = savedEnv;
  rmSync(tmp, { recursive: true, force: true });
});

describe("缺陷 38：Perfetto 导出", () => {
  test("ms → μs：ts 与 dur 都乘 1000（写错一处时间轴缩放 1000 倍）", () => {
    const e = spanToPerfettoEvent(span());
    expect(e.ts).toBe(1_700_000_000_123_000);
    expect(e.dur).toBe(250_000);
    expect(e.ph).toBe("X");
  });

  test("TID 按 kind 分泳道；父子关系进 args", () => {
    expect(spanToPerfettoEvent(span({ kind: "invoke_agent" } as any)).tid).toBe(1);
    expect(spanToPerfettoEvent(span()).tid).toBe(2);
    expect(spanToPerfettoEvent(span({ kind: "execute_tool" } as any)).tid).toBe(3);
    expect(spanToPerfettoEvent(span({ parentSpanId: "p".repeat(16) })).args!.parent_span_id).toBe(
      "p".repeat(16),
    );
  });

  test("默认路径在 sid home 下的绝对路径，不在 process.cwd()", () => {
    const p = defaultPerfettoPath(42);
    expect(isAbsolute(p)).toBe(true);
    expect(p.startsWith(tmp)).toBe(true);
    expect(p.startsWith(process.cwd() + "/sid-code-trace-")).toBe(false);
  });

  test("SID_CODE_PERFETTO_TRACE=1 是开关：写到 sid home，并自动建目录", () => {
    process.env.SID_CODE_PERFETTO_TRACE = "1";
    const p = writePerfettoTrace([span()])!;
    expect(p.startsWith(join(tmp, "telemetry", "perfetto"))).toBe(true);
    expect(JSON.parse(readFileSync(p, "utf8")).traceEvents.length).toBe(1);
  });

  test("显式路径按用户意图写", () => {
    const target = join(tmp, "custom", "t.json");
    process.env.SID_CODE_PERFETTO_TRACE = target;
    expect(writePerfettoTrace([span()])).toBe(target);
    expect(existsSync(target)).toBe(true);
  });

  test("截断写进文件 otherData；未截断时不带", () => {
    expect(buildPerfettoTrace([span()]).otherData).toBeUndefined();
    const t = buildPerfettoTrace([span()], 37);
    expect(t.otherData!.sid_code_truncated).toBe(true);
    expect(t.otherData!.sid_code_evicted_spans).toBe(37);
  });

  test("bus.shutdown 端到端：超过 500 条 span 时落盘文件标出被淘汰条数", async () => {
    process.env.SID_CODE_PERFETTO_TRACE = join(tmp, "e2e.json");
    const bus = new TelemetryBus({ enabled: true, exporters: [] } as any);
    for (let i = 0; i < 503; i++) bus.startSpan("chat", "chat x").end();
    await bus.shutdown();
    const t = JSON.parse(readFileSync(join(tmp, "e2e.json"), "utf8"));
    expect(t.traceEvents.length).toBe(500);
    expect(t.otherData.sid_code_evicted_spans).toBe(3);
  });
});
