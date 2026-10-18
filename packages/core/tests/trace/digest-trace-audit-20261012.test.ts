/**
 * /trace 输出审计（2026-10-12，会话 20261011-220000-97ae3124）的回归门禁。
 *
 * 那次 /trace 有三条结论与原始数据相反、多项该显示的没显示。每条用例都对应一个
 * 实测形态，并配反向断言 —— 这批修复的首要风险是「为了消误报把真信号一起关掉」。
 *
 * 落盘隔离：全程 `resolvePaths(tmpdir)`，不碰 `~/.sid-code`。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolvePaths,
  buildDigest,
  renderHuman,
  computeProcessPathology,
  aggregatePrefixBreakStats,
  cleanPrompt,
  countForkedToolCalls,
  findSessionProcess,
  listSessions,
  renderList,
  type DigestPaths,
} from "@sid-code/core/trace/digest.ts";
import { cacheDimsFor } from "@sid-code/core/trace/stream-observer.ts";
import {
  TtftCacheBucketer,
  effectiveCacheHit,
  CACHE_HIT_MIN_RATIO,
} from "@sid-code/core/trace/ttft-cache-buckets.ts";

let root: string;
let paths: DigestPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sid-trace-audit-"));
  mkdirSync(join(root, "trajectories", "sessions"), { recursive: true });
  paths = resolvePaths(root);
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function ev(event: string, data: Record<string, unknown> = {}) {
  return { event, session_id: "s", timestamp: "2026-10-11T14:00:00.000Z", data };
}

function writeSession(id: string, traj: unknown, events: unknown[], warnLog?: string) {
  const dir = join(root, "trajectories", "sessions", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.traj"), JSON.stringify(traj));
  writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  if (warnLog !== undefined) writeFileSync(join(dir, "warn.log"), warnLog);
  return { id, dir, trajPath: join(dir, "session.traj"), mtimeMs: Date.now() };
}

function writePid(pid: number, sessionId: string) {
  const dir = join(root, "trajectories", ".pids");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({ pid, session_id: sessionId, start_time: "", process_title: "t" }),
  );
}

/** 复现那次会话的建连形态：13 主循环 + 1 标题 + 7 fork，StreamPhase 全部不带 agent_id */
function realShapeEvents() {
  const out: unknown[] = [];
  for (let i = 1; i <= 13; i++) {
    out.push(ev("HttpConnected", { index: i, status: 200 }));
    out.push(ev("StreamPhase", { index: i, phase: "fetch_sent", attempt: 1 }));
    out.push(ev("AfterModelRaw", { index: i, usage: { input_tokens: 58_000 } }));
    out.push(ev("BilledRequest", { index: i, accounted: true, fetch_id: `m${i}` }));
  }
  out.push(ev("HttpConnected", { index: 900_001, status: 200 }));
  out.push(
    ev("BilledRequest", {
      index: 900_001,
      caller: "title_generation",
      accounted: false,
      fetch_id: "t1",
    }),
  );
  for (let i = 2; i <= 8; i++) {
    out.push(ev("HttpConnected", { index: 900_000 + i, status: 200 }));
    // OpenAI 族 StreamPhase 不带身份 —— 这正是旧判据失效的原因
    out.push(ev("StreamPhase", { index: 900_000 + i, phase: "fetch_sent", attempt: 1 }));
    out.push(
      ev("BilledRequest", {
        index: 900_000 + i,
        agent_id: "fork:session-memory-update",
        caller: "agent:fork",
        accounted: false,
        fetch_id: `f${i}`,
      }),
    );
  }
  return out;
}

describe("retry_wasted_tokens：OpenAI 族旁路流不得算成重试", () => {
  it("StreamPhase 无身份时，BilledRequest.accounted=false 足以把差额归到其它调用链", () => {
    const p = computeProcessPathology([] as any, realShapeEvents() as any);
    expect(p.extraConnections).toBe(8);
    expect(p.otherChainConnections).toBe(8);
    expect(p.retryConnections).toBe(0);
    expect(p.retryWastedTokens).toBeUndefined();
    expect(p.retryWastedPathological).toBe(false);
  });

  it("反向：没有任何身份源的差额仍归重试（真重试不能被一起关掉）", () => {
    const events = realShapeEvents().filter(
      (e: any) => !(e.event === "BilledRequest" && e.data.accounted === false),
    );
    const p = computeProcessPathology([] as any, events as any);
    expect(p.retryConnections).toBe(8);
    expect(p.retryWastedPathological).toBe(true);
  });

  it("两个身份源描述同一批流时取 max 不相加（不重复计数）", () => {
    const events = realShapeEvents().map((e: any) =>
      e.event === "StreamPhase" && e.data.index > 900_000
        ? { ...e, data: { ...e.data, agent_id: "fork:session-memory-update" } }
        : e,
    );
    const p = computeProcessPathology([] as any, events as any);
    expect(p.otherChainConnections).toBe(8);
    expect(p.retryConnections).toBe(0);
  });
});

