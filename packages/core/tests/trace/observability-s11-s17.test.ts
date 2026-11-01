/**
 * S11 / S12 / S14 / S17 可观测性缺陷回归测试
 *
 * - S11：/debug 快照上传三态、中途快照不清理本地、`.uploaded` 带 final、积压计数自检
 * - S12：中途重建省略 end_time，带 snapshot_at / session_ended，进行中不推断 end_turn
 * - S14：SessionStart 落 ts_semantics、raw.jsonl 带 ended_at/elapsed_ms、主循环事件补 pair_index
 * - S17：PostToolUseFailure 带 error_kind + error_head，且 error_head 不上传
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TraceCollector, classifyToolFailure } from "@sid-code/core/trace/collector.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { UploadManager, stripLocalOnlyEventFields } from "@sid-code/core/trace/uploader.ts";
import { scanPendingUploads, getUploadBacklog } from "@sid-code/core/trace/backfill.ts";
import { hasFinalUploadMarker } from "@sid-code/core/trace/upload-marker.ts";
import { buildTrajectory, type TraceMetadata } from "@sid-code/core/trace/builder.ts";
import { deriveDuration } from "@sid-code/core/trace/digest.ts";
import { emitStreamPhase } from "@sid-code/core/trace/stream-observer.ts";
import { EVENT_TS_SEMANTIC } from "@sid-code/core/trace/event-ts-semantics.ts";

/** U3：上传体改为流式 multipart（不再是 FormData 对象），断言前先解析回 FormData */
async function parseUploadBody(init: any): Promise<FormData> {
  return new Response(init.body, {
    headers: { "content-type": init.headers["Content-Type"] },
  }).formData();
}

function makeTmpDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readEvents(sessionDir: string): any[] {
  return readFileSync(join(sessionDir, "events.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function fireRound(
  hs: HookSystem,
  ref?: { turn_index: number; loop_id: string },
  between?: () => void,
) {
  const messages = [{ role: "user", content: "hi" }];
  await hs.fireBeforeModelEvent(
    { model: "m", messages: messages as any, raw_messages: messages } as any,
    ref ? { stream_snapshot_ref: ref } : undefined,
  );
  between?.();
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

// 测试用的最小 metadata（与 builder.test.ts 的 makeMetadata 同形）
function makeMeta(over: Partial<TraceMetadata> = {}): TraceMetadata {
  return {
    session_id: "s",
    model: "m",
    start_time: "2026-03-26T10:00:00.000Z",
    working_directory: "/tmp",
    tools_used: new Set<string>(),
    files_edited: new Set<string>(),
    user_prompts: [],
    compactions: [],
    subagent_spans: [],
    has_thinking: false,
    has_sub_agent: false,
    total_tokens_sent: 0,
    total_tokens_received: 0,
    total_cumulative_prompt_tokens: 0,
    total_cache_read_tokens: 0,
    total_cache_creation_tokens: 0,
    total_cost_usd: 0,
    total_api_calls: 0,
    side_api_calls: 0,
    side_cost_usd: 0,
    side_tokens_sent: 0,
    side_tokens_received: 0,
    ...over,
  } as TraceMetadata;
}

const pairEndTurn = {
  timestamp: "2026-03-26T10:00:01.000Z",
  index: 1,
  model: "m",
  request: { model: "m" },
  response: {
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  },
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
  stop_reason: "end_turn",
  is_partial: false,
} as any;

describe("S11-S17 可观测性", () => {
  let tmp: string;
  let origConfigDir: string | undefined;
  let origFetch: typeof fetch;

  beforeEach(() => {
    tmp = makeTmpDir("obs-s11");
    // 落盘隔离：存/恢复原值，不无条件 delete（会抹掉 preload 兜底）
    origConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = join(tmp, "home");
    origFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = origFetch;
    await new Promise((r) => setTimeout(r, 0));
    if (origConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = origConfigDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  // ─── S11 ───

  describe("S11 /debug 快照上传", () => {
    test("deleteAfterUpload=true 下 uploadSnapshot 后运行中会话文件仍在，标记 final:false", async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ status: "saved", sha256: "" }), { status: 200 })) as any;
      const uploader = new UploadManager({
        baseUrl: "http://localhost",
        token: "t",
        outputDir: tmp,
        maxRetries: 1,
        compress: false,
        deleteAfterUpload: true,
      });
      const hs = new HookSystem();
      hs.setSessionId("sess-snap");
      const c = new TraceCollector({ outputDir: tmp }, uploader);
      c.registerHooks(hs);
      await hs.fireSessionStartEvent("startup", { model: "m" });
      await fireRound(hs);

      const r = await c.uploadSnapshot();
      expect(r.uploaded).toBe(true);
      const dir = r.sessionDir;
      // 运行中会话的数据文件一个都不能少
      expect(existsSync(join(dir, "session.traj"))).toBe(true);
      expect(existsSync(join(dir, "raw.jsonl"))).toBe(true);
      expect(existsSync(join(dir, "events.jsonl"))).toBe(true);
      const marker = JSON.parse(readFileSync(join(dir, ".uploaded"), "utf-8"));
      expect(marker.final).toBe(false);
      expect(typeof marker.snapshot_at).toBe("string");
      expect(hasFinalUploadMarker(dir)).toBe(false);
      // S12：metadata.json 同步省略 end_time、带 snapshot_at / session_ended
      const md = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf-8"));
      expect("end_time" in md).toBe(false);
      expect(typeof md.snapshot_at).toBe("string");
      expect(md.session_ended).toBe(false);
    });

    test("非快照上传（SessionEnd 路径）仍写 final:true 并按配置清理", async () => {
      const dir = join(tmp, "sessions", "s-final");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "session.traj"), "{}");
      writeFileSync(join(dir, "events.jsonl"), "{}\n");
      globalThis.fetch = (async () => new Response("{}", { status: 200 })) as any;
      const mgr = new UploadManager({
        baseUrl: "http://localhost",
        token: "t",
        outputDir: tmp,
        maxRetries: 1,
        compress: false,
        deleteAfterUpload: true,
      });
      await mgr.uploadSession(dir, "s-final");
      expect(existsSync(join(dir, "session.traj"))).toBe(false);
      expect(JSON.parse(readFileSync(join(dir, ".uploaded"), "utf-8")).final).toBe(true);
    });

    test("复审 M4：快照上传晚于终态上传完成时不把 final:true 覆盖成 false", async () => {
      for (const deleteAfterUpload of [false, true]) {
        const id = `s-race-${deleteAfterUpload}`;
        const dir = join(tmp, "sessions", id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "session.traj"), '{"metadata":{"session_id":"x"}}');
        writeFileSync(join(dir, "events.jsonl"), "{}\n");
        globalThis.fetch = (async () => new Response("{}", { status: 200 })) as any;
        const mgr = new UploadManager({
          baseUrl: "http://localhost",
          token: "t",
          outputDir: tmp,
          maxRetries: 1,
          compress: false,
          deleteAfterUpload,
        });
        // 时序：SessionEnd 上传先完成（final:true），在途的 /debug 快照随后才完成
        await mgr.uploadSession(dir, id);
        expect(hasFinalUploadMarker(dir)).toBe(true);
        await mgr.uploadSession(dir, id, { snapshot: true });
        expect({ deleteAfterUpload, final: hasFinalUploadMarker(dir) }).toEqual({
          deleteAfterUpload,
          final: true,
        });
      }
    });

    test("超时分支返回 pending:true，后台上传继续跑完", async () => {
      let finished = false;
      const slow = {
        uploadSession: async () => {
          await new Promise((r) => setTimeout(r, 80));
          finished = true;
          return { allConfirmed: true };
        },
      };
      const hs = new HookSystem();
      hs.setSessionId("sess-slow");
      const c = new TraceCollector({ outputDir: tmp }, slow);
      c.registerHooks(hs);
      (c as any).snapshotWaitMs = 10;
      await hs.fireSessionStartEvent("startup", { model: "m" });

      const r = await c.uploadSnapshot();
      expect(r.uploaded).toBe(false);
      expect(r.pending).toBe(true);
      expect(r.error).not.toContain("会话结束后");
      expect(finished).toBe(false);
      await new Promise((res) => setTimeout(res, 120));
      expect(finished).toBe(true);
    });

    test("真失败不带 pending", async () => {
      const failing = { uploadSession: async () => ({ allConfirmed: false }) };
      const hs = new HookSystem();
      hs.setSessionId("sess-fail");
      const c = new TraceCollector({ outputDir: tmp }, failing);
      c.registerHooks(hs);
      await hs.fireSessionStartEvent("startup", { model: "m" });
      const r = await c.uploadSnapshot();
      expect(r.uploaded).toBe(false);
      expect(r.pending).toBeUndefined();
    });

    test("backfill 只把 final 标记当已上传；历史无 final 字段的标记按 final 兼容", () => {
      const mk = (id: string, marker?: string) => {
        const d = join(tmp, "sessions", id);
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, "session.traj"), '{"x":1}');
        writeFileSync(join(d, "events.jsonl"), "{}\n");
        if (marker !== undefined) writeFileSync(join(d, ".uploaded"), marker);
      };
      mk("legacy-empty", "{}");
      mk("legacy-shape", JSON.stringify({ confirmed_at: "x", session_id: "legacy-shape" }));
      mk("final", JSON.stringify({ final: true }));
      mk("snapshot", JSON.stringify({ final: false, snapshot_at: "x" }));
      const { pending, stats } = scanPendingUploads({
        outputDir: tmp,
        minAgeMs: -1e12,
        heartbeatFreshMs: 0,
      });
      expect(stats.alreadyUploaded).toBe(3);
      expect(pending.map((p) => p.sessionId)).toEqual(["snapshot"]);
    });

    test("getUploadBacklog 补齐分类计数，自检 unaccounted=0", () => {
      const sd = join(tmp, "sessions");
      mkdirSync(join(sd, "no-traj"), { recursive: true });
      mkdirSync(join(sd, "empty-traj"), { recursive: true });
      writeFileSync(join(sd, "empty-traj", "session.traj"), "");
      mkdirSync(join(sd, "fresh"), { recursive: true });
      writeFileSync(join(sd, "fresh", "session.traj"), "{}");
      writeFileSync(join(sd, "fresh", "events.jsonl"), "{}\n");
      const b = getUploadBacklog({ outputDir: tmp, minAgeMs: 3_600_000 });
      expect(b.totalSessions).toBe(3);
      expect(b.noTraj).toBe(1);
      expect(b.emptyTraj).toBe(1);
      expect(b.tooNew).toBe(1);
      expect(b.errored).toBe(0);
      expect(b.unaccounted).toBe(0);
    });
  });

  // ─── S12 ───

  describe("S12 end_time 语义", () => {
    test("中途重建省略 end_time，带 snapshot_at / session_ended=false，exit_status=live", () => {
      const t = buildTrajectory([pairEndTurn], makeMeta());
      expect("end_time" in t.metadata).toBe(false);
      expect(typeof t.metadata.snapshot_at).toBe("string");
      expect(t.metadata.session_ended).toBe(false);
      expect(t.metadata.exit_status).toBe("live");
    });

    test("SessionEnd 写过 end_time 后原样输出且 session_ended=true，沿用推断", () => {
      const t = buildTrajectory(
        [pairEndTurn],
        makeMeta({ end_time: "2026-03-26T10:05:00.000Z", end_source: "exit" }),
      );
      expect(t.metadata.end_time).toBe("2026-03-26T10:05:00.000Z");
      expect(t.metadata.session_ended).toBe(true);
      expect(t.metadata.exit_status).toBe("end_turn");
    });

    test("deriveDuration：缺 end_time 回落 snapshot_at 并标 inProgress；都缺返回 0", () => {
      expect(
        deriveDuration({
          start_time: "2026-03-26T10:00:00.000Z",
          snapshot_at: "2026-03-26T10:00:30.000Z",
        }),
      ).toEqual({ ms: 30_000, inProgress: true });
      expect(
        deriveDuration({
          start_time: "2026-03-26T10:00:00.000Z",
          end_time: "2026-03-26T10:01:00.000Z",
          snapshot_at: "2026-03-26T10:00:30.000Z",
        }),
      ).toEqual({ ms: 60_000, inProgress: false });
      expect(deriveDuration({ start_time: "2026-03-26T10:00:00.000Z" })).toEqual({
        ms: 0,
        inProgress: false,
      });
    });
  });

  // ─── S14 ───

  describe("S14 时间戳语义 + pair_index", () => {
    test("SessionStart 写一次 ts_semantics；raw.jsonl 完整行带 ended_at/elapsed_ms；StreamPhase 补全局 pair_index", async () => {
      const hs = new HookSystem();
      hs.setSessionId("sess-ts");
      const c = new TraceCollector({ outputDir: tmp });
      c.registerHooks(hs);
      await hs.fireSessionStartEvent("startup", { model: "m" });

      // 两轮都用循环内 turn_index=1（第二轮是新 queryLoop），全局 pair index 应为 1 和 2
      await fireRound(hs, { turn_index: 1, loop_id: "L1" }, () =>
        emitStreamPhase(1, "first_content", { model: "m" }),
      );
      await fireRound(hs, { turn_index: 1, loop_id: "L2" }, () =>
        emitStreamPhase(1, "first_content", { model: "m" }),
      );
      const dir = join(tmp, "sessions", "sess-ts");
      const events = readEvents(dir);

      const starts = events.filter((e) => e.event === "SessionStart");
      expect(starts).toHaveLength(1);
      expect(starts[0].data.ts_semantics.events).toEqual(EVENT_TS_SEMANTIC);
      // 不逐行加
      expect(events.filter((e) => e.data?.ts_semantics).length).toBe(1);

      const phases = events.filter((e) => e.event === "StreamPhase");
      expect(phases.map((e) => e.data.index)).toEqual([1, 1]);
      expect(phases.map((e) => e.data.pair_index)).toEqual([1, 2]);

      const rawFull = readFileSync(join(dir, "raw.jsonl"), "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
        .filter((r) => r.type !== "request_sent");
      expect(rawFull).toHaveLength(2);
      for (const r of rawFull) {
        expect(typeof r.ended_at).toBe("string");
        expect(Date.parse(r.ended_at)).toBeGreaterThanOrEqual(Date.parse(r.timestamp));
        expect(typeof r.elapsed_ms).toBe("number");
        expect(r.elapsed_ms).toBeGreaterThanOrEqual(0);
      }
    });

    test("子代理（agent_id）的 StreamPhase 不补 pair_index", async () => {
      const hs = new HookSystem();
      hs.setSessionId("sess-ag");
      const c = new TraceCollector({ outputDir: tmp });
      c.registerHooks(hs);
      await hs.fireSessionStartEvent("startup", { model: "m" });
      await fireRound(hs, { turn_index: 1, loop_id: "L" }, () =>
        emitStreamPhase(1, "first_content", { model: "m" }, "agent-x"),
      );
      const phase = readEvents(join(tmp, "sessions", "sess-ag")).find(
        (e) => e.event === "StreamPhase",
      );
      expect(phase.data.agent_id).toBe("agent-x");
      expect("pair_index" in phase.data).toBe(false);
    });
  });

  // ─── S17 ───

  describe("S17 PostToolUseFailure 错误分类", () => {
    async function failureEvents(): Promise<{ dir: string; evs: any[] }> {
      const hs = new HookSystem();
      hs.setSessionId("sess-fail17");
      const c = new TraceCollector({ outputDir: tmp });
      c.registerHooks(hs);
      await hs.fireSessionStartEvent("startup", { model: "m" });
      await hs.firePostToolUseFailureEvent(
        "bash",
        {},
        "Command timed out " + "x".repeat(500),
        "t1",
        {
          failure_kind: "exception",
        },
      );
      await hs.firePostToolUseFailureEvent("edit", {}, "参数缺少 file_path", "t2", {
        failure_kind: "validation",
      });
      await hs.firePostToolUseFailureEvent("write", {}, "PreToolUse hook 阻止", "t3", {
        failure_kind: "hook_blocked",
      });
      await hs.firePostToolUseFailureEvent("read", {}, "ENOENT: no such file", "t4", {
        failure_kind: "exception",
      });
      const dir = join(tmp, "sessions", "sess-fail17");
      return { dir, evs: readEvents(dir).filter((e) => e.event === "PostToolUseFailure") };
    }

    test("落 error_kind 与截断到 200 字的 error_head", async () => {
      const { evs } = await failureEvents();
      expect(evs.map((e) => e.data.error_kind)).toEqual([
        "timeout",
        "validation",
        "permission",
        "exec",
      ]);
      expect(evs[0].data.error_head.length).toBe(200);
      expect(evs[0].data.error_head.startsWith("Command timed out")).toBe(true);
      expect(evs[3].data.error_head).toBe("ENOENT: no such file");
    });

    test("上传 events.jsonl 的 payload 不含 error_head、保留 error_kind", async () => {
      const { dir } = await failureEvents();
      const local = readFileSync(join(dir, "events.jsonl"), "utf-8");
      expect(local).toContain('"error_head"');

      const bodies: Record<string, string> = {};
      globalThis.fetch = (async (_u: any, init: any) => {
        const fd = await parseUploadBody(init);
        const f = fd.get("file") as File;
        bodies[String(fd.get("file_type"))] = await f.text();
        return new Response(JSON.stringify({ status: "saved", sha256: "" }), { status: 200 });
      }) as any;
      const mgr = new UploadManager({
        baseUrl: "http://localhost",
        token: "t",
        outputDir: tmp,
        maxRetries: 1,
        compress: false,
      });
      await mgr.uploadFileWithRetry(join(dir, "events.jsonl"), "sess-fail17", "events");
      expect(bodies.events).toBeDefined();
      expect(bodies.events).not.toContain("error_head");
      expect(bodies.events).toContain('"error_kind":"timeout"');
      // 本地文件不受影响
      expect(readFileSync(join(dir, "events.jsonl"), "utf-8")).toBe(local);
    });

    test("G1：stripLocalOnlyEventFields 剥掉 PreToolUse.input_summary，保留其余字段", () => {
      const line = JSON.stringify({
        event: "PreToolUse",
        data: {
          tool_name: "read",
          tool_use_id: "t1",
          agent_id: "s-sub-1",
          input_summary: { file_path: "/secret/a" },
        },
      });
      const out = JSON.parse(stripLocalOnlyEventFields(line));
      expect(out.data).toEqual({ tool_name: "read", tool_use_id: "t1", agent_id: "s-sub-1" });
    });

    test("stripLocalOnlyEventFields 保留损坏行与无关行原样", () => {
      const input = ['{"event":"A","data":{"x":1}}', 'not json "error_head"', ""].join("\n");
      expect(stripLocalOnlyEventFields(input)).toBe(input);
    });
  });
});

describe("复审 L8：classifyToolFailure 只认超时事件，不认参数里的 timeout 字样", () => {
  const kind = (error: string) => classifyToolFailure({ error } as any);
  test("真超时 → timeout", () => {
    for (const e of [
      "Command timed out after 120s",
      "connect ETIMEDOUT 1.2.3.4:443",
      "RipgrepTimeoutError: search",
      "Request timeout after 30000ms",
      "命令超时（120秒），已终止 PID 1",
      "工具调用超时 (60000ms)",
      "MCP 请求超时: tools/call",
    ]) {
      expect({ e, k: kind(e) }).toEqual({ e, k: "timeout" });
    }
  });
  test("提到 timeout 的参数/校验错误 → exec", () => {
    for (const e of [
      "--timeout 参数非法：必须为正整数",
      "invalid value for timeout: -1",
      "超时时间必须为正数",
      "unknown option --timeout-ms",
    ]) {
      expect({ e, k: kind(e) }).toEqual({ e, k: "exec" });
    }
  });
});
