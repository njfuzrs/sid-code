/**
 * 会话根 span 启动期重建（三方对比差距清单 §三 P0-2 · PR3）
 *
 * ## 这个 PR 要证明什么
 *
 * 缺陷：根 `invoke_agent` span 只在 `handleSessionEnd` 里 `end()` 入队，而实测
 * `SessionStart 50 : SessionEnd 23` —— **54% 的会话没有 SessionEnd**。会话级根节点
 * 在最不可靠的时刻才落盘，而可观测性最需要看的恰好是没正常结束的那些会话。
 *
 * 验收判据（doc §PR3）：**`kill -9` 一个会话后，根 span 仍在，且 PR2 的三条断言全过。**
 * 所以本文件不只断言「重建出了一个 span」，而是把 PR2 的三条结构性判据
 * （每棵树恰好一个根 / 无悬空父 / kind 嵌套合法）搬过来，对着「崩溃会话 +
 * 下次启动重建」的完整数据跑一遍 —— 只验前者会重演本文两次栽过的坑：
 * 「根 span 数 != 0」这种判据在树依然不成形时也显示 PASS。
 *
 * ## 为什么必须沿用原 traceId / spanId（本 PR 的实现要点）
 *
 * `events.jsonl` 里**没有任何 span 身份**。而子 span（chat / execute_tool）在运行时
 * 已经把运行时那个根的 spanId 写成自己的 `parentSpanId` 落盘了 —— 实测
 * `traces.jsonl` 里 680 个 `parentSpanId` 解析不到父就是这么来的。
 *
 * 所以「只从 events 重建、给根一个新 spanId」这个看似自然的做法是**无效修复**：
 * 孤儿子 span 照旧悬空，盘上再多一个谁也不挂的根，判据①②依然全红。
 * 下面 `describe("反例")` 那组把这件事固化成可执行的反例，而不是只写在注释里。
 *
 * ## 落盘隔离
 *
 * 标记落在 `~/.sid-code/telemetry/pending-root-spans/`，events 素材读
 * `trajectories/sessions/`，两者都靠 `SID_CONFIG_DIR` 重定向到 tmpdir。
 * afterEach **存/恢复原值**而非 delete（同进程跑多文件，delete 会抹掉 preload 兜底）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { TelemetryBus } from "@sid-code/core/telemetry/bus.ts";
import { TelemetryHookProbe } from "@sid-code/core/telemetry/hook-probe.ts";
import { TokenMeter } from "@sid-code/core/telemetry/metrics/token-meter.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import {
  clearPendingRootSpan,
  pendingRootSpanDir,
  pendingRootSpanPath,
  rebuildRootSpanFromEvents,
  recoverPendingRootSpans,
  writePendingRootSpan,
  type PendingRootSpanMarker,
} from "@sid-code/core/telemetry/root-span-recovery.ts";
import { ATTR } from "@sid-code/core/telemetry/types.ts";
import type { SpanData, TelemetryExporter } from "@sid-code/core/telemetry/types.ts";

const prevConfigDir = process.env.SID_CONFIG_DIR;
let testHome: string;

/** 一个不可能存在的 pid（存活判定必须判成"已死"，否则重建会被跳过） */
const DEAD_PID = 2_147_483_600;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "sid-root-span-recovery-"));
  process.env.SID_CONFIG_DIR = testHome;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(testHome, { recursive: true, force: true });
});

// ============================================================
// 判据检查器：与 PR2（span-tree-shape.test.ts）同口径，刻意不去重
// ============================================================

/** ① 每棵树恰好一个根 —— 按 traceId 分组数根，不做任何 sort -u */
function findRootCountViolations(spans: readonly SpanData[]): string[] {
  const rootsByTrace = new Map<string, SpanData[]>();
  const traces = new Set<string>();
  for (const s of spans) {
    traces.add(s.traceId);
    if (s.parentSpanId === undefined) {
      const list = rootsByTrace.get(s.traceId) ?? [];
      list.push(s);
      rootsByTrace.set(s.traceId, list);
    }
  }
  const violations: string[] = [];
  for (const t of traces) {
    const roots = rootsByTrace.get(t) ?? [];
    if (roots.length !== 1) violations.push(`trace ${t} 有 ${roots.length} 个根（期望 1）`);
  }
  return violations;
}

/** ② 无悬空父 —— 每个 parentSpanId 都能在同批数据里解析到、且父子同 trace */
function findDanglingParentViolations(spans: readonly SpanData[]): string[] {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const violations: string[] = [];
  for (const s of spans) {
    if (s.parentSpanId === undefined) continue;
    const parent = byId.get(s.parentSpanId);
    if (!parent) {
      violations.push(`${s.kind}/${s.name} 的父 ${s.parentSpanId} 悬空`);
    } else if (parent.traceId !== s.traceId) {
      violations.push(`${s.kind}/${s.name} 的父在另一条 trace`);
    }
  }
  return violations;
}