describe("session_end_missing：活会话不报", () => {
  const traj = { trajectory: [], metadata: { session_id: "x", exit_status: "end_turn" } };
  const events = [ev("SessionStart"), ev("UserPromptSubmit")];

  it("PID 文件指向本会话且进程存活 → 不报 session_end_missing / hypothesis_process_killed", () => {
    const ref = writeSession("live", traj, events);
    writePid(process.pid, "live");
    expect(findSessionProcess(paths, "live")).toEqual({ pid: process.pid, alive: true });
    const d = buildDigest(ref, false, paths)!;
    expect(d.anomalies.some((a) => a.kind === "session_end_missing")).toBe(false);
    expect(d.anomalies.some((a) => a.kind === "hypothesis_process_killed")).toBe(false);
    expect(renderHuman(d, { noColor: true })).toContain(`进程仍在运行 (PID ${process.pid})`);
  });

  it("反向：PID 已死 → 照报", () => {
    const ref = writeSession("dead", traj, events);
    writePid(2 ** 22 + 7, "dead"); // 超出常见 pid_max，kill(pid,0) 必 ESRCH
    const d = buildDigest(ref, false, paths)!;
    expect(d.anomalies.some((a) => a.kind === "session_end_missing")).toBe(true);
  });

  it("反向：没有 PID 文件 → 照报（无从核验时维持原判据）", () => {
    const ref = writeSession("nopid", traj, events);
    const d = buildDigest(ref, false, paths)!;
    expect(d.anomalies.some((a) => a.kind === "session_end_missing")).toBe(true);
  });

  it("PID 文件属于别的会话 → 不认", () => {
    writePid(process.pid, "other");
    expect(findSessionProcess(paths, "mine")).toBeUndefined();
  });
});

describe("复审 L9：traj 停在 live 时按进程存活区分 live / dead", () => {
  const liveTraj = { trajectory: [], metadata: { session_id: "x", exit_status: "live" } };
  const events = [ev("SessionStart"), ev("UserPromptSubmit")];

  it("进程存活 → 仍显示 live，不算异常", () => {
    const ref = writeSession("alive1", liveTraj, events);
    writePid(process.pid, "alive1");
    const d = buildDigest(ref, false, paths)!;
    expect(d.exitStatus).toBe("live");
    expect(d.abnormal).toBe(false);
  });

  it("PID 已死 → dead，算异常，头部不再显示 [live]", () => {
    const ref = writeSession("killed1", liveTraj, events);
    writePid(2 ** 22 + 7, "killed1");
    const d = buildDigest(ref, false, paths)!;
    expect(d.exitStatus).toBe("dead");
    expect(d.abnormal).toBe(true);
    expect(renderHuman(d, { noColor: true })).toContain("[dead]");
  });

  it("没有 PID 条目 → dead；会话列表同口径", () => {
    writeSession("killed2", liveTraj, events);
    const d = buildDigest(listSessions(paths)[0], false, paths)!;
    expect(d.exitStatus).toBe("dead");
    expect(renderList(listSessions(paths), { noColor: true })).toContain("dead");
  });

  it("非 live 的 exit_status 原样保留，不查进程", () => {
    const ref = writeSession("normal1", { ...liveTraj, metadata: { exit_status: "end_turn" } }, []);
    expect(buildDigest(ref, false, paths)!.exitStatus).toBe("end_turn");
  });
});

describe("头部：token 口径与成本结构", () => {
  const meta = {
    session_id: "x",
    exit_status: "end_turn",
    total_tokens_sent: 80_833,
    total_cumulative_prompt_tokens: 763_109,
    total_tokens_received: 36_212,
    total_cache_read_tokens: 562_176,
    total_reasoning_tokens: 31_258,
    total_cost_usd: 0.0489,
    side_api_calls: 8,
    side_cost_usd: 0.0329,
    side_tokens_sent: 682_944,
    user_prompts: ["\u0000\u0000   '/a/b.md' 请帮我优化"],
  };

  it("↑ 用累计 prompt（flow），不用末轮快照；并显示缓存/推理/旁路", () => {
    const ref = writeSession("hdr", { trajectory: [], metadata: meta }, [ev("SessionEnd")]);
    const out = renderHuman(buildDigest(ref, false, paths)!, { noColor: true });
    expect(out).toContain("tok 763109↑/36212↓（累计）");
    expect(out).not.toContain("tok 80833↑");
    expect(out).toContain("缓存命中 73.7%");
    expect(out).toContain("推理 31258 tok(占输出 86%)");
    expect(out).toContain("旁路调用 8 次");
    expect(out).toContain("合计 $0.0818");
    expect(out).toContain("  1. '/a/b.md' 请帮我优化");
  });

  it("老轨迹无累计字段 → 退回快照值并显式标「末轮」", () => {
    const { total_cumulative_prompt_tokens: _, ...old } = meta;
    const ref = writeSession("old", { trajectory: [], metadata: old }, [ev("SessionEnd")]);
    const out = renderHuman(buildDigest(ref, false, paths)!, { noColor: true });
    expect(out).toContain("tok 80833↑(末轮)/36212↓(累计)");
  });
});

