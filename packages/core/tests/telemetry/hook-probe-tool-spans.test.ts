/**
 * X1H2 T2 · `execute_tool` span 改为**执行前**开（PreToolUse 建、Post 系列取用）。
 *
 * 改造前的缺陷形态（每条测试都对应一条）：
 * - span 在 PostToolUse 才创建，起点按 duration_ms 倒推 → 父 span 在工具开跑时还不存在，
 *   子代理并发时只能挂到根上，树里是兄弟不是父子；
 * - 权限等待混进 duration_ms → 「秒拒」与「等 30s 才拒」在 trace 上长得一样；
 * - SessionEnd 时没跑完的工具永远不会 end → 整个 trace 缺父（T4 判据②红）。
 *
 * 变异自证方式：把 `handlePreToolUse` 的 `this.toolSpans.set(...)` 注释掉，
 * 「Pre 建 span」组全红；把 `handleSessionEnd` 里收 toolSpans 的循环删掉，abandoned 组红。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TelemetryBus } from "@sid-code/core/telemetry/bus.ts";
import { TelemetryHookProbe } from "@sid-code/core/telemetry/hook-probe.ts";
import { TokenMeter } from "@sid-code/core/telemetry/metrics/token-meter.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { ATTR } from "@sid-code/core/telemetry/types.ts";
import type { SpanData, TelemetryExporter } from "@sid-code/core/telemetry/types.ts";

/** 进程原有值（可能是 preload 设的兜底），afterEach 必须还回去而不是 delete */
const prevConfigDir = process.env.SID_CONFIG_DIR;
let testHome: string;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "sid-tool-spans-"));
  process.env.SID_CONFIG_DIR = testHome;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(testHome, { recursive: true, force: true });
});

function createEnabledBus() {
  const spans: SpanData[] = [];
  const exporter: TelemetryExporter = {
    name: "mock",
    exportSpans: async (batch) => {
      spans.push(...batch);
    },
    shutdown: async () => {},
  };
  const bus = new TelemetryBus({ enabled: true, batchSize: 100, flushIntervalMs: 999999 });
  bus.addExporter(exporter);
  return { bus, spans };
}

