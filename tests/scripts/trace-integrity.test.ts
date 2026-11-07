/**
 * trace-integrity 判据脚本的回归测试（X1H2 T4）
 *
 * 这个脚本是 T1/T2 验收的取数工具，所以测试的重点不是「能跑」，而是：
 *
 * 1. **不能把正常现象判成违例。** 根与父 span 都只在 end() 时入队，正在跑的会话
 *    必然缺它们；把「进行中」判成丢根会让报告每次都有噪声，人就不看了。
 * 2. **不能把同源缺陷重复计数。** 无根 trace 的子 span 父必然找不到，那是根丢失的
 *    同一个缺陷；判据二只报「有根 trace 的悬空父」，否则一份缺陷出两条违例。
 * 3. **必须合并轮转文件再判父。** 父在 traces.1.jsonl、子在 traces.jsonl 是正常形态。
 * 4. **根的两种历史写法都认。** `invoke_agent sid-code`（10-03 起）与
 *    `invoke_agent <模型名>`（10-03 前）在同一条判据下。
 *
 * 数据全部写在临时目录里，不读真实 ~/.sid-code。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyze,
  formatReport,
  isRootSpan,
  parseArgs,
  type Span,
} from "../../scripts/trace-integrity.ts";

const dirs: string[] = [];

function mkDir(): string {
  const d = mkdtempSync(join(tmpdir(), "trace-integrity-test-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 造一条 span，默认是有父的 chat；显式覆盖字段即可 */
function s(p: Partial<Span> & Pick<Span, "traceId" | "spanId">): Span {
  return { kind: "chat", name: "chat", startTime: 1_000, endTime: 2_000, ...p };
}

function root(
  traceId: string,
  spanId: string,
  name = "invoke_agent sid-code",
  startTime = 1_000,
  endTime = 9_000,
): Span {
  return s({
    traceId,
    spanId,
    kind: "invoke_agent",
    name,
    startTime,
    endTime,
    attributes: { "gen_ai.conversation.id": `sess-${traceId}` },
  });
}

/** 写 telemetry 目录；fileName → span 列表 */
function mkTelemetry(files: Record<string, Span[]>): string {
  const dir = mkDir();
  for (const [name, spans] of Object.entries(files)) {
    writeFileSync(join(dir, name), spans.map((x) => JSON.stringify(x)).join("\n") + "\n");
  }
  return dir;
}

interface SessionFixture {
  id: string;
  start: string;
  end?: string;
  endSource?: string;
}

/** 写会话目录；不传 end/endSource 就是「进行中」 */
function mkSessions(list: SessionFixture[]): string {
  const dir = mkDir();
  for (const it of list) {
    const d = join(dir, it.id);
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, "metadata.json"),
      JSON.stringify({
        session_id: it.id,
        start_time: it.start,
        ...(it.end ? { end_time: it.end } : {}),
        ...(it.endSource ? { end_source: it.endSource } : {}),
        total_api_calls: 1,
      }),
    );
  }
  return dir;
}

const ISO = (ms: number) => new Date(ms).toISOString();
const NOW = Date.parse("2026-11-07T12:00:00Z");

describe("isRootSpan：两种历史根名都认", () => {
  test("invoke_agent sid-code 与 invoke_agent <模型名> 都是根", () => {
    expect(isRootSpan(root("t", "r1", "invoke_agent sid-code"))).toBe(true);
    expect(isRootSpan(root("t", "r2", "invoke_agent glm-5.2"))).toBe(true);
  });

  test("有父的 invoke_agent 不是根（子代理）", () => {
    expect(
      isRootSpan(
        s({
          traceId: "t",
          spanId: "c",
          kind: "invoke_agent",
          name: "invoke_agent explore",
          parentSpanId: "r",
        }),
      ),
    ).toBe(false);
  });

  test("无父的 chat 不是根", () => {
    expect(isRootSpan(s({ traceId: "t", spanId: "x", kind: "chat", name: "chat" }))).toBe(false);
  });
});

