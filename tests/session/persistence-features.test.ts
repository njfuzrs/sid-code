/**
 * 状态持久化新特性测试
 * P1-4a: appendCompact 回写
 * P1-4b: agent_setting 持久化与恢复
 * P1-6: parseSessionJsonlLines 与流式读取
 * P1-7: file_changes 持久化
 * P2-10: 子代理 sidechain 持久化
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SessionStore, parseSessionJsonl, parseSessionJsonlLines, currentProjectSessionDir } from "../../src/session/store.ts";
import { SidechainWriter, scanUnfinishedSidechains, cleanupSidechains } from "../../src/session/sidechain.ts";
import { join } from "path";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";

describe("状态持久化新特性", () => {
  let testDir: string;
  let origConfigDir: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `sid-code-persist-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, ".sid-code", "sessions"), { recursive: true });
    origConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = join(testDir, ".sid-code");
  });

  afterEach(() => {
    if (origConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = origConfigDir;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  // ─── P1-4a: appendCompact ───

  test("P1-4a: appendCompact 写入 context_compact 记录，可被 load 解析", async () => {
    const store = new SessionStore();
    store.startSession("compact-001", "m", "p", "/cwd");
    store.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }] });
    store.appendCompact("这是摘要", 5);
    SessionStore.flushPendingWrites();

    const loaded = await store.load("compact-001");
    expect(loaded).not.toBeNull();
    // compact 记录不生成 messages，但落盘了（不丢失不报错）
    expect(loaded!.messages.length).toBe(1);
  });

  // ─── P1-4b: agent_setting 持久化 ───

  test("P1-4b: appendMetadata('agent_setting',...) 可被 load 恢复", async () => {
    const store = new SessionStore();
    store.startSession("setting-001", "gpt-4", "openai", "/cwd");
    store.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }] });
    store.appendMetadata("agent_setting", {
      model: "claude-sonnet",
      effortLevel: "high",
      thinking: "on",
    });
    SessionStore.flushPendingWrites();

    const loaded = await store.load("setting-001");
    expect(loaded).not.toBeNull();
    const setting = loaded!.metadata?.["agent_setting"] as any;
    expect(setting.model).toBe("claude-sonnet");
    expect(setting.effortLevel).toBe("high");
    expect(setting.thinking).toBe("on");
  });

  test("P1-4b: 多次 appendMetadata 同 key 后取最后一条（覆盖语义）", async () => {
    const store = new SessionStore();
    store.startSession("setting-002", "m", "p", "/cwd");
    store.appendMetadata("agent_setting", { model: "a", effortLevel: null, thinking: null });
    store.appendMetadata("agent_setting", { model: "b", effortLevel: "max", thinking: null });
    SessionStore.flushPendingWrites();

    const loaded = await store.load("setting-002");
    const setting = loaded!.metadata?.["agent_setting"] as any;
    expect(setting.model).toBe("b");
    expect(setting.effortLevel).toBe("max");
  });

  // ─── P1-6: parseSessionJsonlLines ───

  test("P1-6: parseSessionJsonlLines 与 parseSessionJsonl 结果一致", () => {
    const store = new SessionStore();
    store.startSession("lines-001", "model", "provider", "/cwd");
    store.appendMessage({ role: "user", content: [{ type: "text", text: "Q1" }] });
    store.appendMessage({ role: "assistant", content: [{ type: "text", text: "A1" }] });
    SessionStore.flushPendingWrites();

    // 读取原始文件内容（P0-1：会话已按项目分目录，读实际项目目录）
    const sessDir = currentProjectSessionDir();
    const files = require("fs").readdirSync(sessDir).filter((f: string) => f.includes("lines-001"));
    expect(files.length).toBe(1);
    const content = readFileSync(join(sessDir, files[0]), "utf-8");

    // 两种解析方式结果应完全一致
    const fromContent = parseSessionJsonl(content);
    const lines = content.trim().split("\n").filter(Boolean);
    const fromLines = parseSessionJsonlLines(lines);

    expect(fromContent).not.toBeNull();
    expect(fromLines).not.toBeNull();
    expect(fromLines!.messages.length).toBe(fromContent!.messages.length);
    expect(fromLines!.id).toBe(fromContent!.id);
    expect(fromLines!.model).toBe(fromContent!.model);
  });

  test("P1-6: parseSessionJsonlLines 空数组返回 null", () => {
    expect(parseSessionJsonlLines([])).toBeNull();
  });

  test("P1-6: 超阈值大文件走流式读取，结果与整读一致（含链重建）", async () => {
    // 写入一个超过 4MB 阈值的会话：用大文本消息快速堆到阈值以上。
    const store = new SessionStore();
    store.startSession("big-001", "model", "provider", "/cwd");
    const bigText = "x".repeat(50 * 1024); // 每条 ~50KB
    const N = 100; // ~5MB，超过 4MB 阈值
    for (let i = 0; i < N; i++) {
      store.appendMessage({ role: "user", content: [{ type: "text", text: `${i}:${bigText}` }] });
    }
    SessionStore.flushPendingWrites();

    // load 会走 loadFromJsonl → 大文件流式路径
    const loaded = await store.load("big-001");
    expect(loaded).not.toBeNull();
    expect(loaded!.messages.length).toBe(N);
    // 验证顺序正确（链重建保序）：首尾消息内容对得上
    expect((loaded!.messages[0].content[0] as any).text.startsWith("0:")).toBe(true);
    expect((loaded!.messages[N - 1].content[0] as any).text.startsWith(`${N - 1}:`)).toBe(true);
  });

  // ─── P1-7: file_changes 持久化 ───

  test("P1-7: appendMetadata('file_changes',...) 落盘并恢复文件列表", async () => {
    const store = new SessionStore();
    store.startSession("fc-001", "m", "p", "/cwd");
    store.appendMetadata("file_changes", {
      files: ["/src/app.ts", "/src/utils.ts"],
      lastTool: "edit",
      count: 2,
    });
    SessionStore.flushPendingWrites();

    const loaded = await store.load("fc-001");
    const fc = loaded!.metadata?.["file_changes"] as any;
    expect(fc.files).toEqual(["/src/app.ts", "/src/utils.ts"]);
    expect(fc.count).toBe(2);
  });

  // P2-1 补齐：file_changes 带 snapshotId 锚点。此前只有文件名，resume 后拿不到
  // 「这批改动对应哪个快照」，跨会话无法把文件集反查回可回退的快照。
  test("P2-1: file_changes 携带 lastSnapshotId + snapshotIds 锚点，覆盖式取最后一条", async () => {
    const store = new SessionStore();
    store.startSession("fc-002", "m", "p", "/cwd");
    // 第一轮改动
    store.appendMetadata("file_changes", {
      files: ["/src/a.ts"],
      lastTool: "edit",
      count: 1,
      lastSnapshotId: "s1",
      snapshotIds: ["s1"],
    });
    // 第二轮改动（覆盖式：累积集合 + 累积快照序列）
    store.appendMetadata("file_changes", {
      files: ["/src/a.ts", "/src/b.ts"],
      lastTool: "bash",
      count: 2,
      lastSnapshotId: "s2",
      snapshotIds: ["s1", "s2"],
    });
    SessionStore.flushPendingWrites();

    const loaded = await store.load("fc-002");
    const fc = loaded!.metadata?.["file_changes"] as any;
    // 覆盖语义：取最后一条即完整集合
    expect(fc.files).toEqual(["/src/a.ts", "/src/b.ts"]);
    expect(fc.lastSnapshotId).toBe("s2");
    // 快照序列保序累积，resume 后可据此把文件集反查回任一历史快照
    expect(fc.snapshotIds).toEqual(["s1", "s2"]);
  });

  test("P2-1: 无快照时不写 snapshotId 字段（旧记录/未启用 checkpoint 场景兼容）", async () => {
    const store = new SessionStore();
    store.startSession("fc-003", "m", "p", "/cwd");
    store.appendMetadata("file_changes", { files: ["/src/a.ts"], lastTool: "edit", count: 1 });
    SessionStore.flushPendingWrites();

    const loaded = await store.load("fc-003");
    const fc = loaded!.metadata?.["file_changes"] as any;
    expect(fc.files).toEqual(["/src/a.ts"]);
    expect(fc.lastSnapshotId).toBeUndefined();
    expect(fc.snapshotIds).toBeUndefined();
  });

  // ─── P2-10: 子代理 sidechain ───

  test("P2-10: SidechainWriter 写入 start + messages + end", () => {
    const writer = new SidechainWriter("sess-001", "agent-abc");
    writer.start("explore", "搜索文件", "claude-sonnet");
    writer.appendMessage("user", [{ type: "text", text: "find files" }], 1);
    writer.appendMessage("assistant", [{ type: "text", text: "found 3 files" }], 1);
    writer.end("completed");

    const content = readFileSync(writer.getFilePath(), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(4);

    const start = JSON.parse(lines[0]);
    expect(start.type).toBe("sidechain_start");
    expect(start.sessionId).toBe("sess-001");
    expect(start.agentId).toBe("agent-abc");
    expect(start.agentType).toBe("explore");

    const end = JSON.parse(lines[3]);
    expect(end.type).toBe("sidechain_end");
    expect(end.status).toBe("completed");
  });

  test("P2-10: SidechainWriter.end 幂等——重复调用不重复写", () => {
    const writer = new SidechainWriter("sess-002", "agent-x");
    writer.start("task", "do stuff", "model");
    writer.end("failed");
    writer.end("completed"); // 二次调用应被忽略

    const lines = readFileSync(writer.getFilePath(), "utf-8").trim().split("\n");
    const endRecords = lines.filter((l) => JSON.parse(l).type === "sidechain_end");
    expect(endRecords.length).toBe(1);
    expect(JSON.parse(endRecords[0]).status).toBe("failed");
  });

  test("P2-10: SidechainWriter.appendMessage 在 end 后不写", () => {
    const writer = new SidechainWriter("sess-003", "agent-y");
    writer.start("task", "desc", "model");
    writer.end("aborted");
    writer.appendMessage("assistant", [{ type: "text", text: "late msg" }], 5);

    const lines = readFileSync(writer.getFilePath(), "utf-8").trim().split("\n");
    // 只有 start + end = 2 行（appendMessage 被忽略）
    expect(lines.length).toBe(2);
  });

  test("P2-10: scanUnfinishedSidechains 返回无 sidechain_end 的子代理", () => {
    // 创建一个完成的和一个未完成的
    const w1 = new SidechainWriter("scan-sess", "agent-done");
    w1.start("explore", "搜索完毕", "model");
    w1.appendMessage("assistant", [{ type: "text", text: "done" }], 1);
    w1.end("completed");

    const w2 = new SidechainWriter("scan-sess", "agent-interrupted");
    w2.start("task", "大任务被中断", "model");
    w2.appendMessage("user", [{ type: "text", text: "do task" }], 1);
    w2.appendMessage("assistant", [{ type: "text", text: "working..." }], 1);
    // 不调 end，模拟中断

    const unfinished = scanUnfinishedSidechains("scan-sess");
    expect(unfinished.length).toBe(1);
    expect(unfinished[0].agentId).toBe("agent-interrupted");
    expect(unfinished[0].agentType).toBe("task");
    expect(unfinished[0].description).toBe("大任务被中断");
    expect(unfinished[0].messageCount).toBe(2);
  });

  test("P2-10: scanUnfinishedSidechains 不匹配其他会话", () => {
    const w = new SidechainWriter("other-sess", "agent-z");
    w.start("task", "other", "model");
    // 不 end

    const unfinished = scanUnfinishedSidechains("scan-sess-nope");
    expect(unfinished.length).toBe(0);
  });

  test("P2-10: cleanupSidechains 删除指定会话的所有 sidechain 文件", () => {
    const w1 = new SidechainWriter("cleanup-sess", "a1");
    w1.start("t", "d", "m");
    const w2 = new SidechainWriter("cleanup-sess", "a2");
    w2.start("t", "d", "m");

    expect(existsSync(w1.getFilePath())).toBe(true);
    expect(existsSync(w2.getFilePath())).toBe(true);

    const removed = cleanupSidechains("cleanup-sess");
    expect(removed).toBe(2);
    expect(existsSync(w1.getFilePath())).toBe(false);
    expect(existsSync(w2.getFilePath())).toBe(false);
  });
});