describe("X1H2 T2 · execute_tool span 执行前开", () => {
  let bus: TelemetryBus;
  let spans: SpanData[];
  let probe: TelemetryHookProbe;
  let hookSystem: HookSystem;

  beforeEach(() => {
    const result = createEnabledBus();
    bus = result.bus;
    spans = result.spans;
    probe = new TelemetryHookProbe(bus, new TokenMeter(null, () => 0), {
      model: "claude-sonnet-4",
      provider: "anthropic",
      sessionId: "test-session",
    });
    hookSystem = new HookSystem();
    probe.registerHooks(hookSystem);
  });

  async function start() {
    await hookSystem.fireSessionStartEvent("startup", { model: "claude-sonnet-4" });
  }

  async function end() {
    await hookSystem.fireSessionEndEvent("exit", {
      total_cost_usd: 0,
      total_tokens_sent: 0,
      total_tokens_received: 0,
    });
    await bus.flush();
  }

  test("Pre 建 span、Post 复用：无 backfilled 标记，父是会话根", async () => {
    await start();
    await hookSystem.firePreToolUseEvent("read", { file_path: "/x" }, "tu-1");
    // 人为拉开 Pre→Post 间隔：这段是**调度/权限开销**，不属于工具自身 duration_ms。
    // 改造前 span 在 Post 才建、按 duration_ms 倒推 → 时长恒为 12；
    // 改造后起点是 Pre 时刻 → 时长包含这 15ms。这条断言正是两种实现的判据。
    await Bun.sleep(15);
    await hookSystem.firePostToolUseEvent(
      "read",
      { file_path: "/x" },
      { output: "ok" },
      false,
      "tu-1",
      { duration_ms: 12 },
    );
    await end();

    const root = spans.find((s) => s.kind === "invoke_agent")!;
    const tool = spans.find((s) => s.kind === "execute_tool")!;
    expect(tool.attributes["sidcode.tool.span_backfilled"]).toBeUndefined();
    expect(tool.parentSpanId).toBe(root.spanId);
    expect(tool.attributes[ATTR.SUCCESS]).toBe(true);
    expect(tool.attributes["sidcode.tool.duration_ms"]).toBe(12);
    // 起点是 Pre 时刻 → span 时长 ≥ Pre→Post 的 15ms；倒推实现会得到 12。
    expect(tool.durationMs).toBeGreaterThanOrEqual(15);
  });

  test("Pre 失败路径（PostToolUseFailure）同样复用 span，不重复建树", async () => {
    await start();
    await hookSystem.firePreToolUseEvent("bash", { command: "exit 1" }, "tu-fail");
    await hookSystem.firePostToolUseFailureEvent(
      "bash",
      { command: "exit 1" },
      "命令失败",
      "tu-fail",
      { duration_ms: 7, failure_kind: "tool_error" },
    );
    await end();

    const tools = spans.filter((s) => s.kind === "execute_tool");
    expect(tools).toHaveLength(1);
    expect(tools[0].attributes[ATTR.SUCCESS]).toBe(false);
    expect(tools[0].attributes["sidcode.tool.span_backfilled"]).toBeUndefined();
    expect(tools[0].status).toBe("error");
  });

  test("并发两个工具各自成 span，互不串父（parent 都是根，不是彼此）", async () => {
    await start();
    // 交错 fire：Pre A → Pre B → Post B → Post A（真实并发调度的顺序之一）
    await hookSystem.firePreToolUseEvent("read", { file_path: "/a" }, "tu-a");
    await hookSystem.firePreToolUseEvent("bash", { command: "echo b" }, "tu-b");
    await hookSystem.firePostToolUseEvent(
      "bash",
      { command: "echo b" },
      { output: "b" },
      false,
      "tu-b",
      {
        duration_ms: 3,
      },
    );
    await hookSystem.firePostToolUseEvent(
      "read",
      { file_path: "/a" },
      { output: "a" },
      false,
      "tu-a",
      {
        duration_ms: 5,
      },
    );
    await end();

    const root = spans.find((s) => s.kind === "invoke_agent")!;
    const a = spans.find((s) => s.attributes[ATTR.TOOL_CALL_ID] === "tu-a")!;
    const b = spans.find((s) => s.attributes[ATTR.TOOL_CALL_ID] === "tu-b")!;
    expect(a.parentSpanId).toBe(root.spanId);
    expect(b.parentSpanId).toBe(root.spanId);
    expect(a.spanId).not.toBe(b.spanId);
  });

  test("PermissionDenied 复用 Pre span，带 permission_wait_ms（区分秒拒与等很久才拒）", async () => {
    await start();
    await hookSystem.firePreToolUseEvent("bash", { command: "rm x" }, "tu-denied");
    await Bun.sleep(25);
    await hookSystem.firePermissionDeniedEvent(
      "bash",
      { command: "rm x" },
      "本仓库禁止 rm",
      "rule",
      "tu-denied",
    );
    await end();

    const tool = spans.find((s) => s.attributes[ATTR.TOOL_CALL_ID] === "tu-denied")!;
    expect(tool.attributes["sidcode.tool.status"]).toBe("denied");
    expect(tool.attributes["sidcode.tool.permission_wait_ms"]).toBeGreaterThanOrEqual(20);
    expect(tool.attributes["sidcode.tool.span_backfilled"]).toBeUndefined();
  });

  test("SessionEnd 收掉没跑完的工具：标 abandoned，不留在内存里", async () => {
    await start();
    await hookSystem.firePreToolUseEvent("bash", { command: "sleep 999" }, "tu-abandoned");
    // 工具没跑完就结束会话（Ctrl+C / 关终端）
    await end();

    const tool = spans.find((s) => s.attributes[ATTR.TOOL_CALL_ID] === "tu-abandoned")!;
    expect(tool.attributes["sidcode.tool.abandoned"]).toBe(true);
    expect(tool.endTime).toBeGreaterThanOrEqual(tool.startTime);
  });

  test("没有 Pre（旧载荷 / 子代理 spawn 路径）时退回事后补建，标 span_backfilled", async () => {
    await start();
    await hookSystem.firePostToolUseEvent(
      "read",
      { file_path: "/late" },
      { output: "ok" },
      false,
      "tu-late",
      { duration_ms: 9 },
    );
    await end();

    const tool = spans.find((s) => s.attributes[ATTR.TOOL_CALL_ID] === "tu-late")!;
    expect(tool.attributes["sidcode.tool.span_backfilled"]).toBe(true);
  });

  test("SubagentStart 挂到 execute_tool sub_agent 下（不是根）", async () => {
    await start();
    await hookSystem.firePreToolUseEvent("sub_agent", { prompt: "do it" }, "tu-sub");
    await hookSystem.fireSubagentStartEvent("agent-1", "general-purpose", undefined, {
      parentToolUseId: "tu-sub",
    });
    await hookSystem.fireSubagentStopEvent({ agent_id: "agent-1", success: true });
    await hookSystem.firePostToolUseEvent(
      "sub_agent",
      { prompt: "do it" },
      { output: "done" },
      false,
      "tu-sub",
      { duration_ms: 30 },
    );
    await end();

    const tool = spans.find((s) => s.attributes[ATTR.TOOL_CALL_ID] === "tu-sub")!;
    const sub = spans.find((s) => s.name.includes("invoke_agent general-purpose"))!;
    expect(sub.parentSpanId).toBe(tool.spanId);
    expect(sub.attributes["sidcode.subagent.parent_tool_use_id"]).toBe("tu-sub");
  });
});