/** ③ kind 嵌套合法性 + 子起点落在父的 [start, end] 闭区间内 */
function findNestingViolations(spans: readonly SpanData[]): string[] {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const violations: string[] = [];
  for (const s of spans) {
    if (s.parentSpanId === undefined) continue;
    const parent = byId.get(s.parentSpanId);
    if (!parent) continue; // 悬空由 ② 报
    if (parent.kind === "chat" && s.kind === "chat") {
      violations.push(`非法嵌套：chat 不能是 chat 的父（${s.name}）`);
    }
    if (s.startTime < parent.startTime || s.startTime > parent.endTime) {
      violations.push(
        `时间错位：${s.kind}/${s.name} 起于 ${s.startTime}，` +
          `不在父的 [${parent.startTime}, ${parent.endTime}] 内`,
      );
    }
  }
  return violations;
}

function findSpanTreeViolations(spans: readonly SpanData[]): string[] {
  return [
    ...findRootCountViolations(spans),
    ...findDanglingParentViolations(spans),
    ...findNestingViolations(spans),
  ];
}

// ============================================================
// 生产路径夹具
// ============================================================

function createEnabledBus() {
  const spans: SpanData[] = [];
  const exporter: TelemetryExporter = {
    name: "mock",
    exportSpans: async (batch) => {
      spans.push(...batch);
    },
    shutdown: async () => {},
  };
  const bus = new TelemetryBus({ enabled: true, batchSize: 1000, flushIntervalMs: 999_999 });
  bus.addExporter(exporter);
  return { bus, spans };
}

function createProbe(bus: TelemetryBus, sessionId: string, model = "glm-5.3") {
  return new TelemetryHookProbe(bus, new TokenMeter(null, () => 0), {
    model,
    provider: "zhipu",
    sessionId,
  });
}

/** 会话目录（与 collector 的 `trajectories/sessions/<id>/` 布局一致） */
function sessionDirOf(sessionId: string): string {
  return join(testHome, "trajectories", "sessions", sessionId);
}

/**
 * 把会话目录 mtime 推到 `ms`，模拟心跳最后一次覆写 `heartbeat.txt`。
 *
 * 验收用例需要它：合成的 events 时间戳与**真实跑出来的 span** 时间戳来自两个时钟
 * （前者是 fixture 里的常量，后者是 `Date.now()`），不对齐就会造出「父区间早于子」
 * 这种生产里不存在的形态。生产里心跳每 10s 覆写一次，所以目录 mtime 天然晚于
 * 最后一个子 span —— 这里就是把 fixture 对齐到那个事实。
 */
function pinSessionDirMtime(sessionId: string, ms: number): void {
  const d = new Date(ms);
  utimesSync(sessionDirOf(sessionId), d, d);
}

/** 造一份 events.jsonl。`turns` 条 BeforeModel/AfterModelRaw 对 + 可选 SessionEnd。 */
function writeEvents(
  sessionId: string,
  opts: {
    turns: number;
    model?: string;
    startMs: number;
    stepMs?: number;
    sessionEnd?: { exitStatus: string; reason?: string };
    crash?: { errorMessage: string };
  },
): void {
  const dir = sessionDirOf(sessionId);
  mkdirSync(dir, { recursive: true });
  const model = opts.model ?? "glm-5.3";
  const step = opts.stepMs ?? 1000;
  const lines: string[] = [];
  const at = (i: number) => new Date(opts.startMs + i * step).toISOString();

  lines.push(
    JSON.stringify({
      event: "SessionStart",
      session_id: sessionId,
      timestamp: at(0),
      data: { source: "startup", model },
    }),
  );
  for (let i = 0; i < opts.turns; i++) {
    lines.push(
      JSON.stringify({
        event: "BeforeModel",
        session_id: sessionId,
        timestamp: at(1 + i * 2),
        data: { index: i + 1, model },
      }),
    );
    lines.push(
      JSON.stringify({
        event: "AfterModelRaw",
        session_id: sessionId,
        timestamp: at(2 + i * 2),
        data: {
          index: i + 1,
          model,
          usage: { input_tokens: 1000, output_tokens: 200, cache_read: 500, cache_creation: 0 },
        },
      }),
    );
  }
  if (opts.sessionEnd) {
    lines.push(
      JSON.stringify({
        event: "SessionEnd",
        session_id: sessionId,
        timestamp: at(1 + opts.turns * 2),
        data: { reason: opts.sessionEnd.reason ?? "exit", exit_status: opts.sessionEnd.exitStatus },
      }),
    );
  }
  writeFileSync(join(dir, "events.jsonl"), lines.join("\n") + "\n");

  // 把目录 mtime 对齐到末条事件时间。
  //
  // 不这么做的话目录 mtime 是「测试运行的真实当下」（2026 年），而 fixture 用的是
  // 2023 年的合成时间戳 —— endTime 取最大值时会恒定选中目录 mtime，别的候选一条也测不到。
  // 生产里两者本来就同量级（心跳每 10s 覆写 heartbeat.txt，即目录 mtime ≈ 会话终点），
  // 所以这是让 fixture 贴近生产，不是为了迁就断言。
  const lastMs = opts.sessionEnd
    ? opts.startMs + (1 + opts.turns * 2) * step
    : opts.startMs + (opts.turns > 0 ? 2 + (opts.turns - 1) * 2 : 0) * step;
  const lastDate = new Date(lastMs);
  utimesSync(dir, lastDate, lastDate);

  if (opts.crash) {
    writeFileSync(
      join(dir, "crash.json"),
      JSON.stringify({
        session_id: sessionId,
        timestamp: at(opts.turns * 2 + 1),
        error_message: opts.crash.errorMessage,
        error_name: "Error",
        last_api_call_index: opts.turns,
        last_model: model,
        memory_mb: 100,
        uptime_seconds: 10,
      }),
    );
  }
}