describe("渲染细节", () => {
  it("ls 的 dir_path 显示值而不是键名", () => {
    const traj = {
      trajectory: [
        {
          message_type: "action",
          role: "assistant",
          tool_name: "ls",
          tool_input: { dir_path: "/x/y" },
        },
      ],
      metadata: { session_id: "x", exit_status: "end_turn" },
    };
    const ref = writeSession("ls", traj, [ev("SessionEnd")]);
    const out = renderHuman(buildDigest(ref, false, paths)!, { noColor: true });
    expect(out).toContain("ls dir_path=/x/y");
    expect(out).not.toContain("{dir_path}");
  });

  it("cleanPrompt 剥 NUL 等控制字符（String.trim 不剥 NUL）", () => {
    expect("\u0000a".trim()).toBe("\u0000a");
    expect(cleanPrompt("\u0000\u0000  hi\u0007 ")).toBe("hi");
  });

  it("fork 工具调用按 execution_context=forked 计数，主循环的不算", () => {
    const counts = countForkedToolCalls([
      ev("PermissionDecision", { tool_name: "edit", execution_context: "forked" }),
      ev("PermissionDecision", { tool_name: "glob", execution_context: "forked" }),
      ev("PermissionDecision", { tool_name: "glob", execution_context: "forked" }),
      ev("PermissionDecision", { tool_name: "bash" }),
    ] as any);
    expect(counts).toEqual({ edit: 1, glob: 2 });
    expect(countForkedToolCalls([ev("PermissionDecision", { tool_name: "bash" })] as any)).toBe(
      undefined,
    );
  });

  it("warn.log 的 CACHE_BREAK 条数进前缀断裂一节", () => {
    const events = [ev("SessionEnd"), ev("prefix_break", { broken: false, char_wasted_ratio: 0 })];
    const log = "[x] [WARN] [CACHE_BREAK] a\n[x] [WARN] [DIAG] b\n[x] [WARN] [CACHE_BREAK] c\n";
    const ref = writeSession(
      "cb",
      { trajectory: [], metadata: { session_id: "x", exit_status: "end_turn" } },
      events,
      log,
    );
    const d = buildDigest(ref, false, paths)!;
    expect(d.cacheBreakWarnings).toBe(2);
    expect(renderHuman(d, { noColor: true })).toContain("另 warn.log 有 2 条 CACHE_BREAK");
  });
});

describe("前缀断裂：历史缩短单独计数", () => {
  it("broken 且 curr < prev 计为缩短；追加/插入不计", () => {
    const s = aggregatePrefixBreakStats([
      ev("prefix_break", { broken: true, prev_total_chars: 83_610, curr_total_chars: 78_109 }),
      ev("prefix_break", { broken: true, prev_total_chars: 145_219, curr_total_chars: 157_353 }),
      ev("prefix_break", { broken: false, prev_total_chars: 100, curr_total_chars: 90 }),
    ] as any)!;
    expect(s.shrunkTurns).toBe(1);
  });
});

describe("TTFT 缓存分桶：按命中比例而不是 cache_read>0", () => {
  it("cacheDimsFor 给分母时落 cache_read_ratio，cache_hit 原语义不变", () => {
    expect(cacheDimsFor(256, 35_806)).toEqual({
      cache_hit: true,
      cache_read: 256,
      cache_read_ratio: 0.0071,
    });
    // 不给分母（Anthropic 族）→ 不落比例
    expect(cacheDimsFor(256)).toEqual({ cache_hit: true, cache_read: 256 });
  });

  it("cache_read=256 / 3.5 万 进 miss 桶；无比例的老事件退回布尔", () => {
    expect(effectiveCacheHit({ cache_hit: true, cache_read_ratio: 0.0071 })).toBe(false);
    expect(effectiveCacheHit({ cache_hit: true, cache_read_ratio: CACHE_HIT_MIN_RATIO })).toBe(
      true,
    );
    expect(effectiveCacheHit({ cache_hit: true })).toBe(true);
    expect(effectiveCacheHit({})).toBeUndefined();

    const b = new TtftCacheBucketer();
    const fc = (i: number) => ({ event: "StreamPhase", session_id: "s", data: { index: i } });
    b.observeFirstContent(fc(1), "openai", 2500);
    b.observeCompleted({ ...fc(1), data: { index: 1, cache_hit: true, cache_read_ratio: 0.007 } });
    b.observeFirstContent(fc(2), "openai", 2000);
    b.observeCompleted({ ...fc(2), data: { index: 2, cache_hit: true, cache_read_ratio: 0.93 } });
    const bucket = b.finalize().get("openai")!;
    expect(bucket.miss).toEqual([2500]);
    expect(bucket.hit).toEqual([2000]);
  });
});
