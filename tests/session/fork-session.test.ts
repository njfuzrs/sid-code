/**
 * 会话分叉（--fork-session）落盘测试 — P1-G2a / A1
 *
 * 背景：`--fork-session` 此前只把源会话历史注入内存 ctxMgr，新会话 jsonl 从空的
 * session_start 起写。后果：① 新会话在 --list-sessions 里表现为空会话；
 * ② 对新会话再 `-r` 一次只能读到分叉后的增量，源历史彻底丢失（分叉不可再分叉）。
 *
 * 本文件覆盖 SessionStore 侧的分叉落盘契约：
 *  - forkHistoryFrom 把源历史重新盖 uuid 链戳写进新 jsonl，新会话可独立 load 出完整历史；
 *  - 源会话文件不被改动（分叉语义要求）；
 *  - forked_from 溯源锚点 + session_start.parentUuid 双向可查；
 *  - 分叉出的会话可以再次被分叉（历史不衰减）；
 *  - A1：session_start 带 schemaCompat 标注，且经 load 透出。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SessionStore } from "../../src/session/store.ts";
import type { Message } from "../../src/llm/types.ts";
import { join } from "path";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";

/** 读原始 jsonl 行（断言物理落盘内容用）。 */
function readRecords(store: SessionStore): any[] {
  const file = store.getCurrentFile();
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("会话分叉落盘（P1-G2a）", () => {
  let testDir: string;
  let origConfigDir: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `sid-fork-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, ".sid-code", "sessions"), { recursive: true });
    origConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = join(testDir, ".sid-code");
  });

  afterEach(() => {
    if (origConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = origConfigDir;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  /** 造一个有 N 轮对话的源会话，返回其 id。 */
  function seedSource(id: string, turns: number): Message[] {
    const store = new SessionStore();
    store.startSession(id, "m", "p", "/cwd");
    const msgs: Message[] = [];
    for (let i = 0; i < turns; i++) {
      const u: Message = { role: "user", content: [{ type: "text", text: `q${i}` }] };
      const a: Message = { role: "assistant", content: [{ type: "text", text: `a${i}` }] };
      store.appendMessage(u);
      store.appendMessage(a);
      msgs.push(u, a);
    }
    SessionStore.flushPendingWrites();
    return msgs;
  }

  test("分叉后新会话 jsonl 含源历史全量，且可独立 load 出来", async () => {
    const srcMsgs = seedSource("src-001", 3);

    const forked = new SessionStore();
    forked.startSession("fork-001", "m", "p", "/cwd", "src-001");
    const written = forked.forkHistoryFrom("src-001", srcMsgs, forked.readTailUuidOf("src-001"));
    SessionStore.flushPendingWrites();

    expect(written).toBe(6);

    // 关键断言：新会话**独立** load 就能拿到完整历史（不依赖内存 ctxMgr）。
    const loaded = await forked.load("fork-001");
    expect(loaded).not.toBeNull();
    expect(loaded!.messages.length).toBe(6);
    expect(loaded!.messages.map((m) => m.role)).toEqual([
      "user", "assistant", "user", "assistant", "user", "assistant",
    ]);
  });

  test("分叉不改动源会话文件（源仍可原样 load）", async () => {
    const srcMsgs = seedSource("src-002", 2);
    const srcStore = new SessionStore();
    const srcBefore = await srcStore.load("src-002");

    const forked = new SessionStore();
    forked.startSession("fork-002", "m", "p", "/cwd", "src-002");
    forked.forkHistoryFrom("src-002", srcMsgs);
    // 分叉会话继续写自己的新消息
    forked.appendMessage({ role: "user", content: [{ type: "text", text: "分叉后的新输入" }] });
    SessionStore.flushPendingWrites();

    const srcAfter = await srcStore.load("src-002");
    expect(srcAfter!.messages.length).toBe(srcBefore!.messages.length);
    expect(srcAfter!.messages.length).toBe(4);
    // 分叉侧多了一条，源侧没有
    const forkedLoaded = await forked.load("fork-002");
    expect(forkedLoaded!.messages.length).toBe(5);
  });

  test("溯源双锚点：session_start.parentUuid=源 id + forked_from metadata", async () => {
    const srcMsgs = seedSource("src-003", 1);

    const forked = new SessionStore();
    forked.startSession("fork-003", "m", "p", "/cwd", "src-003");
    forked.forkHistoryFrom("src-003", srcMsgs, forked.readTailUuidOf("src-003"));
    SessionStore.flushPendingWrites();

    const records = readRecords(forked);
    const start = records.find((r) => r.type === "session_start");
    expect(start.parentUuid).toBe("src-003");

    const loaded = await forked.load("fork-003");
    const anchor = loaded!.metadata?.["forked_from"] as any;
    expect(anchor?.sessionId).toBe("src-003");
    expect(anchor?.messageCount).toBe(2);
    // 源链尾 uuid 应被解析到（源是本项目内的 jsonl）
    expect(typeof anchor?.uuid).toBe("string");
    expect(anchor.uuid.length).toBeGreaterThan(0);
  });

  test("重新盖戳：新 jsonl 的 uuid 与源完全不复用，且自成一条完整链", async () => {
    const srcMsgs = seedSource("src-004", 2);

    const forked = new SessionStore();
    forked.startSession("fork-004", "m", "p", "/cwd", "src-004");
    forked.forkHistoryFrom("src-004", srcMsgs);
    SessionStore.flushPendingWrites();

    const records = readRecords(forked);
    expect(records[0].type).toBe("session_start");
    // session_start.parentUuid 是**源 session id**（跨文件溯源锚点，不是链内 uuid），
    // 故它不参与链连续性校验——链从 session_start.uuid 起算。
    expect(records[0].parentUuid).toBe("src-004");

    // 链自洽：session_start 之后每条的 parentUuid 都指向前面已出现过的某条记录的 uuid。
    const seen = new Set<string>([records[0].uuid]);
    for (const r of records.slice(1)) {
      expect(typeof r.uuid).toBe("string");
      expect(seen.has(r.parentUuid)).toBe(true);
      seen.add(r.uuid);
    }

    // 重新盖戳：新文件里的 uuid 与源文件的 uuid 集合**零交集**（不复用源 uuid）。
    const srcFileRecords = readFileSync(
      join((await import("../../src/session/store.ts")).currentProjectSessionDir(), "src-004.jsonl"),
      "utf-8",
    ).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const srcUuids = new Set<string>(srcFileRecords.map((r: any) => r.uuid));
    for (const u of seen) expect(srcUuids.has(u)).toBe(false);
  });

  test("分叉可再分叉：二次分叉仍拿到完整历史（不衰减）", async () => {
    const srcMsgs = seedSource("src-005", 2);

    const fork1 = new SessionStore();
    fork1.startSession("fork-005a", "m", "p", "/cwd", "src-005");
    fork1.forkHistoryFrom("src-005", srcMsgs);
    fork1.appendMessage({ role: "user", content: [{ type: "text", text: "一代新增" }] });
    SessionStore.flushPendingWrites();

    const gen1 = await fork1.load("fork-005a");
    expect(gen1!.messages.length).toBe(5);

    // 二次分叉：以 fork-005a 的历史为源
    const fork2 = new SessionStore();
    fork2.startSession("fork-005b", "m", "p", "/cwd", "fork-005a");
    fork2.forkHistoryFrom("fork-005a", gen1!.messages);
    SessionStore.flushPendingWrites();

    const gen2 = await fork2.load("fork-005b");
    expect(gen2!.messages.length).toBe(5); // 完整继承，未衰减
  });

  test("空历史分叉：不写消息但仍落溯源锚点，返回 0", async () => {
    const forked = new SessionStore();
    forked.startSession("fork-006", "m", "p", "/cwd", "src-none");
    const n = forked.forkHistoryFrom("src-none", []);
    SessionStore.flushPendingWrites();

    expect(n).toBe(0);
    const loaded = await forked.load("fork-006");
    expect((loaded!.metadata?.["forked_from"] as any)?.messageCount).toBe(0);
    expect(loaded!.messages.length).toBe(0);
  });

  test("readTailUuidOf 对不存在会话返回 null（降级为不带 uuid 的锚点）", () => {
    const store = new SessionStore();
    store.startSession("fork-007", "m", "p", "/cwd");
    expect(store.readTailUuidOf("完全不存在的会话-id")).toBeNull();
  });
});

describe("A1：schemaCompat 布局兼容标注", () => {
  let testDir: string;
  let origConfigDir: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `sid-schema-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, ".sid-code", "sessions"), { recursive: true });
    origConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = join(testDir, ".sid-code");
  });

  afterEach(() => {
    if (origConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = origConfigDir;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("新会话 session_start 写入 schemaCompat，且 load 后透出", async () => {
    const store = new SessionStore();
    store.startSession("schema-001", "m", "p", "/cwd");
    store.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }] });
    SessionStore.flushPendingWrites();

    const records = readRecords(store);
    const start = records.find((r) => r.type === "session_start");
    expect(start.schemaCompat).toBe("claude-code-like/v3");

    const loaded = await store.load("schema-001");
    expect(loaded!.schemaCompat).toBe("claude-code-like/v3");
  });

  test("旧文件无 schemaCompat 字段 → 解析为 undefined，不臆造值也不报错", async () => {
    // 手写一份不带 schemaCompat 的 v3 jsonl（模拟本次改动之前落的文件）
    const dir = join(testDir, ".sid-code", "sessions");
    const { currentProjectSessionDir } = await import("../../src/session/store.ts");
    const projDir = currentProjectSessionDir();
    mkdirSync(projDir, { recursive: true });
    void dir;
    const u1 = crypto.randomUUID();
    const u2 = crypto.randomUUID();
    const lines = [
      JSON.stringify({
        type: "session_start", version: "3.0", sessionId: "legacy-001",
        model: "m", provider: "p", cwd: "/cwd",
        timestamp: new Date(0).toISOString(), uuid: u1, parentUuid: null,
      }),
      JSON.stringify({
        type: "user_message",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
        timestamp: new Date(0).toISOString(), uuid: u2, parentUuid: u1,
      }),
    ];
    await Bun.write(join(projDir, "legacy-001.jsonl"), lines.join("\n") + "\n");

    const store = new SessionStore();
    const loaded = await store.load("legacy-001");
    expect(loaded).not.toBeNull();
    expect(loaded!.schemaCompat).toBeUndefined();
    expect(loaded!.messages.length).toBe(1); // 解析不受影响
  });
});
