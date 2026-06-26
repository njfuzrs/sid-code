/**
 * 会话存储测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SessionStore } from "../../src/session/store.ts";
import { parseSessionJsonl } from "../../src/session/store.ts";
import type { SessionData } from "../../src/session/store.ts";
import { join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";

describe("SessionStore", () => {
  let testDir: string;
  let origHome: string | undefined;
  let origConfigDir: string | undefined;

  beforeEach(() => {
    // 使用临时目录避免污染用户目录
    testDir = join(tmpdir(), `sid-code-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, ".sid-code", "sessions"), { recursive: true });
    origHome = process.env.HOME;
    process.env.HOME = testDir;
    // store.ts 已改走 sidPaths → getSidHome()，后者只认 SID_CONFIG_DIR（不认 HOME）。
    // 必须同时设置 SID_CONFIG_DIR 指向临时目录，否则会读到真实 ~/.sid-code/sessions。
    origConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = join(testDir, ".sid-code");
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (origConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = origConfigDir;
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  test("保存和加载会话", async () => {
    const store = new SessionStore();
    const session: SessionData = {
      id: "test-001",
      model: "claude-sonnet-4-20250514",
      provider: "anthropic",
      messages: [
        { role: "user", content: [{ type: "text", text: "你好" }] },
        { role: "assistant", content: [{ type: "text", text: "你好！" }] },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await store.save(session);
    const loaded = await store.load("test-001");

    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("test-001");
    expect(loaded!.messages.length).toBe(2);
  });

  test("加载不存在的会话返回 null", async () => {
    const store = new SessionStore();
    const loaded = await store.load("nonexistent");
    expect(loaded).toBeNull();
  });

  test("生成会话 ID", () => {
    const id = SessionStore.generateId();
    // 新格式：YYYYMMDD-HHMMSS-<8位hex>，可排序 + 抗碰撞（见 session/id.ts）
    expect(id).toMatch(/^\d{8}-\d{6}-[0-9a-f]{8}$/);
    expect(id.length).toBe(24);
  });

  test("列出会话", async () => {
    const store = new SessionStore();

    await store.save({
      id: "s1",
      model: "test",
      provider: "test",
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await store.save({
      id: "s2",
      model: "test",
      provider: "test",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const list = await store.list();
    expect(list.length).toBe(2);
    // 两个会话都应该在列表中
    const ids = list.map((s) => s.id).sort();
    expect(ids).toEqual(["s1", "s2"]);
  });

  // ─── B2：JSONL 增量写入（多轮持久化）───

  test("B2: startSession + 多轮 appendMessage 增量写入后可完整 load", async () => {
    const store = new SessionStore();
    store.startSession("jsonl-001", "test-model", "anthropic", "/tmp/cwd");
    // 第 1 轮
    store.appendMessage({ role: "user", content: [{ type: "text", text: "Q1" }] });
    store.appendMessage({ role: "assistant", content: [{ type: "text", text: "A1" }] });
    // 第 2 轮（验证 bug① 已修：第 2 轮起不应丢消息）
    store.appendMessage({ role: "user", content: [{ type: "text", text: "Q2" }] });
    store.appendMessage({ role: "assistant", content: [{ type: "text", text: "A2" }] });

    const loaded = await store.load("jsonl-001");
    expect(loaded).not.toBeNull();
    expect(loaded!.messages.length).toBe(4);
    expect(loaded!.model).toBe("test-model");
    expect((loaded!.messages[3].content[0] as any).text).toBe("A2");
  });

  test("B2: tool_result（role=user）增量写入并正确归类", async () => {
    const store = new SessionStore();
    store.startSession("jsonl-tool", "m", "p", "/cwd");
    store.appendMessage({ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] });
    store.appendMessage({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }] });

    const loaded = await store.load("jsonl-tool");
    expect(loaded!.messages.length).toBe(2);
    expect((loaded!.messages[1].content[0] as any).type).toBe("tool_result");
  });

  // ─── B3：endSession 幂等 ───

  test("B3: endSession 幂等——重复调用不抛错、不破坏已写历史", async () => {
    const store = new SessionStore();
    store.startSession("jsonl-end", "m", "p", "/cwd");
    store.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }] });
    store.endSession(0.01, 1);
    // 再次调用（模拟正常退出后 emergency 又调一次）→ 安全 no-op
    expect(() => store.endSession(0.02, 1)).not.toThrow();
    // endSession 后 currentFile=null，后续 append 静默丢弃（不应再写入）
    store.appendMessage({ role: "user", content: [{ type: "text", text: "after-end" }] });

    const loaded = await store.load("jsonl-end");
    expect(loaded!.messages.length).toBe(1);
    expect((loaded!.messages[0].content[0] as any).text).toBe("hi");
  });

  // ─── B2 方案A：context_compact 不再清空历史 ───

  test("B2方案A: compact 记录退化为纯标记，不清空已写历史", async () => {
    const store = new SessionStore();
    store.startSession("jsonl-compact", "m", "p", "/cwd");
    store.appendMessage({ role: "user", content: [{ type: "text", text: "before-1" }] });
    store.appendMessage({ role: "assistant", content: [{ type: "text", text: "before-2" }] });
    store.appendCompact("摘要内容", 2);
    store.appendMessage({ role: "user", content: [{ type: "text", text: "after-compact" }] });

    const loaded = await store.load("jsonl-compact");
    // 旧实现会清空 → 只剩 1 条占位；修正后应保留全部真实消息（3 条）
    expect(loaded!.messages.length).toBe(3);
    expect((loaded!.messages[0].content[0] as any).text).toBe("before-1");
    expect((loaded!.messages[2].content[0] as any).text).toBe("after-compact");
  });

  // ─── B6：resume 续写原 jsonl ───

  test("B6: resumeSession 续写原 jsonl（不写 session_start、不碎片化）", async () => {
    const store1 = new SessionStore();
    store1.startSession("jsonl-resume", "m", "p", "/cwd");
    store1.appendMessage({ role: "user", content: [{ type: "text", text: "first-session" }] });
    store1.endSession(0.01, 1);

    // 新进程 resume：续写原文件
    const store2 = new SessionStore();
    store2.resumeSession("jsonl-resume", "m", "p", "/cwd");
    store2.appendMessage({ role: "user", content: [{ type: "text", text: "resumed-msg" }] });

    const loaded = await store2.load("jsonl-resume");
    // 原历史 + 续写应都在同一文件里
    expect(loaded!.messages.length).toBe(2);
    expect((loaded!.messages[0].content[0] as any).text).toBe("first-session");
    expect((loaded!.messages[1].content[0] as any).text).toBe("resumed-msg");
  });

  test("B6: resumeSession 对不存在的 jsonl 回退为新建（不丢续写）", async () => {
    const store = new SessionStore();
    // 从未 startSession 过这个 id（模拟旧 JSON 格式恢复）
    store.resumeSession("jsonl-missing", "m", "p", "/cwd");
    store.appendMessage({ role: "user", content: [{ type: "text", text: "x" }] });

    const loaded = await store.load("jsonl-missing");
    expect(loaded).not.toBeNull();
    expect(loaded!.messages.length).toBe(1);
  });

  test("Bug3: resumeSession 传入 traceSessionId 时落 trace_session_id 元数据", async () => {
    const store = new SessionStore();
    store.startSession("old-sess", "m", "p", "/cwd");
    store.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }] });
    // 模拟新进程 resume：本进程 trace id 与旧会话 id 不同
    const store2 = new SessionStore();
    store2.resumeSession("old-sess", "m", "p", "/cwd", "new-trace-id");

    // 直接读原始 jsonl，确认 metadata 记录已写入
    const raw = await Bun.file(
      join(testDir, ".sid-code", "sessions", "old-sess.jsonl")
    ).text();
    expect(raw).toContain("\"type\":\"metadata\"");
    expect(raw).toContain("trace_session_id");
    expect(raw).toContain("new-trace-id");
  });

  test("Bug3: traceSessionId 与会话 id 相同时不写冗余元数据", async () => {
    const store = new SessionStore();
    store.startSession("same-id", "m", "p", "/cwd");
    const store2 = new SessionStore();
    store2.resumeSession("same-id", "m", "p", "/cwd", "same-id");

    const raw = await Bun.file(
      join(testDir, ".sid-code", "sessions", "same-id.jsonl")
    ).text();
    expect(raw).not.toContain("trace_session_id");
  });
});

describe("parseSessionJsonl", () => {
  test("Bug1: 逐行解析多行 jsonl 不抛错（JSON.parse 整体解析会失败）", () => {
    const content = [
      JSON.stringify({ type: "session_start", sessionId: "s1", model: "m", provider: "p", cwd: "/c", timestamp: "2026-01-01T00:00:00Z" }),
      JSON.stringify({ type: "user_message", message: { role: "user", content: [{ type: "text", text: "hi" }] }, timestamp: "2026-01-01T00:00:01Z" }),
      JSON.stringify({ type: "assistant_message", message: { role: "assistant", content: [{ type: "text", text: "yo" }] }, timestamp: "2026-01-01T00:00:02Z" }),
    ].join("\n");

    const data = parseSessionJsonl(content);
    expect(data).not.toBeNull();
    expect(data!.id).toBe("s1");
    expect(data!.messages.length).toBe(2);
    expect(data!.createdAt).toBe("2026-01-01T00:00:00Z");
    expect(data!.updatedAt).toBe("2026-01-01T00:00:02Z");
  });

  test("无 session_start 行返回 null", () => {
    const content = JSON.stringify({ type: "user_message", message: { role: "user", content: [] }, timestamp: "t" });
    expect(parseSessionJsonl(content)).toBeNull();
  });

  test("跳过损坏行，保留可解析记录", () => {
    const content = [
      JSON.stringify({ type: "session_start", sessionId: "s2", model: "m", provider: "p", cwd: "/c", timestamp: "t0" }),
      "{ 这不是合法 json",
      JSON.stringify({ type: "user_message", message: { role: "user", content: [] }, timestamp: "t1" }),
    ].join("\n");
    const data = parseSessionJsonl(content);
    expect(data!.id).toBe("s2");
    expect(data!.messages.length).toBe(1);
  });
});