describe("判据一：每个 trace 恰好一个根", () => {
  test("单根正常 trace：0 违例", () => {
    const dir = mkTelemetry({
      "traces.jsonl": [
        root("t1", "r1"),
        s({ traceId: "t1", spanId: "c1", parentSpanId: "r1" }),
        s({ traceId: "t1", spanId: "c2", parentSpanId: "r1" }),
      ],
    });
    const r = analyze({ telemetryDir: dir, sessionsDir: mkDir(), now: NOW, withSessions: false });
    expect(r.criterion1.exactlyOneRoot).toBe(1);
    expect(r.criterion1.zeroRootClosed).toBe(0);
    expect(r.violations).toHaveLength(0);
  });

  test("无根 + 会话已收尾：违例，并带出 end_source", () => {
    const start = Date.parse("2026-11-06T10:00:00Z");
    const dir = mkTelemetry({
      "traces.jsonl": [
        s({ traceId: "t2", spanId: "c1", startTime: start, endTime: start + 1_000 }),
      ],
    });
    const sessions = mkSessions([
      {
        id: "sess-lost",
        start: ISO(start - 1_000),
        end: ISO(start + 5_000),
        endSource: "terminal_closed",
      },
    ]);
    const r = analyze({ telemetryDir: dir, sessionsDir: sessions, now: NOW });
    expect(r.criterion1.zeroRootClosed).toBe(1);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].kind).toBe("zero_root");
    expect(r.violations[0].endSource).toBe("terminal_closed");
    expect(r.noRootEndSources).toEqual({ terminal_closed: 1 });
  });

  test("无根但会话进行中：不算违例", () => {
    const start = Date.parse("2026-11-07T11:59:30Z");
    const dir = mkTelemetry({
      "traces.jsonl": [
        s({ traceId: "t3", spanId: "c1", startTime: start, endTime: start + 1_000 }),
      ],
    });
    // 会话没有 end_time / end_source = 进行中
    const sessions = mkSessions([{ id: "sess-live", start: ISO(start - 1_000) }]);
    const r = analyze({ telemetryDir: dir, sessionsDir: sessions, now: NOW });
    expect(r.criterion1.zeroRootInProgress).toBe(1);
    expect(r.criterion1.zeroRootClosed).toBe(0);
    expect(r.violations).toHaveLength(0);
  });

  test("无根且无会话，但最后 span 在 60s 内：按进行中处理", () => {
    const start = NOW - 10_000;
    const dir = mkTelemetry({
      "traces.jsonl": [s({ traceId: "t4", spanId: "c1", startTime: start, endTime: start + 500 })],
    });
    const r = analyze({ telemetryDir: dir, sessionsDir: mkDir(), now: NOW, withSessions: false });
    expect(r.criterion1.zeroRootInProgress).toBe(1);
    expect(r.violations).toHaveLength(0);
  });

  test("无根且无会话、已过 60s：算违例（找不到会话）", () => {
    const start = NOW - 600_000;
    const dir = mkTelemetry({
      "traces.jsonl": [s({ traceId: "t5", spanId: "c1", startTime: start, endTime: start + 500 })],
    });
    const r = analyze({ telemetryDir: dir, sessionsDir: mkDir(), now: NOW, withSessions: false });
    expect(r.criterion1.zeroRootClosed).toBe(1);
    expect(r.violations[0].detail).toBe("找不到会话");
    expect(r.violations[0].endSource).toBe("unknown");
  });

  test("多根：违例，明细里列出根名", () => {
    const dir = mkTelemetry({
      "traces.jsonl": [
        root("t6", "r1"),
        root("t6", "r2", "invoke_agent glm-5.2", 8_000, 12_000),
        s({ traceId: "t6", spanId: "c1", parentSpanId: "r1" }),
      ],
    });
    const r = analyze({ telemetryDir: dir, sessionsDir: mkDir(), now: NOW, withSessions: false });
    expect(r.criterion1.multiRoot).toBe(1);
    const v = r.violations.find((x) => x.kind === "multi_root")!;
    expect(v.detail).toContain("invoke_agent sid-code");
    expect(v.detail).toContain("invoke_agent glm-5.2");
  });
});