/**
 * 模拟 `kill -9`：跑一个真实会话到中途（有子 span 落盘），**不 fire SessionEnd**，
 * 再把标记的 pid 改成一个死 pid（真实场景里进程已经不在了）。
 *
 * 返回运行时已落盘的 span 与该会话的标记路径。
 */
async function runCrashedSession(
  sessionId: string,
  opts?: { model?: string },
): Promise<{ spans: SpanData[]; bus: TelemetryBus; markerPath: string }> {
  const model = opts?.model ?? "glm-5.3";
  const { bus, spans } = createEnabledBus();
  const probe = createProbe(bus, sessionId, model);
  const hookSystem = new HookSystem();
  probe.registerHooks(hookSystem);

  await hookSystem.fireSessionStartEvent("startup", { model });
  // 两轮 chat + 一次工具：这些子 span 会正常入队，parentSpanId 指向运行时的根
  for (const _ of [0, 1]) {
    const request = { model, messages: [{ role: "user", content: "hi" }] };
    await hookSystem.fireBeforeModelEvent(request);
    await hookSystem.fireAfterModelEvent(request, {
      text: "ok",
      usage: { inputTokens: 1000, outputTokens: 200 },
      stop_reason: "end_turn",
      cost_usd: 0.001,
    });
  }
  await hookSystem.firePostToolUseEvent(
    "read",
    { file_path: "/tmp/a" },
    { output: "x" },
    false,
    "t1",
    {
      duration_ms: 5,
    },
  );
  // ★ 刻意不 fire SessionEnd —— 这就是 kill -9 / OOM 的形态
  await bus.flush();

  // 把 pid 改成死 pid：真实崩溃场景下写标记的那个进程已经不存在了
  const markerPath = pendingRootSpanPath(sessionId);
  const marker = JSON.parse(await Bun.file(markerPath).text()) as PendingRootSpanMarker;
  marker.pid = DEAD_PID;
  writeFileSync(markerPath, JSON.stringify(marker));

  return { spans, bus, markerPath };
}

// ============================================================
describe("标记的写入与清除（正常路径零残留）", () => {
  test("SessionStart 落标记，内容含身份且与运行时根 span 一致", async () => {
    const { bus, spans } = createEnabledBus();
    const probe = createProbe(bus, "sess-marker");
    const hookSystem = new HookSystem();
    probe.registerHooks(hookSystem);

    await hookSystem.fireSessionStartEvent("startup", { model: "glm-5.3" });

    const marker = JSON.parse(
      await Bun.file(pendingRootSpanPath("sess-marker")).text(),
    ) as PendingRootSpanMarker;
    expect(marker.session_id).toBe("sess-marker");
    expect(marker.name).toBe("invoke_agent glm-5.3");
    expect(marker.pid).toBe(process.pid);
    expect(marker.attributes[ATTR.AGENT_NAME]).toBe("sid-code");

    // 身份必须与运行时那个根**完全一致** —— 这是整个 PR 能把孤儿接回树的前提
    await hookSystem.fireSessionEndEvent("exit", { total_cost_usd: 0 });
    await bus.flush();
    const root = spans.find((s) => s.parentSpanId === undefined)!;
    expect(marker.trace_id).toBe(root.traceId);
    expect(marker.span_id).toBe(root.spanId);
  });

  test("SessionEnd 正常触发 → 标记被删（正常会话不留残留、下次启动不重复落盘）", async () => {
    const { bus } = createEnabledBus();
    const probe = createProbe(bus, "sess-clean");
    const hookSystem = new HookSystem();
    probe.registerHooks(hookSystem);

    await hookSystem.fireSessionStartEvent("startup", { model: "glm-5.3" });
    expect(existsSync(pendingRootSpanPath("sess-clean"))).toBe(true);

    await hookSystem.fireSessionEndEvent("exit", { total_cost_usd: 0.01 });
    expect(existsSync(pendingRootSpanPath("sess-clean"))).toBe(false);
  });

  test("resume 会话用 resumed_from 作 key（与 collector 的轨迹目录名同口径）", async () => {
    const { bus } = createEnabledBus();
    // 进程 id 是新的，轨迹目录名是旧的 —— 标记必须按**旧的**落，否则重建时找不到 events
    const probe = createProbe(bus, "new-process-id");
    const hookSystem = new HookSystem();
    probe.registerHooks(hookSystem);

    await hookSystem.fireSessionStartEvent("resume", {
      model: "glm-5.3",
      resumedFrom: "old-traj-id",
    });

    expect(existsSync(pendingRootSpanPath("old-traj-id"))).toBe(true);
    expect(existsSync(pendingRootSpanPath("new-process-id"))).toBe(false);

    // 删除也必须用同一个 key，否则正常收尾的 resume 会话会残留标记
    await hookSystem.fireSessionEndEvent("exit", { total_cost_usd: 0 });
    expect(existsSync(pendingRootSpanPath("old-traj-id"))).toBe(false);
  });

  test("clearPendingRootSpan 对不存在的标记幂等（不抛）", () => {
    expect(() => clearPendingRootSpan("never-existed")).not.toThrow();
  });

  test("session id 里的路径穿越被白名单化（不会写出标记目录之外）", () => {
    writePendingRootSpan({
      session_id: "../../evil",
      trace_id: "t",
      span_id: "s",
      name: "invoke_agent x",
      start_time: 1,
      attributes: {},
      pid: DEAD_PID,
    });
    // 只应在标记目录里出现一个被改名后的文件，不该在上层目录留下任何东西。
    // 白名单保留 `.`（正常 session id 不含点，但保留它更宽容），所以 `../../evil`
    // 变成 `.._.._evil` —— 分隔符没了，就出不去目录，这才是判据本身。
    const files = readdirSync(pendingRootSpanDir());
    expect(files).toEqual([".._.._evil.json"]);
    expect(existsSync(join(testHome, "evil.json"))).toBe(false);
    // 判据锁「解析后仍在目录内」，而不是只锁那个具体的替换结果：
    // 将来若改了替换字符，这条依然拦得住真正的危害。
    const resolved = resolve(pendingRootSpanPath("../../evil"));
    expect(resolved.startsWith(resolve(pendingRootSpanDir()) + sep)).toBe(true);
  });
});

