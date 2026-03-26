/**
 * TraceWriter 单元测试
 * 验证文件创建、覆盖写入、追加写入的正确性
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { TraceWriter, type HookEvent, type RawJsonlEntry } from "../../src/trace/writer.ts";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

describe("TraceWriter", () => {
  let testDir: string;
  const sessionId = "test-session-001";

  beforeEach(() => {
    testDir = join(tmpdir(), `sid-code-trace-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  test("构造时不立即创建目录", () => {
    const writer = new TraceWriter(testDir, sessionId);
    const sessionDir = writer.getSessionDir();
    expect(sessionDir).toBe(join(testDir, "sessions", sessionId));
    expect(existsSync(sessionDir)).toBe(false);
  });

  test("getSessionDir 返回正确路径", () => {
    const writer = new TraceWriter(testDir, sessionId);
    expect(writer.getSessionDir()).toBe(join(testDir, "sessions", sessionId));
  });

  test("首次写入时自动创建目录", () => {
    const writer = new TraceWriter(testDir, sessionId);
    writer.appendEventsJsonl('{"test": true}');
    expect(existsSync(writer.getSessionDir())).toBe(true);
  });

  // ─── session.traj 覆盖写入 ───

  test("writeSessionTraj 写入文件", async () => {
    const writer = new TraceWriter(testDir, sessionId);
    const content = JSON.stringify({ trajectory: [], history: [], info: {}, metadata: {} }, null, 2);
    await writer.writeSessionTraj(content);

    const filePath = join(writer.getSessionDir(), "session.traj");
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe(content);
  });

  test("writeSessionTraj 覆盖已有文件", async () => {
    const writer = new TraceWriter(testDir, sessionId);
    await writer.writeSessionTraj('{"version": 1}');
    await writer.writeSessionTraj('{"version": 2}');

    const filePath = join(writer.getSessionDir(), "session.traj");
    expect(readFileSync(filePath, "utf-8")).toBe('{"version": 2}');
  });

  test("writeTraj 序列化并写入", async () => {
    const writer = new TraceWriter(testDir, sessionId);
    const traj = { trajectory: [{ action: "test" }], history: [], info: {}, metadata: {} };
    await writer.writeTraj(traj);

    const filePath = join(writer.getSessionDir(), "session.traj");
    const content = readFileSync(filePath, "utf-8");
    expect(JSON.parse(content)).toEqual(traj);
  });

  // ─── raw.jsonl 追加写入 ───

  test("appendRawJsonl 追加写入", () => {
    const writer = new TraceWriter(testDir, sessionId);
    writer.appendRawJsonl('{"index": 1}');
    writer.appendRawJsonl('{"index": 2}');

    const filePath = join(writer.getSessionDir(), "raw.jsonl");
    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ index: 1 });
    expect(JSON.parse(lines[1])).toEqual({ index: 2 });
  });

  test("appendRawJsonl 自动补换行符", () => {
    const writer = new TraceWriter(testDir, sessionId);
    writer.appendRawJsonl('{"a":1}');   // 无换行
    writer.appendRawJsonl('{"b":2}\n'); // 已有换行

    const filePath = join(writer.getSessionDir(), "raw.jsonl");
    const content = readFileSync(filePath, "utf-8");
    // 每行都有且仅有一个换行
    expect(content).toBe('{"a":1}\n{"b":2}\n');
  });

  test("appendRaw 序列化并追加", () => {
    const writer = new TraceWriter(testDir, sessionId);
    const entry: RawJsonlEntry = {
      timestamp: "2026-03-26T10:00:00.000Z",
      index: 1,
      model: "claude-sonnet-4-20250514",
      request: {
        model: "claude-sonnet-4-20250514",
        system: "你是编程助手",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ name: "bash" }],
      },
      response: {
        content: [{ type: "text", text: "你好" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      stop_reason: "end_turn",
      is_partial: false,
    };
    writer.appendRaw(entry);

    const filePath = join(writer.getSessionDir(), "raw.jsonl");
    const parsed = JSON.parse(readFileSync(filePath, "utf-8").trim());
    expect(parsed.index).toBe(1);
    expect(parsed.model).toBe("claude-sonnet-4-20250514");
    expect(parsed.request.system).toBe("你是编程助手");
    expect(parsed.response.stop_reason).toBe("end_turn");
    expect(parsed.stop_reason).toBe("end_turn");
    expect(parsed.is_partial).toBe(false);
  });

  // ─── events.jsonl 追加写入 ───

  test("appendEventsJsonl 追加写入", () => {
    const writer = new TraceWriter(testDir, sessionId);
    writer.appendEventsJsonl('{"event":"SessionStart"}');
    writer.appendEventsJsonl('{"event":"BeforeModel"}');

    const filePath = join(writer.getSessionDir(), "events.jsonl");
    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event).toBe("SessionStart");
    expect(JSON.parse(lines[1]).event).toBe("BeforeModel");
  });

  test("appendEvent 序列化并追加", () => {
    const writer = new TraceWriter(testDir, sessionId);
    const event: HookEvent = {
      event: "SessionStart",
      session_id: "abc123",
      timestamp: "2026-03-26T10:00:00.000Z",
      cwd: "/tmp",
      data: { model: "claude-sonnet-4", source: "startup" },
    };
    writer.appendEvent(event);

    const filePath = join(writer.getSessionDir(), "events.jsonl");
    const parsed = JSON.parse(readFileSync(filePath, "utf-8").trim());
    expect(parsed.event).toBe("SessionStart");
    expect(parsed.session_id).toBe("abc123");
    expect(parsed.data?.model).toBe("claude-sonnet-4");
  });

  // ─── 混合写入 ───

  test("三种文件独立写入互不干扰", async () => {
    const writer = new TraceWriter(testDir, sessionId);

    writer.appendEvent({ event: "SessionStart", session_id: "s1", timestamp: "t1" });
    writer.appendRawJsonl('{"index":1}');
    await writer.writeSessionTraj('{"trajectory":[]}');
    writer.appendEvent({ event: "AfterModel", session_id: "s1", timestamp: "t2" });
    writer.appendRawJsonl('{"index":2}');

    const dir = writer.getSessionDir();

    // events.jsonl: 2 行
    const events = readFileSync(join(dir, "events.jsonl"), "utf-8").trim().split("\n");
    expect(events).toHaveLength(2);

    // raw.jsonl: 2 行
    const raw = readFileSync(join(dir, "raw.jsonl"), "utf-8").trim().split("\n");
    expect(raw).toHaveLength(2);

    // session.traj: JSON 对象
    const traj = JSON.parse(readFileSync(join(dir, "session.traj"), "utf-8"));
    expect(traj.trajectory).toEqual([]);
  });

  // ─── 错误容错 ───

  test("写入失败不抛异常", async () => {
    // 使用一个无效路径（/dev/null 下无法创建子目录）
    const writer = new TraceWriter("/dev/null/impossible", sessionId);

    // 这些操作都不应抛异常
    expect(() => writer.appendEventsJsonl("test")).not.toThrow();
    expect(() => writer.appendRawJsonl("test")).not.toThrow();
    // writeSessionTraj 内部 catch 错误，不会 reject
    expect(async () => await writer.writeSessionTraj("test")).not.toThrow();
  });
});