describe("判据二：没有找不到的父", () => {
  test("父在另一个轮转文件里：不算悬空", () => {
    const dir = mkTelemetry({
      "traces.1.jsonl": [root("t7", "r1")],
      "traces.jsonl": [s({ traceId: "t7", spanId: "c1", parentSpanId: "r1" })],
    });
    const r = analyze({ telemetryDir: dir, sessionsDir: mkDir(), now: NOW, withSessions: false });
    expect(r.criterion2.danglingChildSpans).toBe(0);
    expect(r.violations).toHaveLength(0);
  });

  test("有根 trace 的悬空父：独立违例", () => {
    const start = Date.parse("2026-11-05T10:00:00Z");
    const dir = mkTelemetry({
      "traces.jsonl": [
        root("t8", "r1", "invoke_agent sid-code", start, start + 9_000),
        s({
          traceId: "t8",
          spanId: "c1",
          parentSpanId: "missing",
          startTime: start + 100,
          endTime: start + 200,
        }),
      ],
    });
    const sessions = mkSessions([
      { id: "sess-t8", start: ISO(start), end: ISO(start + 9_000), endSource: "exit" },
    ]);
    const r = analyze({ telemetryDir: dir, sessionsDir: sessions, now: NOW });
    expect(r.criterion2.danglingChildSpans).toBe(1);
    expect(r.criterion2.traces).toBe(1);
    expect(r.violations.filter((v) => v.kind === "dangling_parent")).toHaveLength(1);
  });

  test("无根 trace 的悬空父：归因判据一，不重复计违例", () => {
    const start = Date.parse("2026-11-06T10:00:00Z");
    const dir = mkTelemetry({
      "traces.jsonl": [
        s({
          traceId: "t9",
          spanId: "c1",
          parentSpanId: "lost-root",
          startTime: start,
          endTime: start + 500,
        }),
        s({
          traceId: "t9",
          spanId: "c2",
          parentSpanId: "lost-root",
          startTime: start + 600,
          endTime: start + 700,
        }),
      ],
    });
    const sessions = mkSessions([
      { id: "sess-t9", start: ISO(start - 1_000), end: ISO(start + 5_000), endSource: "abort" },
    ]);
    const r = analyze({ telemetryDir: dir, sessionsDir: sessions, now: NOW });
    expect(r.criterion2.fromZeroRootTraces).toBe(2);
    expect(r.criterion2.danglingChildSpans).toBe(0);
    expect(r.violations.filter((v) => v.kind === "dangling_parent")).toHaveLength(0);
    expect(r.violations.filter((v) => v.kind === "zero_root")).toHaveLength(1);
  });

  test("进行中 trace 的悬空父：不计违例", () => {
    const start = NOW - 5_000;
    const dir = mkTelemetry({
      "traces.jsonl": [
        s({
          traceId: "t10",
          spanId: "c1",
          parentSpanId: "not-yet-ended",
          startTime: start,
          endTime: start + 100,
        }),
      ],
    });
    const r = analyze({ telemetryDir: dir, sessionsDir: mkDir(), now: NOW, withSessions: false });
    expect(r.criterion2.inProgressExcluded).toBe(1);
    expect(r.violations).toHaveLength(0);
  });
});

describe("数据读取与 CLI", () => {
  test("坏行计数而不是静默跳过", () => {
    const dir = mkDir();
    writeFileSync(
      join(dir, "traces.jsonl"),
      '{"traceId":"t","spanId":"a"}\nnot-json\n{"traceId":"t"}\n',
    );
    const r = analyze({ telemetryDir: dir, sessionsDir: mkDir(), now: NOW, withSessions: false });
    expect(r.badLines).toBe(2);
    expect(r.spanCount).toBe(1);
  });

  test("按轮转文件编号排序：traces.2 比 traces.1 旧", () => {
    const dir = mkTelemetry({
      "traces.2.jsonl": [root("t11", "r1")],
      "traces.1.jsonl": [s({ traceId: "t11", spanId: "c1", parentSpanId: "r1" })],
      "traces.jsonl": [s({ traceId: "t11", spanId: "c2", parentSpanId: "r1" })],
    });
    const r = analyze({ telemetryDir: dir, sessionsDir: mkDir(), now: NOW, withSessions: false });
    expect(r.files.map((f) => f.split("/").pop())).toEqual([
      "traces.2.jsonl",
      "traces.1.jsonl",
      "traces.jsonl",
    ]);
    expect(r.criterion2.danglingChildSpans).toBe(0);
  });

  test("--days 过滤掉更早的 trace", () => {
    const old = Date.parse("2026-10-01T10:00:00Z");
    const fresh = Date.parse("2026-11-06T10:00:00Z");
    const dir = mkTelemetry({
      "traces.jsonl": [
        root("old", "r1", "invoke_agent sid-code", old, old + 1_000),
        root("new", "r2", "invoke_agent sid-code", fresh, fresh + 1_000),
      ],
    });
    const r = analyze({
      telemetryDir: dir,
      sessionsDir: mkDir(),
      now: NOW,
      sinceMs: NOW - 7 * 86_400_000,
      withSessions: false,
    });
    expect(r.traceCount).toBe(1);
    expect(r.criterion1.exactlyOneRoot).toBe(1);
  });

  test("未知参数报错，不静默忽略", () => {
    expect(() => parseArgs(["--nope"])).toThrow("未知参数");
    expect(() => parseArgs(["--days"])).toThrow("缺少取值");
    expect(() => parseArgs(["--days", "0"])).toThrow("正数");
  });

  test("formatReport 能渲染完整报告且不发散", () => {
    const dir = mkTelemetry({
      "traces.jsonl": [root("t12", "r1"), s({ traceId: "t12", spanId: "c1", parentSpanId: "r1" })],
    });
    const r = analyze({ telemetryDir: dir, sessionsDir: mkDir(), now: NOW, withSessions: false });
    const text = formatReport(r);
    expect(text).toContain("判据一：每个 trace 恰好一个根");
    expect(text).toContain("判据二：没有找不到的父");
    expect(text).toContain("invoke_agent sid-code");
    expect(() => JSON.stringify(r)).not.toThrow();
  });
});