// ============================================================
describe("据 events.jsonl 重建根 span", () => {
  test("沿用原 traceId / spanId，且 parentSpanId 为空", () => {
    writeEvents("sess-a", { turns: 3, startMs: 1_700_000_000_000 });
    const span = rebuildRootSpanFromEvents(
      {
        session_id: "sess-a",
        trace_id: "trace-xyz",
        span_id: "span-root",
        name: "invoke_agent glm-5.3",
        start_time: 1_700_000_000_000,
        attributes: { [ATTR.AGENT_NAME]: "sid-code" },
        pid: DEAD_PID,
      },
      { sessionsRoot: join(testHome, "trajectories", "sessions") },
    );

    expect(span.traceId).toBe("trace-xyz");
    expect(span.spanId).toBe("span-root");
    expect(span.parentSpanId).toBeUndefined();
    expect(span.kind).toBe("invoke_agent");
    expect(span.attributes[ATTR.AGENT_NAME]).toBe("sid-code");
  });

  test("轮次取 BeforeModel 计数（与运行时 probe.turns 同口径）", () => {
    writeEvents("sess-turns", { turns: 5, startMs: 1_700_000_000_000 });
    const span = rebuildRootSpanFromEvents(
      {
        session_id: "sess-turns",
        trace_id: "t",
        span_id: "s",
        name: "invoke_agent glm-5.3",
        start_time: 1_700_000_000_000,
        attributes: {},
        pid: DEAD_PID,
      },
      { sessionsRoot: join(testHome, "trajectories", "sessions") },
    );
    expect(span.attributes[ATTR.TOTAL_TURNS]).toBe(5);
  });

  test("token 用累积口径（flow），与 cost 可比 —— 不是末次快照", () => {
    // 3 轮，每轮 input 1000 / output 200 → 累积 3000 / 600（末次快照会是 1000）
    writeEvents("sess-tok", { turns: 3, startMs: 1_700_000_000_000 });
    const span = rebuildRootSpanFromEvents(
      {
        session_id: "sess-tok",
        trace_id: "t",
        span_id: "s",
        name: "invoke_agent glm-5.3",
        start_time: 1_700_000_000_000,
        attributes: {},
        pid: DEAD_PID,
      },
      { sessionsRoot: join(testHome, "trajectories", "sessions") },
    );
    expect(span.attributes[ATTR.INPUT_TOKENS]).toBe(3000);
    expect(span.attributes[ATTR.OUTPUT_TOKENS]).toBe(600);
  });

  /**
   * endTime 取**四个候选的最大值**，不是「优先级取第一个可用的」。
   *
   * 这条是实测逼出来的，值得写清楚：endTime 同时是 PR2 判据③的父区间上界
   * （子 span 的 startTime 必须落在父的 `[startTime, endTime]` 内），而子 span 在崩溃前
   * 就已经 flush 走了、重建时看不到。所以估偏早的直接后果不是「时长不准」，
   * 而是**判据③报时间错位** —— 根回来了，树还是不成形。
   *
   * 下面用 `markerMtimeMs` 造出「候选之间互相更大」的局面来锁死这个语义：
   * 优先级实现会取 events 的时间，最大值实现会取更晚的那个。
   */
  test("endTime 取候选最大值（不是优先级取第一个），并标明用了哪一级", () => {
    const base = 1_700_000_000_000;
    const sessionsRoot = join(testHome, "trajectories", "sessions");
    const mk = (sid: string) => ({
      session_id: sid,
      trace_id: "t",
      span_id: "s",
      name: "invoke_agent glm-5.3",
      start_time: base,
      attributes: {},
      pid: DEAD_PID,
    });

    // ① SessionEnd 事件是最晚的候选 → 取它
    writeEvents("sess-e1", { turns: 2, startMs: base, sessionEnd: { exitStatus: "end_turn" } });
    const withEnd = rebuildRootSpanFromEvents(mk("sess-e1"), {
      sessionsRoot,
      markerMtimeMs: base + 1, // 刻意比 events 早，证明它没被优先级挑走
    });
    expect(withEnd.attributes["sidcode.root_span.end_time_source"]).toBe("session_end_event");
    expect(withEnd.endTime).toBe(base + 5000); // at(1 + 2*2) = at(5)

    // ② 无 SessionEnd，末条事件最晚 → 取末条事件
    writeEvents("sess-e2", { turns: 2, startMs: base });
    const lastEvent = rebuildRootSpanFromEvents(mk("sess-e2"), {
      sessionsRoot,
      markerMtimeMs: base + 1,
    });
    expect(lastEvent.attributes["sidcode.root_span.end_time_source"]).toBe("last_event");
    expect(lastEvent.endTime).toBe(base + 4000); // at(2 + 1*2) = at(4)

    // ③ ★ 标记 mtime 比 events 里所有时间都晚 → 必须取 mtime。
    //    优先级实现在这里会取 events（偏早），从而让判据③在真实数据上报红。
    writeEvents("sess-e3", { turns: 2, startMs: base, sessionEnd: { exitStatus: "end_turn" } });
    const laterMarker = rebuildRootSpanFromEvents(mk("sess-e3"), {
      sessionsRoot,
      markerMtimeMs: base + 60_000,
    });
    expect(laterMarker.endTime).toBe(base + 60_000);
    expect(laterMarker.attributes["sidcode.root_span.end_time_source"]).toBe("marker_mtime");

    // ④ 连 events.jsonl 都没有 → 退到标记 mtime
    const noEvents = rebuildRootSpanFromEvents(mk("sess-e4-missing"), {
      sessionsRoot,
      markerMtimeMs: base + 9999,
    });
    expect(noEvents.attributes["sidcode.root_span.end_time_source"]).toBe("marker_mtime");
    expect(noEvents.endTime).toBe(base + 9999);
  });

  test("会话目录 mtime 参与取数（复用心跳，覆盖「最后只跑工具、不产 events 行」）", () => {
    const base = 1_700_000_000_000;
    writeEvents("sess-hb", { turns: 1, startMs: base });
    // 心跳每 10s 覆写 heartbeat.txt，所以目录 mtime 比末条 events 行更贴近真实终点
    const dir = sessionDirOf("sess-hb");
    const later = new Date(base + 120_000);
    utimesSync(dir, later, later);

    const span = rebuildRootSpanFromEvents(
      {
        session_id: "sess-hb",
        trace_id: "t",
        span_id: "s",
        name: "invoke_agent glm-5.3",
        start_time: base,
        attributes: {},
        pid: DEAD_PID,
      },
      { sessionsRoot: join(testHome, "trajectories", "sessions") },
    );
    expect(span.attributes["sidcode.root_span.end_time_source"]).toBe("session_dir_mtime");
    expect(span.endTime).toBe(base + 120_000);
  });

  test("endTime 绝不早于 startTime（时钟回拨兜底）", () => {
    const base = 1_700_000_000_000;
    // events 的时间戳全都早于标记的 start_time
    writeEvents("sess-back", { turns: 1, startMs: base - 600_000 });
    const dir = sessionDirOf("sess-back");
    const early = new Date(base - 600_000);
    utimesSync(dir, early, early);

    const span = rebuildRootSpanFromEvents(
      {
        session_id: "sess-back",
        trace_id: "t",
        span_id: "s",
        name: "invoke_agent glm-5.3",
        start_time: base,
        attributes: {},
        pid: DEAD_PID,
      },
      { sessionsRoot: join(testHome, "trajectories", "sessions"), markerMtimeMs: base - 1000 },
    );
    expect(span.endTime).toBe(base);
    expect(span.durationMs).toBe(0);
  });

  test("exit_status 未知时兜成 interrupted，不谎报 end_turn", () => {
    writeEvents("sess-unknown", { turns: 1, startMs: 1_700_000_000_000 });
    const span = rebuildRootSpanFromEvents(
      {
        session_id: "sess-unknown",
        trace_id: "t",
        span_id: "s",
        name: "invoke_agent glm-5.3",
        start_time: 1_700_000_000_000,
        attributes: {},
        pid: DEAD_PID,
      },
      { sessionsRoot: join(testHome, "trajectories", "sessions") },
    );
    expect(span.attributes["sidcode.session.exit_status"]).toBe("interrupted");
    expect(span.attributes["sidcode.session.exit_status"]).not.toBe("end_turn");
  });

  test("重建出的 span 自带 recovered 标记（消费方必须能与运行时落的根区分）", () => {
    writeEvents("sess-flag", { turns: 1, startMs: 1_700_000_000_000 });
    const span = rebuildRootSpanFromEvents(
      {
        session_id: "sess-flag",
        trace_id: "t",
        span_id: "s",
        name: "invoke_agent glm-5.3",
        start_time: 1_700_000_000_000,
        attributes: {},
        pid: DEAD_PID,
      },
      { sessionsRoot: join(testHome, "trajectories", "sessions") },
    );
    expect(span.attributes["sidcode.root_span.recovered"]).toBe(true);
  });

  test("真崩溃 → status=error + exit_attribution=crash", () => {
    writeEvents("sess-crash", {
      turns: 2,
      startMs: 1_700_000_000_000,
      crash: { errorMessage: "Cannot read properties of undefined" },
    });
    const span = rebuildRootSpanFromEvents(
      {
        session_id: "sess-crash",
        trace_id: "t",
        span_id: "s",
        name: "invoke_agent glm-5.3",
        start_time: 1_700_000_000_000,
        attributes: {},
        pid: DEAD_PID,
      },
      { sessionsRoot: join(testHome, "trajectories", "sessions") },
    );
    expect(span.status).toBe("error");
    expect(span.attributes["sidcode.root_span.exit_attribution"]).toBe("crash");
    expect(span.attributes["sidcode.session.exit_status"]).toBe("error");
  });

  test("用户关终端的 EIO 不算崩溃（复用 crash-marker 的判据，不另写一份）", () => {
    // P2-14：关终端 → tty 消失 → Ink 卸载写 fd 1 拿到 EIO → uncaughtException。
    // 整条链没有一处是本体故障，标成 error 会让「崩溃率」里混进「用户正常关窗口」。
    writeEvents("sess-eio", {
      turns: 1,
      startMs: 1_700_000_000_000,
      crash: { errorMessage: "EIO: i/o error, write" },
    });
    const span = rebuildRootSpanFromEvents(
      {
        session_id: "sess-eio",
        trace_id: "t",
        span_id: "s",
        name: "invoke_agent glm-5.3",
        start_time: 1_700_000_000_000,
        attributes: {},
        pid: DEAD_PID,
      },
      { sessionsRoot: join(testHome, "trajectories", "sessions") },
    );
    expect(span.status).toBe("ok");
    expect(span.attributes["sidcode.root_span.exit_attribution"]).toBe("terminal_death");
  });

  test("events.jsonl 有损坏行（崩溃瞬间的半行）仍能重建", () => {
    writeEvents("sess-broken", { turns: 2, startMs: 1_700_000_000_000 });
    const p = join(sessionDirOf("sess-broken"), "events.jsonl");
    // append 语义在崩溃瞬间可能留半行 —— 这是真实形态，不是构造的极端情况
    appendFileSync(p, '{"event":"AfterModelRaw","data":{"usa');
    const span = rebuildRootSpanFromEvents(
      {
        session_id: "sess-broken",
        trace_id: "t",
        span_id: "s",
        name: "invoke_agent glm-5.3",
        start_time: 1_700_000_000_000,
        attributes: {},
        pid: DEAD_PID,
      },
      { sessionsRoot: join(testHome, "trajectories", "sessions") },
    );
    expect(span.attributes[ATTR.TOTAL_TURNS]).toBe(2);
  });
});

