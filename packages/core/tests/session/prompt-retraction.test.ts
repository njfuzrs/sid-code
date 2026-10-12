/**
 * 撤回未送达模型的用户输入（ESC 回填修复）——持久化 / 内存历史 / 回退点三处一致性
 *
 * - SessionStore.appendPromptRetraction：落撤回标记，resume 时被撤回的消息不再出现
 *   （否则 `-c` 后会把一条模型从未回应的 user 消息与下一条合并发给模型）。
 * - ContextManager.restoreToPrefix：按快照恢复，正确处理「本轮 user 被合并进上一条」。
 * - RewindManager.dropPoint：撤回的轮次不再出现在 Esc+Esc 面板。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SessionStore, parseSessionJsonl } from "@sid-code/core/session/store.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { RewindManager } from "@sid-code/core/session/rewind-manager.ts";
import type { Message } from "@sid-code/core/llm/types.ts";
import { join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const asst = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }] });

describe("SessionStore.appendPromptRetraction", () => {
  let testDir: string;
  let origHome: string | undefined;
  let origConfigDir: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `sid-retract-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, ".sid-code", "sessions"), { recursive: true });
    origHome = process.env.HOME;
    process.env.HOME = testDir;
    origConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = join(testDir, ".sid-code");
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (origConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = origConfigDir;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("撤回后 load 不再包含被撤回的 user 消息", async () => {
    const store = new SessionStore();
    store.startSession("retract-1", "m", "p", "/cwd");
    store.appendMessage(user("Q1"));
    store.appendMessage(asst("A1"));
    const since = store.getMessageRecordCount();
    store.appendMessage(user("被限流的那句"));
    expect(store.appendPromptRetraction(since)).toBe(1);

    const loaded = await store.load("retract-1");
    expect(loaded!.messages.map((m) => (m.content[0] as any).text)).toEqual(["Q1", "A1"]);
  });

  test("撤回后继续对话，新消息正常保留", async () => {
    const store = new SessionStore();
    store.startSession("retract-2", "m", "p", "/cwd");
    store.appendMessage(user("Q1"));
    store.appendMessage(asst("A1"));
    const since = store.getMessageRecordCount();
    store.appendMessage(user("撤回"));
    store.appendPromptRetraction(since);
    store.appendMessage(user("重发"));
    store.appendMessage(asst("A2"));

    const loaded = await store.load("retract-2");
    expect(loaded!.messages.map((m) => (m.content[0] as any).text)).toEqual([
      "Q1",
      "A1",
      "重发",
      "A2",
    ]);
  });

  test("本轮没有落盘任何消息 → 不写记录，返回 0", () => {
    const store = new SessionStore();
    store.startSession("retract-3", "m", "p", "/cwd");
    store.appendMessage(user("Q1"));
    const since = store.getMessageRecordCount();
    expect(store.appendPromptRetraction(since)).toBe(0);
  });

  test("dropCount 坏数据被夹到合法范围，不越界", () => {
    const lines = [
      JSON.stringify({
        type: "session_start",
        sessionId: "s",
        model: "m",
        provider: "p",
        cwd: "/",
        timestamp: "t",
      }),
      JSON.stringify({ type: "user_message", message: user("Q1"), timestamp: "t" }),
      JSON.stringify({ type: "prompt_retracted", dropCount: 99, timestamp: "t" }),
      JSON.stringify({ type: "user_message", message: user("Q2"), timestamp: "t" }),
      JSON.stringify({ type: "prompt_retracted", dropCount: -3, timestamp: "t" }),
    ].join("\n");
    const data = parseSessionJsonl(lines);
    expect(data!.messages.map((m) => (m.content[0] as any).text)).toEqual(["Q2"]);
  });
});

describe("ContextManager.restoreToPrefix", () => {
  test("前缀未变：只截掉本轮新增的消息", () => {
    const ctx = new ContextManager({ maxTokens: 100_000 });
    ctx.addMessage(user("Q1"));
    ctx.addMessage(asst("A1"));
    const snap = ctx.getMessages();
    ctx.addMessage(user("Q2"));
    expect(ctx.restoreToPrefix(snap)).toBe(1);
    expect(ctx.getMessages()).toEqual(snap);
  });

  test("本轮 user 被合并进上一条 user（上一轮以 tool_result 收尾）：恢复后上一轮的 tool_result 仍在", () => {
    const ctx = new ContextManager({ maxTokens: 100_000 });
    ctx.addMessage(user("Q1"));
    ctx.addMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }],
    });
    ctx.addMessage({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }],
    });
    const snap = ctx.getMessages();
    // 新输入与上一条 tool_result 同为 user → 被合并
    ctx.addMessage(user("Q2"));
    expect(ctx.getMessages().length).toBe(snap.length);

    ctx.restoreToPrefix(snap);
    const last = ctx.getMessages().at(-1)!;
    expect(last.content).toHaveLength(1);
    expect(last.content[0].type).toBe("tool_result");
    // 对照：旧实现 rewindTurns(1) 会把整条 tool_result 消息一起删掉
  });
});

describe("RewindManager.dropPoint", () => {
  test("撤回轮次的回退点被移除，其它点保留", () => {
    const msgs: unknown[] = [];
    const mgr = new RewindManager({
      getMessages: () => msgs,
      setMessages: () => {},
      restoreToSnapshot: async () => null,
    });
    const p1 = mgr.registerPoint("轮1", 1);
    const p2 = mgr.registerPoint("被撤回", 2);
    mgr.dropPoint(p2.id);
    expect(mgr.listPoints().map((p) => p.id)).toEqual([p1.id]);
    mgr.dropPoint(999); // 不存在：静默
    expect(mgr.listPoints()).toHaveLength(1);
  });
});
