/**
 * 回归 · /clear = 结束旧会话 + 开新会话（对齐 CC `regenerateSessionId`）
 *
 * 缺陷（实测会话 20261013-124000-9c3eb216）：同一终端 PR-A1 做完 → /clear → PR-A2，
 * events.jsonl 只有 1 条 SessionStart、2 条 UserPromptSubmit；raw.jsonl / session.traj /
 * sessions jsonl / session-index / 账本全部是两个任务混在一份里，/trace 看到的永远是两段混算。
 *
 * 根因两层：
 *   1. App 的 /clear 不换 session id、不发 SessionEnd；
 *   2. SessionStart(source=clear) 被刻意设成 userOnly —— collector / hook-probe 根本收不到。
 *
 * 本文件钉 core 层的契约：
 *   - SessionState.rotate：新 id + parent + 计数归零；
 *   - HookSystem.fireSessionRestartEvent("clear") 送达 runtime 消费者（compact 仍不送）；
 *   - collector：SessionEnd(clear) 收尾旧目录 → SessionStart(clear) 开新目录，metadata 带血缘；
 *     迟到的旧 SessionEnd 被丢弃、不会结束新会话；旧心跳定时器被停掉；
 *   - SessionStore.startSession 写 parentSessionId，且新会话不带旧历史。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TraceCollector } from "@sid-code/core/trace/collector.ts";
import { HookEventName, ConfigSource } from "@sid-code/core/hook/types.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import { SessionStore, parseSessionJsonl } from "@sid-code/core/session/store.ts";
import { resetSideCallStats } from "@sid-code/core/trace/side-call-sink.ts";

const OLD_ID = "20261013-124000-oldclear";
const NEW_ID = "20261013-134700-newclear";

let outDir: string;

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), "clear-rotate-"));
  resetSideCallStats();
});

afterEach(() => {
  resetSideCallStats();
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
});

function startInput(sessionId: string, source: string, extra: Record<string, unknown> = {}) {
  return {
    hook_event_name: HookEventName.SessionStart,
    session_id: sessionId,
    transcript_path: "",
    cwd: process.cwd(),
    timestamp: new Date().toISOString(),
    source,
    model: "test-model",
    permission_mode: "default",
    ...extra,
  };
}

function endInput(sessionId: string, reason: string, apiCalls = 1) {
  return {
    hook_event_name: HookEventName.SessionEnd,
    session_id: sessionId,
    transcript_path: "",
    cwd: process.cwd(),
    timestamp: new Date().toISOString(),
    reason,
    stats: { total_api_calls: apiCalls, total_cost_usd: 0.5 },
  };
}

/** 造一轮真实往返，使 isBlankSession() 为 false（旧会话目录保留） */
function addRealPair(collector: TraceCollector): void {
  (collector as any).pairs.push({
    index: 1,
    request: { model: "test-model", messages: [] },
    response: { content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" },
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    stop_reason: "end_turn",
  });
  (collector as any).metadata.total_api_calls = 1;
}

const sessionDir = (id: string) => join(outDir, "sessions", id);
const events = (id: string): any[] => {
  const p = join(sessionDir(id), "events.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
};

describe("SessionState.rotate", () => {
  test("换新 id、记录 parent、计数与起点归零", () => {
    const s = new SessionState(OLD_ID);
    s.totalCostUSD = 1.23;
    s.sideCostUSD = 0.1;
    s.nextAbsoluteTurn();
    s.nextAbsoluteTurn();
    const before = s.startTime;
    s.rotate(NEW_ID);
    expect(s.sessionId).toBe(NEW_ID);
    expect(s.parentSessionId).toBe(OLD_ID);
    expect(s.totalCostUSD).toBe(0);
    expect(s.sideCostUSD).toBe(0);
    expect(s.getAbsoluteTurn()).toBe(0);
    expect(s.startTime).toBeGreaterThanOrEqual(before);
  });
});

describe("HookSystem.fireSessionRestartEvent", () => {
  function systemWithRuntimeProbe(seen: any[]): HookSystem {
    const hs = new HookSystem();
    hs.initializeFromSources([{ source: ConfigSource.User, hooks: {} } as any]);
    hs.registerHook(
      {
        type: "runtime",
        name: "probe",
        action: async (input: any) => {
          seen.push(input);
        },
      },
      HookEventName.SessionStart,
      { source: ConfigSource.Runtime },
    );
    return hs;
  }

  test("clear 送达 runtime 消费者，并带 parent_session_id", async () => {
    const seen: any[] = [];
    const hs = systemWithRuntimeProbe(seen);
    hs.setSessionId(NEW_ID);
    await hs.fireSessionRestartEvent("clear", "m", { parentSessionId: OLD_ID });
    expect(seen.length).toBe(1);
    expect(seen[0].source).toBe("clear");
    expect(seen[0].session_id).toBe(NEW_ID);
    expect(seen[0].parent_session_id).toBe(OLD_ID);
  });

  test("compact 仍不送 runtime（压缩不换会话）", async () => {
    const seen: any[] = [];
    const hs = systemWithRuntimeProbe(seen);
    await hs.fireSessionRestartEvent("compact");
    expect(seen).toEqual([]);
  });
});

describe("TraceCollector：/clear 换轨迹目录", () => {
  test("SessionEnd(clear) 收尾旧目录，SessionStart(clear) 开新目录且带血缘", async () => {
    const c = new TraceCollector({ outputDir: outDir }, null);
    await (c as any).handleSessionStart(startInput(OLD_ID, "startup"));
    addRealPair(c);
    await (c as any).handleSessionEnd(endInput(OLD_ID, "clear"));
    await (c as any).handleSessionStart(startInput(NEW_ID, "clear", { parent_session_id: OLD_ID }));

    // 两个独立目录
    expect(existsSync(sessionDir(OLD_ID))).toBe(true);
    expect(existsSync(sessionDir(NEW_ID))).toBe(true);
    // 旧目录有终态，exit_status = clear
    const oldEnd = events(OLD_ID).find((e) => e.event === "SessionEnd");
    expect(oldEnd).toBeDefined();
    const oldTraj = JSON.parse(readFileSync(join(sessionDir(OLD_ID), "session.traj"), "utf-8"));
    expect(oldTraj.metadata?.exit_status ?? oldTraj.info?.exit_status).toBe("clear");
    // 新目录的 SessionStart 标了来源与父会话
    const newStart = events(NEW_ID).find((e) => e.event === "SessionStart");
    expect(newStart.data.source).toBe("clear");
    expect(newStart.data.parent_session_id).toBe(OLD_ID);
    expect((c as any).metadata.session_id).toBe(NEW_ID);
    expect((c as any).metadata.parent_session_id).toBe(OLD_ID);
    // 新会话 pair 计数从零开始，不继承旧会话
    expect((c as any).pairs.length).toBe(0);
  });

  test("迟到的旧会话 SessionEnd 不得结束新会话", async () => {
    const c = new TraceCollector({ outputDir: outDir }, null);
    await (c as any).handleSessionStart(startInput(OLD_ID, "startup"));
    await (c as any).handleSessionStart(startInput(NEW_ID, "clear", { parent_session_id: OLD_ID }));
    addRealPair(c);
    await (c as any).handleSessionEnd(endInput(OLD_ID, "clear"));
    // 新会话未被收尾：没有 SessionEnd、心跳仍在跑
    expect(events(NEW_ID).some((e) => e.event === "SessionEnd")).toBe(false);
    expect((c as any).heartbeatTimer).not.toBeNull();
    expect((c as any).metadata.end_time).toBeUndefined();
    await (c as any).handleSessionEnd(endInput(NEW_ID, "exit"));
    expect(events(NEW_ID).some((e) => e.event === "SessionEnd")).toBe(true);
  });

  test("旧会话未收尾就开新会话：旧心跳定时器被停掉（不泄漏、不再写旧目录）", async () => {
    const c = new TraceCollector({ outputDir: outDir }, null);
    await (c as any).handleSessionStart(startInput(OLD_ID, "startup"));
    const oldTimer = (c as any).heartbeatTimer;
    await (c as any).handleSessionStart(startInput(NEW_ID, "clear", { parent_session_id: OLD_ID }));
    expect((c as any).heartbeatTimer).not.toBe(oldTimer);
    expect((c as any).heartbeatPath).toContain(NEW_ID);
    await (c as any).handleSessionEnd(endInput(NEW_ID, "exit", 0));
  });

  test("上一段被判空壳删掉后，新会话照常落盘（sessionDisposed 复位）", async () => {
    const c = new TraceCollector({ outputDir: outDir }, null);
    await (c as any).handleSessionStart(startInput(OLD_ID, "startup"));
    await (c as any).handleSessionEnd(endInput(OLD_ID, "clear", 0)); // 空壳 → 删目录
    expect(existsSync(sessionDir(OLD_ID))).toBe(false);
    await (c as any).handleSessionStart(startInput(NEW_ID, "clear", { parent_session_id: OLD_ID }));
    expect((c as any).sessionDisposed).toBe(false);
    addRealPair(c);
    await (c as any).handleSessionEnd(endInput(NEW_ID, "exit"));
    expect(existsSync(join(sessionDir(NEW_ID), "session.traj"))).toBe(true);
  });
});

describe("SessionStore：/clear 开新 jsonl", () => {
  let home: string;
  let origConfigDir: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "clear-store-"));
    mkdirSync(join(home, "sessions"), { recursive: true });
    origConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = home;
  });

  afterEach(() => {
    if (origConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = origConfigDir;
    rmSync(home, { recursive: true, force: true });
  });

  test("endSession 后 startSession(newId, parent) 落到新文件，旧历史不进新文件", async () => {
    const { flushPendingSessionWrites } = await import("@sid-code/core/session/store.ts");
    const store = new SessionStore();
    store.startSession(OLD_ID, "m", "p", process.cwd());
    store.appendMessage({ role: "user", content: "PR-A1 任务" } as any);
    store.endSession(0.5, 1);
    store.startSession(NEW_ID, "m", "p", process.cwd(), undefined, OLD_ID);
    store.appendMessage({ role: "user", content: "PR-A2 任务" } as any);
    flushPendingSessionWrites();

    const newFile = store.getCurrentFile()!;
    expect(newFile).toContain(NEW_ID);
    const lines = readFileSync(newFile, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const start = lines.find((l) => l.type === "session_start");
    expect(start.sessionId).toBe(NEW_ID);
    expect(start.parentSessionId).toBe(OLD_ID);
    // clear 不是 fork：parentUuid 链从 null 起，不挂旧会话
    expect(start.parentUuid).toBeNull();
    const text = readFileSync(newFile, "utf-8");
    expect(text).not.toContain("PR-A1");
    expect(parseSessionJsonl(text)).toBeTruthy();
  });

  test("clear 后不发消息直接退出：不留空壳新文件（懒创建）", () => {
    const store = new SessionStore();
    store.startSession(NEW_ID, "m", "p", process.cwd(), undefined, OLD_ID);
    const f = store.getCurrentFile()!;
    store.endSession(0, 0);
    expect(existsSync(f)).toBe(false);
  });
});