// ============================================================
describe("启动期扫描（recoverPendingRootSpans）", () => {
  const sessionsRoot = () => join(testHome, "trajectories", "sessions");

  test("死进程的标记被重建并入队，标记随后删除（幂等：再扫一次不重复）", () => {
    writeEvents("sess-dead", { turns: 2, startMs: 1_700_000_000_000 });
    writePendingRootSpan({
      session_id: "sess-dead",
      trace_id: "t-dead",
      span_id: "s-dead",
      name: "invoke_agent glm-5.3",
      start_time: 1_700_000_000_000,
      attributes: { [ATTR.AGENT_NAME]: "sid-code" },
      pid: DEAD_PID,
    });

    const enqueued: SpanData[] = [];
    const r = recoverPendingRootSpans({
      enqueue: (s) => enqueued.push(s),
      sessionsRoot: sessionsRoot(),
      isProcessAlive: () => false,
    });

    expect(r.recovered).toBe(1);
    expect(enqueued[0]!.spanId).toBe("s-dead");
    expect(existsSync(pendingRootSpanPath("sess-dead"))).toBe(false);

    // 幂等：标记已删，第二次扫描什么都不做（否则每次启动都多一个重复的根）
    const again = recoverPendingRootSpans({
      enqueue: (s) => enqueued.push(s),
      sessionsRoot: sessionsRoot(),
      isProcessAlive: () => false,
    });
    expect(again.recovered).toBe(0);
    expect(enqueued.length).toBe(1);
  });

  test("进程仍存活的标记被跳过（不抢正在跑的会话，多开终端是常态）", () => {
    writeEvents("sess-alive", { turns: 1, startMs: 1_700_000_000_000 });
    writePendingRootSpan({
      session_id: "sess-alive",
      trace_id: "t",
      span_id: "s",
      name: "invoke_agent glm-5.3",
      start_time: 1_700_000_000_000,
      attributes: {},
      pid: 999_999,
    });

    const enqueued: SpanData[] = [];
    const r = recoverPendingRootSpans({
      enqueue: (s) => enqueued.push(s),
      sessionsRoot: sessionsRoot(),
      isProcessAlive: () => true,
    });

    expect(r.recovered).toBe(0);
    expect(r.skippedAlive).toBe(1);
    // 标记必须留着 —— 那个会话自己会落根 span，或者它崩了下次再重建
    expect(existsSync(pendingRootSpanPath("sess-alive"))).toBe(true);
  });

  test("本进程自己的标记被跳过（会话还在跑）", () => {
    writeEvents("sess-self", { turns: 1, startMs: 1_700_000_000_000 });
    writePendingRootSpan({
      session_id: "sess-self",
      trace_id: "t",
      span_id: "s",
      name: "invoke_agent glm-5.3",
      start_time: 1_700_000_000_000,
      attributes: {},
      pid: process.pid,
    });

    const enqueued: SpanData[] = [];
    const r = recoverPendingRootSpans({
      enqueue: (s) => enqueued.push(s),
      sessionsRoot: sessionsRoot(),
      // 存活判定刻意返回 false：要证明跳过靠的是 pid == selfPid 这一条，
      // 而不是碰巧被存活判定挡住了
      isProcessAlive: () => false,
    });
    expect(r.recovered).toBe(0);
    expect(existsSync(pendingRootSpanPath("sess-self"))).toBe(true);
  });

  test("缺身份的坏标记被清掉，不阻塞其余标记", () => {
    mkdirSync(pendingRootSpanDir(), { recursive: true });
    writeFileSync(join(pendingRootSpanDir(), "bad.json"), JSON.stringify({ session_id: "x" }));
    writeEvents("sess-ok", { turns: 1, startMs: 1_700_000_000_000 });
    writePendingRootSpan({
      session_id: "sess-ok",
      trace_id: "t",
      span_id: "s",
      name: "invoke_agent glm-5.3",
      start_time: 1_700_000_000_000,
      attributes: {},
      pid: DEAD_PID,
    });

    const enqueued: SpanData[] = [];
    const r = recoverPendingRootSpans({
      enqueue: (s) => enqueued.push(s),
      sessionsRoot: sessionsRoot(),
      isProcessAlive: () => false,
    });
    expect(r.pruned).toBe(1);
    expect(r.recovered).toBe(1);
  });

  test("标记目录不存在时安全返回零结果（首次启动）", () => {
    const r = recoverPendingRootSpans({ enqueue: () => {}, sessionsRoot: sessionsRoot() });
    expect(r).toEqual({ recovered: 0, skippedAlive: 0, pruned: 0 });
  });

  test("会话没有 events.jsonl 也照样重建（一个根总比整棵树没栈底好）", () => {
    writePendingRootSpan({
      session_id: "sess-no-events",
      trace_id: "t",
      span_id: "s",
      name: "invoke_agent glm-5.3",
      start_time: 1_700_000_000_000,
      attributes: {},
      pid: DEAD_PID,
    });
    const enqueued: SpanData[] = [];
    const r = recoverPendingRootSpans({
      enqueue: (s) => enqueued.push(s),
      sessionsRoot: sessionsRoot(),
      isProcessAlive: () => false,
    });
    expect(r.recovered).toBe(1);
    expect(enqueued[0]!.attributes[ATTR.TOTAL_TURNS]).toBe(0);
  });
});

