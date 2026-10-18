/**
 * 可观测性缺口 G2 / G3 / G4 / G6 回归测试（方案：20261019-可观测性缺口-补埋点方案）
 *
 * - G2：子代理成本经 usage-sink 落 SubagentCost 事件 + metadata.subagent_cost_usd，
 *       金额与 SessionState 入账同一个数；total_cost_usd 运行中语义不变
 * - G3：read 引导提示（narrow_first / repeat_narrow）落 ReadHint 事件，子代理带 agent_id
 * - G4：stream_stall / stream_completed 按 turnIndex 补 pair_index（主循环）/ agent_turn（子代理）
 * - G6：子代理请求数按入账票据认领数累加，不再一个子代理只算 1 次
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionState } from "@sid-code/core/session/state.ts";
import {
  createSubAgentUsageSink,
  setSubagentCostTraceSink,
  SUBAGENT_COST_EVENT_NAME,
} from "@sid-code/core/agent/usage-sink.ts";
import { SubAgentTool } from "@sid-code/core/agent/tool.ts";
import type { SubAgentResult } from "@sid-code/core/agent/sub-agent.ts";
import { UsageSinkTicket } from "@sid-code/core/llm/billing-sink.ts";
import { ReadTool, setReadHintTraceSink } from "@sid-code/core/tool/read.ts";
import { runWithHookAgent } from "@sid-code/core/agent/hook-agent-context.ts";
import { TraceCollector } from "@sid-code/core/trace/collector.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { stripLocalOnlyEventFields } from "@sid-code/core/trace/uploader.ts";

const MODEL = "claude-sonnet-4-20250514";

function makeTmpDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function subResult(over: Partial<SubAgentResult> = {}): SubAgentResult {
  return {
    success: true,
    output: "done",
    usage: { inputTokens: 12_000, outputTokens: 800 },
    turns: 5,
    toolUseCount: 3,
    model: MODEL,
    provider: "anthropic",
    ...over,
  };
}

async function fireRound(hs: HookSystem, ref?: { turn_index: number; loop_id: string }) {
  const messages = [{ role: "user", content: "hi" }];
  await hs.fireBeforeModelEvent(
    { model: "m", messages: messages as any, raw_messages: messages } as any,
    ref ? { stream_snapshot_ref: ref } : undefined,
  );
  await hs.fireAfterModelEvent(
    { model: "m", messages: [], raw_messages: messages } as any,
    {
      content_blocks: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    } as any,
  );
}

function readEvents(dir: string, sid: string): any[] {
  return readFileSync(join(dir, "sessions", sid, "events.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ─────────────────────────── G2 + G6：usage-sink ───────────────────────────

describe("G2/G6 · usage-sink 落子代理成本与真实请求数", () => {
  let got: Record<string, unknown>[];
  beforeEach(() => {
    got = [];
    setSubagentCostTraceSink((d) => got.push(d));
  });
  afterEach(() => setSubagentCostTraceSink(null));

  test("事件金额 = SessionState 本次入账金额，带 agent_id 与真实请求数", () => {
    const ss = new SessionState("g2-a");
    const sink = createSubAgentUsageSink(ss, { model: MODEL });
    sink(subResult({ agentId: "agent-x", apiRequests: 7 }));

    expect(got).toHaveLength(1);
    expect(ss.totalCostUSD).toBeGreaterThan(0);
    expect(got[0]!.cost_usd).toBe(ss.totalCostUSD);
    expect(got[0]).toMatchObject({
      agent_id: "agent-x",
      model: MODEL,
      api_requests: 7,
      api_requests_exact: true,
      input_tokens: 12_000,
      output_tokens: 800,
    });
    // G6：⟳ / /stats / SessionEnd 共用的 getter 按真实请求数累加
    expect(ss.getTotalRequests()).toBe(7);
  });

  test("调用方没给请求数时按 1 计并标 api_requests_exact=false（不猜）", () => {
    const ss = new SessionState("g2-b");
    createSubAgentUsageSink(ss, { model: MODEL })(subResult());
    expect(ss.getTotalRequests()).toBe(1);
    expect(got[0]).toMatchObject({ api_requests: 1, api_requests_exact: false });
    expect(Object.keys(got[0]!)).not.toContain("agent_id");
  });

  test("主循环 updateUsage 默认仍每次 +1（口径不变）", () => {
    const ss = new SessionState("g6-main");
    ss.updateUsage(MODEL, { inputTokens: 10, outputTokens: 1 }, 0, "anthropic");
    ss.updateUsage(MODEL, { inputTokens: 10, outputTokens: 1 }, 0, "anthropic");
    expect(ss.getTotalRequests()).toBe(2);
  });

  test("SubAgentTool.collectUsage 用入账票据认领数回填 apiRequests", () => {
    const ss = new SessionState("g6-ticket");
    const tool = new SubAgentTool({} as any, {} as any);
    tool.setUsageSink(createSubAgentUsageSink(ss, { model: MODEL }));
    const ticket = new UsageSinkTicket();
    for (let i = 0; i < 5; i++) ticket.claim({ fetchId: `f${i}` });
    const r = subResult();
    const charged = (tool as any).collectUsage(r, ticket);
    expect(charged).toBe(true);
    expect(r.apiRequests).toBe(5);
    expect(ss.getTotalRequests()).toBe(5);
  });
});

// ─────────────────────────── G2：collector 落盘 ───────────────────────────

describe("G2 · collector 落 SubagentCost 与 subagent_cost_usd", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir("g2-collector");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  test("累加进 metadata，total_cost_usd 运行中不含子代理", async () => {
    const hs = new HookSystem();
    hs.setSessionId("sess-g2");
    const c = new TraceCollector({ outputDir: tmp });
    c.registerHooks(hs);
    await hs.fireSessionStartEvent("startup", { model: "m" });
    await fireRound(hs);
    const mainCost = (c as any).metadata.total_cost_usd;

    c.recordSubagentCost({ agent_id: "a1", cost_usd: 0.1, api_requests: 4 });
    c.recordSubagentCost({ agent_id: "a2", cost_usd: 0.05, api_requests: 2 });

    const md = (c as any).metadata;
    expect(md.subagent_cost_usd).toBeCloseTo(0.15, 12);
    expect(md.subagent_api_calls).toBe(6);
    expect(md.total_cost_usd).toBe(mainCost);
    expect(md.cost_scope).toBe("main");

    const evs = readEvents(tmp, "sess-g2").filter((e) => e.event === SUBAGENT_COST_EVENT_NAME);
    expect(evs.map((e) => e.data.agent_id)).toEqual(["a1", "a2"]);

    await hs.fireSessionEndEvent("exit");
    const traj = JSON.parse(
      readFileSync(join(tmp, "sessions", "sess-g2", "session.traj"), "utf-8"),
    );
    expect(traj.metadata.subagent_cost_usd).toBeCloseTo(0.15, 12);
    expect(traj.metadata.subagent_api_calls).toBe(6);
  });
});

// ─────────────────────────── G4：stall 归属 ───────────────────────────

describe("G4 · stream_stall / stream_completed 补轮次归属", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir("g4-collector");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  test("主循环 → pair_index；子代理 → agent_turn；旁路调用与其它类型不补", async () => {
    const hs = new HookSystem();
    hs.setSessionId("sess-g4");
    const c = new TraceCollector({ outputDir: tmp });
    c.registerHooks(hs);
    await hs.fireSessionStartEvent("startup", { model: "m" });
    await fireRound(hs, { turn_index: 1, loop_id: "L" });
    await fireRound(hs, { turn_index: 2, loop_id: "L" });

    c.writeRetryTelemetry({ type: "stream_stall", turnIndex: 2, gapMs: 5000 });
    c.writeRetryTelemetry({ type: "stream_completed", turnIndex: 1, elapsedMs: 100 });
    c.writeRetryTelemetry({ type: "stream_stall", turnIndex: 10003, agentId: "sub-1" });
    c.writeRetryTelemetry({ type: "stream_stall", turnIndex: 20004, agentId: "sub-1" });
    c.writeRetryTelemetry({ type: "stream_stall", turnIndex: 2, caller: "recall" });
    c.writeRetryTelemetry({ type: "stream_stall", turnIndex: 99 });
    c.writeRetryTelemetry({ type: "retry", turnIndex: 2 });

    const tel = readEvents(tmp, "sess-g4")
      .filter((e) => e.event === "RetryTelemetry")
      .map((e) => e.data);
    const pairOf = (i: number) => (c as any).turnToPairIndex.get(i);
    expect(tel[0].pair_index).toBe(pairOf(2));
    expect(tel[1].pair_index).toBe(pairOf(1));
    expect(tel[0].pair_index).not.toBe(tel[1].pair_index);
    expect(tel[2]).toMatchObject({ agent_turn: 3 });
    expect(tel[2].pair_index).toBeUndefined();
    expect(tel[3]).toMatchObject({ agent_turn: 4, agent_summary_turn: true });
    expect(tel[4].pair_index).toBeUndefined();
    expect(tel[5].pair_index).toBeUndefined();
    expect(tel[6].pair_index).toBeUndefined();
  });
});

// ─────────────────────────── G3：ReadHint ───────────────────────────

describe("G3 · read 引导提示落 ReadHint 事件", () => {
  let tmp: string;
  let file: string;
  let got: Record<string, unknown>[];
  beforeEach(() => {
    tmp = makeTmpDir("g3-read");
    file = join(tmp, "a.ts");
    writeFileSync(file, Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n"));
    got = [];
    setReadHintTraceSink((d) => got.push(d));
  });
  afterEach(() => {
    setReadHintTraceSink(null);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("首次窄读 → narrow_first（主循环不带 agent_id）", async () => {
    const tool = new ReadTool();
    await tool.execute({ file_path: file, offset: 1, limit: 10 });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      kind: "narrow_first",
      hint_file_path: file,
      read_count: 1,
      total_lines: 50,
      start_line: 1,
      end_line: 10,
    });
    expect(Object.keys(got[0]!)).not.toContain("agent_id");
  });

  test("子代理里重复窄读 → repeat_narrow 带 agent_id", async () => {
    const tool = new ReadTool();
    await runWithHookAgent({ agent: { agent_id: "sub-9", agent_type: "explore" } }, async () => {
      for (let i = 0; i < 3; i++) await tool.execute({ file_path: file, offset: 5, limit: 10 });
    });
    const repeat = got.filter((e) => e.kind === "repeat_narrow");
    expect(repeat).toHaveLength(1);
    expect(repeat[0]).toMatchObject({ agent_id: "sub-9", read_count: 3, overlap_ratio: 1 });
  });

  test("hint_file_path 只留本地：上传前被剥掉，其余字段保留", () => {
    const line = JSON.stringify({
      event: "ReadHint",
      data: { kind: "narrow_first", hint_file_path: "/secret/a.ts", read_count: 1 },
    });
    const out = JSON.parse(stripLocalOnlyEventFields(line));
    expect(out.data).toEqual({ kind: "narrow_first", read_count: 1 });
  });
});