// ============================================================
// 验收判据：kill -9 之后根 span 仍在，且 PR2 的三条断言全过
// ============================================================
describe("验收：kill -9 的会话经重建后满足 PR2 的三条判据", () => {
  test("崩溃时孤儿子 span 悬空 → 重建后整棵树成形", async () => {
    const { spans } = await runCrashedSession("sess-killed");

    // ── 修复前的现状：子 span 全部悬空，一个根都没有 ──
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.filter((s) => s.parentSpanId === undefined).length).toBe(0);
    const before = findSpanTreeViolations(spans);
    expect(before.length).toBeGreaterThan(0);
    expect(before.some((v) => v.includes("有 0 个根"))).toBe(true);
    expect(before.some((v) => v.includes("悬空"))).toBe(true);

    // ── 下次启动：扫描标记重建 ──
    // events.jsonl 由 collector 写，本测试只跑了 probe，所以补一份等价素材。
    // 时间窗必须覆盖已落盘子 span 的 startTime，否则判据③会报时间错位 ——
    // 这也正是真实场景的形态（events 与 span 来自同一次会话）。
    const childMin = Math.min(...spans.map((s) => s.startTime));
    const childMax = Math.max(...spans.map((s) => s.endTime));
    writeEvents("sess-killed", { turns: 2, startMs: childMin - 1000, stepMs: 1 });
    pinSessionDirMtime("sess-killed", childMax + 500);

    const recovered: SpanData[] = [];
    const r = recoverPendingRootSpans({
      enqueue: (s) => recovered.push(s),
      sessionsRoot: join(testHome, "trajectories", "sessions"),
      isProcessAlive: () => false,
    });
    expect(r.recovered).toBe(1);

    // ── 判据全过：这是本 PR 的验收口径 ──
    const all = [...spans, ...recovered];
    expect(findSpanTreeViolations(all)).toEqual([]);

    // 锁语义不锁计数：根必须是**会话级** invoke_agent（子代理的 agent.name 不是 sid-code）
    const roots = all.filter((s) => s.parentSpanId === undefined);
    expect(roots.length).toBe(1);
    expect(roots[0]!.kind).toBe("invoke_agent");
    expect(roots[0]!.attributes[ATTR.AGENT_NAME]).toBe("sid-code");
    expect(roots[0]!.name).toBe("invoke_agent glm-5.3");

    // 每个子 span 都能一路走到根（langfuse 式 orphan check）
    const byId = new Map(all.map((s) => [s.spanId, s]));
    for (const s of all) {
      let cursor: SpanData | undefined = s;
      let hops = 0;
      while (cursor?.parentSpanId !== undefined) {
        cursor = byId.get(cursor.parentSpanId);
        expect(cursor).toBeDefined();
        expect(++hops).toBeLessThan(all.length + 1);
      }
    }
  });

  test("多个崩溃会话各自成一棵树，不串门", async () => {
    const a = await runCrashedSession("sess-k1");
    const b = await runCrashedSession("sess-k2");

    const both = [...a.spans, ...b.spans];
    const childMin = Math.min(...both.map((s) => s.startTime));
    const childMax = Math.max(...both.map((s) => s.endTime));
    for (const sid of ["sess-k1", "sess-k2"]) {
      writeEvents(sid, { turns: 2, startMs: childMin - 1000, stepMs: 1 });
      pinSessionDirMtime(sid, childMax + 500);
    }

    const recovered: SpanData[] = [];
    const r = recoverPendingRootSpans({
      enqueue: (s) => recovered.push(s),
      sessionsRoot: join(testHome, "trajectories", "sessions"),
      isProcessAlive: () => false,
    });
    expect(r.recovered).toBe(2);

    const all = [...a.spans, ...b.spans, ...recovered];
    expect(new Set(all.map((s) => s.traceId)).size).toBe(2);
    expect(all.filter((s) => s.parentSpanId === undefined).length).toBe(2);
    expect(findSpanTreeViolations(all)).toEqual([]);
  });
});

// ============================================================
// 反例：把「无效修复」固化成可执行的失败，而不是只写在注释里
// ============================================================
describe("反例：为什么不能给重建的根一个新 spanId", () => {
  test("新 spanId 的根 → 判据①②依然全红，而「根数 != 0」这种旧判据会显示 PASS", async () => {
    const { spans } = await runCrashedSession("sess-newid");
    const childMin = Math.min(...spans.map((s) => s.startTime));
    const childMax = Math.max(...spans.map((s) => s.endTime));
    writeEvents("sess-newid", { turns: 2, startMs: childMin - 1000, stepMs: 1 });
    pinSessionDirMtime("sess-newid", childMax + 500);

    const marker = JSON.parse(
      await Bun.file(pendingRootSpanPath("sess-newid")).text(),
    ) as PendingRootSpanMarker;

    // 模拟「只从 events 重建、身份新生成」这个看似自然的做法
    const wrongRoot = rebuildRootSpanFromEvents(
      { ...marker, trace_id: "brand-new-trace", span_id: "brand-new-span" },
      { sessionsRoot: join(testHome, "trajectories", "sessions") },
    );
    const all = [...spans, wrongRoot];

    // 旧判据：「根 span 数 != 0」→ PASS ❌
    expect(all.filter((s) => s.parentSpanId === undefined).length).toBeGreaterThan(0);

    // 新判据：孤儿照旧悬空，且多出一条只有一个孤根的 trace → FAIL ✅
    expect(findDanglingParentViolations(all).length).toBeGreaterThan(0);
    expect(findRootCountViolations(all).length).toBeGreaterThan(0);

    // 对照：沿用原身份就全过（证明上面的红不是断言本身恒红）
    const rightRoot = rebuildRootSpanFromEvents(marker, {
      sessionsRoot: join(testHome, "trajectories", "sessions"),
    });
    expect(findSpanTreeViolations([...spans, rightRoot])).toEqual([]);
  });

  test("标记没被删（模拟 clear 失效）→ 会重复落一个根，判据①报红", async () => {
    // 这条锁住 handleSessionEnd 里那句 clearPendingRootSpan 不能被删：
    // 删了之后正常会话也会在下次启动被重建，同一条 trace 出现 2 个根。
    const { bus, spans } = createEnabledBus();
    const probe = createProbe(bus, "sess-dup");
    const hookSystem = new HookSystem();
    probe.registerHooks(hookSystem);

    await hookSystem.fireSessionStartEvent("startup", { model: "glm-5.3" });
    const marker = JSON.parse(
      await Bun.file(pendingRootSpanPath("sess-dup")).text(),
    ) as PendingRootSpanMarker;
    await hookSystem.fireSessionEndEvent("exit", { total_cost_usd: 0 });
    await bus.flush();

    // 正常路径下标记已被删，这里手动写回，模拟「clear 失效」
    expect(existsSync(pendingRootSpanPath("sess-dup"))).toBe(false);
    writeEvents("sess-dup", { turns: 1, startMs: marker.start_time });
    writePendingRootSpan({ ...marker, pid: DEAD_PID });

    const recovered: SpanData[] = [];
    recoverPendingRootSpans({
      enqueue: (s) => recovered.push(s),
      sessionsRoot: join(testHome, "trajectories", "sessions"),
      isProcessAlive: () => false,
    });

    const all = [...spans, ...recovered];
    expect(all.filter((s) => s.parentSpanId === undefined).length).toBe(2);
    expect(findRootCountViolations(all).length).toBe(1);
  });
});
