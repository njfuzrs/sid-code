/**
 * TraceCollector 单元测试
 * 验证 hook 事件序列 → pairs 配对、增量 messages、metadata 填充
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { TraceCollector } from "../../src/trace/collector.ts";
import { HookSystem } from "../../src/hook/system.ts";
import { existsSync, readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── 测试辅助 ───

function makeBaseInput(_sessionId = "sess-001", _cwd = "/tmp/test") {
  return { session_id: _sessionId, cwd: _cwd, timestamp: new Date().toISOString(), permission_mode: "default" };
}

/** 触发 SessionStart */
async function fireSessionStart(hookSystem: HookSystem, sessionId = "sess-001") {
  await hookSystem.fireSessionStartEvent("startup", { model: "claude-test" });
  // 手动设置 session_id（event-handler 内部会用自己的 session_id）
  hookSystem.setSessionId(sessionId);
  hookSystem.setCwd("/tmp/test");
}

/** 触发完整的 BeforeModel + AfterModel 对 */
async function fireModelRound(
  hookSystem: HookSystem,
  opts: {
    messages?: unknown[];
    system?: unknown;
    tools?: unknown[];
    contentBlocks?: unknown[];
    stopReason?: string;
    thinking_blocks?: unknown[];
    inputTokens?: number;
    outputTokens?: number;
    cacheRead?: number;
    cacheCreate?: number;
  } = {},
) {
  const messages = opts.messages ?? [{ role: "user", content: "hello" }];
  const contentBlocks = opts.contentBlocks ?? [{ type: "text", text: "回答" }];

  await hookSystem.fireBeforeModelEvent({
    model: "claude-test",
    messages: (messages as any[]).map(m => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    })),
    raw_messages: messages,
    system: opts.system,
    tools: opts.tools,
  });

  await hookSystem.fireAfterModelEvent(
    {
      model: "claude-test",
      messages: [],
      raw_messages: messages,
      system: opts.system,
    },
    {
      content_blocks: contentBlocks,
      stop_reason: opts.stopReason ?? "end_turn",
      thinking_blocks: opts.thinking_blocks as any,
      usage: {
        inputTokens: opts.inputTokens ?? 100,
        outputTokens: opts.outputTokens ?? 50,
        cacheReadInputTokens: opts.cacheRead ?? 0,
        cacheCreationInputTokens: opts.cacheCreate ?? 0,
      },
    },
  );
}

// ─── 测试套件 ───

describe("TraceCollector", () => {
  let testDir: string;
  let hookSystem: HookSystem;
  let collector: TraceCollector;

  beforeEach(() => {
    testDir = join(tmpdir(), `trace-collector-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });

    hookSystem = new HookSystem();
    hookSystem.setSessionId("sess-001");
    hookSystem.setCwd("/tmp/test");

    collector = new TraceCollector({ outputDir: testDir });
    collector.registerHooks(hookSystem);
  });

  // afterEach cleanup 可选，tmpdir 会自动清理

  // ─── 基础初始化 ───

  test("SessionStart 初始化 metadata", async () => {
    await fireSessionStart(hookSystem);
    const meta = collector.getMetadata();
    expect(meta).toBeDefined();
    expect(meta!.working_directory).toBe("/tmp/test");
    expect(meta!.tools_used.size).toBe(0);
    expect(meta!.has_thinking).toBe(false);
  });

  test("SessionStart 前 getMetadata 返回 undefined", () => {
    expect(collector.getMetadata()).toBeUndefined();
  });

  test("SessionStart 创建 writer，后续事件写入 events.jsonl", async () => {
    await fireSessionStart(hookSystem);
    const eventsPath = join(testDir, "sessions", "sess-001", "events.jsonl");
    expect(existsSync(eventsPath)).toBe(true);

    const lines = readFileSync(eventsPath, "utf-8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const first = JSON.parse(lines[0]);
    expect(first.event).toBe("SessionStart");
  });

  // ─── BeforeModel + AfterModel 配对 ───

  test("一轮 BeforeModel + AfterModel 生成一个 pair", async () => {
    await fireSessionStart(hookSystem);
    await fireModelRound(hookSystem);

    expect(collector.getPairs()).toHaveLength(1);
    const pair = collector.getPairs()[0];
    expect(pair.index).toBe(1);
    expect(pair.stop_reason).toBe("end_turn");
    expect(pair.response.content).toHaveLength(1);
  });

  test("两轮 model 生成两个 pair", async () => {
    await fireSessionStart(hookSystem);
    await fireModelRound(hookSystem);
    await fireModelRound(hookSystem, { stopReason: "tool_use" });

    expect(collector.getPairs()).toHaveLength(2);
    expect(collector.getPairs()[0].index).toBe(1);
    expect(collector.getPairs()[1].index).toBe(2);
    expect(collector.getPairs()[1].stop_reason).toBe("tool_use");
  });

  test("AfterModel 后 raw.jsonl 追加一行", async () => {
    await fireSessionStart(hookSystem);
    await fireModelRound(hookSystem);

    const rawPath = join(testDir, "sessions", "sess-001", "raw.jsonl");
    expect(existsSync(rawPath)).toBe(true);
    const line = JSON.parse(readFileSync(rawPath, "utf-8").trim());
    expect(line.index).toBe(1);
    expect(line.stop_reason).toBe("end_turn");
    // raw.jsonl 中不应包含 raw_messages 字段
    expect(line.request.raw_messages).toBeUndefined();
  });

  test("AfterModel 后 session.traj 被写入", async () => {
    await fireSessionStart(hookSystem);
    await fireModelRound(hookSystem);

    const trajPath = join(testDir, "sessions", "sess-001", "session.traj");
    expect(existsSync(trajPath)).toBe(true);
    const traj = JSON.parse(readFileSync(trajPath, "utf-8"));
    expect(traj).toHaveProperty("trajectory");
    expect(traj).toHaveProperty("history");
    expect(traj).toHaveProperty("info");
    expect(traj).toHaveProperty("metadata");
  });

  // ─── 首次请求保存 system/tools ───

  test("首次请求保存 system 和 tools 到 pair.request", async () => {
    await fireSessionStart(hookSystem);
    await fireModelRound(hookSystem, {
      system: "你是助手",
      tools: [{ name: "bash" }],
    });

    const pair = collector.getPairs()[0];
    expect(pair.request.system).toBe("你是助手");
    expect(pair.request.tools).toHaveLength(1);
  });

  test("后续请求不保存 system 和 tools", async () => {
    await fireSessionStart(hookSystem);
    await fireModelRound(hookSystem, { system: "你是助手", tools: [{ name: "bash" }] });
    await fireModelRound(hookSystem, { system: "你是助手", tools: [{ name: "bash" }] });

    const pair2 = collector.getPairs()[1];
    expect(pair2.request.system).toBeUndefined();
    expect(pair2.request.tools).toBeUndefined();
  });

  test("首次请求的 metadata.system_prompt 从 system 提取", async () => {
    await fireSessionStart(hookSystem);
    await fireModelRound(hookSystem, { system: "系统提示词内容" });

    const meta = collector.getMetadata()!;
    expect(meta.system_prompt).toBe("系统提示词内容");
    expect(meta.system_prompt_hash).toHaveLength(32); // MD5
  });

  // ─── 增量 messages 计算 ───

  test("首次请求 new_messages = 全部 messages", async () => {
    await fireSessionStart(hookSystem);
    const messages = [{ role: "user", content: "hello" }];
    await fireModelRound(hookSystem, { messages });

    const pair = collector.getPairs()[0];
    expect(pair.request.new_messages).toHaveLength(1);
    expect(collector.getPrevMessageCount()).toBe(1);
  });

  test("第二次请求 new_messages 只含新增部分", async () => {
    await fireSessionStart(hookSystem);

    // 第一次：1 条 message
    const msgs1 = [{ role: "user", content: "第一个问题" }];
    await fireModelRound(hookSystem, { messages: msgs1 });

    // 第二次：3 条 messages（增加了 2 条）
    const msgs2 = [
      { role: "user", content: "第一个问题" },
      { role: "assistant", content: [{ type: "text", text: "回答" }] },
      { role: "user", content: "第二个问题" },
    ];
    await fireModelRound(hookSystem, { messages: msgs2 });

    const pair2 = collector.getPairs()[1];
    expect(pair2.request.new_messages).toHaveLength(2);
    expect((pair2.request.new_messages![0] as any).role).toBe("assistant");
    expect((pair2.request.new_messages![1] as any).role).toBe("user");
    expect(collector.getPrevMessageCount()).toBe(3);
  });

  test("压缩后 messages 减少时视为全量（重置增量）", async () => {
    await fireSessionStart(hookSystem);

    // 第一次：3 条
    const msgs1 = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ];
    await fireModelRound(hookSystem, { messages: msgs1 });
    expect(collector.getPrevMessageCount()).toBe(3);

    // 模拟压缩：只剩 1 条（触发 PreCompact 重置）
    await hookSystem.firePreCompactEvent("auto");
    // PreCompact 会重置 prevMessageCount = 0

    const msgsAfterCompact = [{ role: "user", content: "压缩后首条" }];
    await fireModelRound(hookSystem, { messages: msgsAfterCompact });

    const pair2 = collector.getPairs()[1];
    // 压缩后首次请求，new_messages = 全量
    expect(pair2.request.new_messages).toHaveLength(1);
  });

  // ─── PostToolUse 更新 metadata ───

  test("PostToolUse 更新 tools_used", async () => {
    await fireSessionStart(hookSystem);

    await hookSystem.firePostToolUseEvent("bash", { command: "ls" }, { output: "a.ts" }, false, "toolu_001");

    const meta = collector.getMetadata()!;
    expect(meta.tools_used.has("bash")).toBe(true);
  });

  test("write 工具 PostToolUse 更新 files_edited", async () => {
    await fireSessionStart(hookSystem);

    await hookSystem.firePostToolUseEvent(
      "write",
      { file_path: "src/app.ts", content: "code" },
      { written: true },
      false,
    );

    const meta = collector.getMetadata()!;
    expect(meta.files_edited.has("src/app.ts")).toBe(true);
  });

  test("edit 工具 PostToolUse 更新 files_edited", async () => {
    await fireSessionStart(hookSystem);

    await hookSystem.firePostToolUseEvent(
      "edit",
      { file_path: "src/hook/types.ts", old_string: "a", new_string: "b" },
      { edited: true },
      false,
    );

    const meta = collector.getMetadata()!;
    expect(meta.files_edited.has("src/hook/types.ts")).toBe(true);
  });

  test("PostToolUseFailure 写入 events.jsonl，is_error=true", async () => {
    await fireSessionStart(hookSystem);

    await hookSystem.firePostToolUseFailureEvent("bash", { command: "rm -rf /" }, "Permission denied", "toolu_err");

    const eventsPath = join(testDir, "sessions", "sess-001", "events.jsonl");
    const lines = readFileSync(eventsPath, "utf-8").trim().split("\n");
    const failureEvent = lines.map(l => JSON.parse(l)).find(e => e.event === "PostToolUseFailure");
    expect(failureEvent).toBeDefined();
    expect(failureEvent.data.is_error).toBe(true);
  });

  // ─── UserPromptSubmit ───

  test("UserPromptSubmit 追加到 user_prompts", async () => {
    await fireSessionStart(hookSystem);

    await hookSystem.fireUserPromptSubmitEvent("请帮我修复这个 bug");

    const meta = collector.getMetadata()!;
    expect(meta.user_prompts).toContain("请帮我修复这个 bug");
  });

  test("空白 prompt 不追加", async () => {
    await fireSessionStart(hookSystem);

    await hookSystem.fireUserPromptSubmitEvent("   ");

    const meta = collector.getMetadata()!;
    expect(meta.user_prompts).toHaveLength(0);
  });

  // ─── PreCompact ───

  test("PreCompact 记录到 compactions 并重置 prevMessageCount", async () => {
    await fireSessionStart(hookSystem);

    const msgs = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }];
    await fireModelRound(hookSystem, { messages: msgs });
    expect(collector.getPrevMessageCount()).toBe(2);

    await hookSystem.firePreCompactEvent("manual");

    const meta = collector.getMetadata()!;
    expect(meta.compactions).toHaveLength(1);
    expect(meta.compactions[0].trigger).toBe("manual");
    // prevMessageCount 重置为 0
    expect(collector.getPrevMessageCount()).toBe(0);
  });

  // ─── SubagentStart / SubagentStop ───

  test("SubagentStart 设置 has_sub_agent 并追加 span", async () => {
    await fireSessionStart(hookSystem);

    await hookSystem.fireSubagentStartEvent("agent-001", "task", "sess-001");

    const meta = collector.getMetadata()!;
    expect(meta.has_sub_agent).toBe(true);
    expect(meta.subagent_spans).toHaveLength(1);
    expect(meta.subagent_spans[0].agent_id).toBe("agent-001");
    expect(meta.subagent_spans[0].agent_type).toBe("task");
    expect(meta.subagent_spans[0].end).toBeUndefined();
  });

  test("SubagentStop 填入 span.end 时间", async () => {
    await fireSessionStart(hookSystem);

    await hookSystem.fireSubagentStartEvent("agent-002", "explore");
    await hookSystem.fireSubagentStopEvent();

    const meta = collector.getMetadata()!;
    expect(meta.subagent_spans[0].end).toBeDefined();
  });

  // ─── Thinking Blocks ───

  test("thinking_blocks 更新 has_thinking", async () => {
    await fireSessionStart(hookSystem);

    await fireModelRound(hookSystem, {
      thinking_blocks: [{ type: "thinking", thinking: "深度思考" }],
    });

    const meta = collector.getMetadata()!;
    expect(meta.has_thinking).toBe(true);
  });

  test("无 thinking_blocks 时 has_thinking 不变", async () => {
    await fireSessionStart(hookSystem);
    await fireModelRound(hookSystem);

    expect(collector.getMetadata()!.has_thinking).toBe(false);
  });

  // ─── Token 统计累积 ───

  test("多轮 model 后 token: input 取最后一次（含全历史），output/cache 累加", async () => {
    await fireSessionStart(hookSystem);

    await fireModelRound(hookSystem, { inputTokens: 100, outputTokens: 50, cacheRead: 10, cacheCreate: 5 });
    await fireModelRound(hookSystem, { inputTokens: 200, outputTokens: 80, cacheRead: 20, cacheCreate: 0 });

    const meta = collector.getMetadata()!;
    // input_tokens 是"本次 API 调用的 prompt 总长度"，每次都含全部历史 → 取 last（200）
    // 累加会 N² 过计数（case_028 实测：29 次累加 3.65M / 实际 167k）
    expect(meta.total_tokens_sent).toBe(200);
    expect(meta.total_tokens_received).toBe(130);
    expect(meta.total_cache_read_tokens).toBe(30);
    expect(meta.total_cache_creation_tokens).toBe(5);
    expect(meta.total_api_calls).toBe(2);
  });

  // ─── SessionEnd 覆盖统计 ───

  test("SessionEnd stats 覆盖自己累积的统计", async () => {
    await fireSessionStart(hookSystem);
    await fireModelRound(hookSystem, { inputTokens: 100, outputTokens: 50 });

    await hookSystem.fireSessionEndEvent("exit", {
      model: "claude-opus-4",
      total_tokens_sent: 9999,
      total_tokens_received: 3333,
      total_cost_usd: 0.99,
      total_api_calls: 10,
    });

    const meta = collector.getMetadata()!;
    expect(meta.total_tokens_sent).toBe(9999);
    expect(meta.total_tokens_received).toBe(3333);
    expect(meta.total_cost_usd).toBe(0.99);
    expect(meta.total_api_calls).toBe(10);
    expect(meta.model).toBe("claude-opus-4");
  });

  test("SessionEnd 推断 exit_status=end_turn", async () => {
    await fireSessionStart(hookSystem);
    await fireModelRound(hookSystem, { stopReason: "end_turn" });
    await hookSystem.fireSessionEndEvent("exit");

    const meta = collector.getMetadata()!;
    expect(meta.exit_status).toBe("end_turn");
  });

  test("SessionEnd 最终写入 session.traj", async () => {
    await fireSessionStart(hookSystem);
    await fireModelRound(hookSystem);
    await hookSystem.fireSessionEndEvent("exit");

    const trajPath = join(testDir, "sessions", "sess-001", "session.traj");
    const traj = JSON.parse(readFileSync(trajPath, "utf-8"));
    expect(traj.metadata.tool_source).toBe("sid-code");
  });

  // ─── D3-1 / D3-3：退出落 messages.json + 异常归因 ───

  test("D3-1：SessionEnd 落 messages.json，含完整消息历史", async () => {
    await fireSessionStart(hookSystem);
    await fireModelRound(hookSystem, {
      messages: [{ role: "user", content: "读个文件" }],
      contentBlocks: [{ type: "text", text: "好的" }],
      stopReason: "end_turn",
    });
    await hookSystem.fireSessionEndEvent("exit");

    const msgPath = join(testDir, "sessions", "sess-001", "messages.json");
    expect(existsSync(msgPath)).toBe(true);
    const snapshot = JSON.parse(readFileSync(msgPath, "utf-8"));
    expect(snapshot.kind).toBe("messages-snapshot");
    expect(snapshot.session_id).toBe("sess-001");
    expect(Array.isArray(snapshot.messages)).toBe(true);
    expect(snapshot.message_count).toBeGreaterThan(0);
  });

  test("D3-3：异常退出(error) 写 exit_attribution 到 metadata，abnormal=true", async () => {
    await fireSessionStart(hookSystem);
    await fireModelRound(hookSystem, {
      messages: [{ role: "user", content: "task" }],
      contentBlocks: [{ type: "text", text: "处理中" }],
      stopReason: "tool_use",
    });
    await hookSystem.fireSessionEndEvent("error", undefined, {
      error: { message: "OpenAI API 错误: 400", name: "ApiError" },
    });

    const meta = collector.getMetadata()!;
    expect(meta.exit_attribution).toBeDefined();
    expect(meta.exit_attribution!.abnormal).toBe(true);
    expect(meta.exit_attribution!.reason).toBe("error");
    expect(meta.exit_attribution!.summary).toContain("reason=error");
    // messages.json 也应含归因
    const snapshot = JSON.parse(
      readFileSync(join(testDir, "sessions", "sess-001", "messages.json"), "utf-8"),
    );
    expect(snapshot.attribution.abnormal).toBe(true);
  });

  test("D3-3：孤儿 tool_use 场景 → has_orphan_tool_use=true + last_tool 命中", async () => {
    await fireSessionStart(hookSystem);
    // 构造一轮:assistant 回复含 tool_use(boom),但历史里无对应 tool_result(孤儿)
    await fireModelRound(hookSystem, {
      messages: [
        { role: "user", content: "task" },
      ],
      contentBlocks: [
        { type: "tool_use", id: "orphan_1", name: "boom", input: {} },
      ],
      stopReason: "tool_use",
    });
    await hookSystem.fireSessionEndEvent("abort");

    const meta = collector.getMetadata()!;
    expect(meta.exit_attribution).toBeDefined();
    expect(meta.exit_attribution!.has_orphan_tool_use).toBe(true);
    expect(meta.exit_attribution!.last_tool).toBe("boom");
    expect(meta.exit_attribution!.abnormal).toBe(true);
  });

  test("D3-3：正常 end_turn 退出 → 不写 exit_attribution（abnormal=false 不污染 metadata）", async () => {
    await fireSessionStart(hookSystem);
    await fireModelRound(hookSystem, { stopReason: "end_turn" });
    await hookSystem.fireSessionEndEvent("exit");

    const meta = collector.getMetadata()!;
    // 正常退出 abnormal=false,不写 exit_attribution
    expect(meta.exit_attribution).toBeUndefined();
    // 但 messages.json 仍落盘(纪律不变量:transcript 必落盘)
    expect(existsSync(join(testDir, "sessions", "sess-001", "messages.json"))).toBe(true);
  });

  // ─── 错误容错 ───

  test("AfterModel 前无 BeforeModel 时静默跳过", async () => {
    await fireSessionStart(hookSystem);

    // 直接触发 AfterModel，无对应的 BeforeModel
    await expect(hookSystem.fireAfterModelEvent(
      { model: "claude-test", messages: [] },
      { content_blocks: [], stop_reason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } },
    )).resolves.toBeDefined();

    // 不应产生 pair
    expect(collector.getPairs()).toHaveLength(0);
  });

  test("写入失败不抛异常，采集继续", async () => {
    // 使用无效路径的 collector
    const badCollector = new TraceCollector({ outputDir: "/dev/null/impossible" });
    const badHookSystem = new HookSystem();
    badHookSystem.setSessionId("bad-sess");
    badHookSystem.setCwd("/tmp");
    badCollector.registerHooks(badHookSystem);

    // 触发事件不应抛异常
    await expect(badHookSystem.fireSessionStartEvent("startup")).resolves.toBeDefined();
    await expect(badHookSystem.fireBeforeModelEvent({
      model: "claude-test",
      messages: [],
    })).resolves.toBeDefined();
  });

  // ─── raw.jsonl 格式验证 ───

  test("首行 raw.jsonl 含 system 和 tools，不含 raw_messages", async () => {
    await fireSessionStart(hookSystem);
    await fireModelRound(hookSystem, {
      system: "你是助手",
      tools: [{ name: "bash" }],
    });

    const rawPath = join(testDir, "sessions", "sess-001", "raw.jsonl");
    const line = JSON.parse(readFileSync(rawPath, "utf-8").trim());

    expect(line.request.system).toBe("你是助手");
    expect(line.request.tools).toHaveLength(1);
    expect(line.request.raw_messages).toBeUndefined();
    expect(line.stop_reason).toBe("end_turn");
    expect(line.is_partial).toBe(false);
  });

  test("后续行 raw.jsonl 含 new_messages 不含 system", async () => {
    await fireSessionStart(hookSystem);
    await fireModelRound(hookSystem, {
      system: "系统提示",
      tools: [{ name: "bash" }],
      messages: [{ role: "user", content: "问题1" }],
    });
    await fireModelRound(hookSystem, {
      messages: [
        { role: "user", content: "问题1" },
        { role: "assistant", content: "回答1" },
        { role: "user", content: "问题2" },
      ],
    });

    const rawPath = join(testDir, "sessions", "sess-001", "raw.jsonl");
    const lines = readFileSync(rawPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);

    const line2 = JSON.parse(lines[1]);
    expect(line2.index).toBe(2);
    expect(line2.request.system).toBeUndefined();
    expect(line2.request.tools).toBeUndefined();
    expect(line2.request.new_messages).toBeDefined();
    expect(line2.request._messages_count).toBe(3);
  });

  // ─── 上传器集成 ───

  test("SessionEnd 调用 uploader.uploadSession", async () => {
    let uploadCalled = false;
    let uploadedSessionId = "";

    const mockUploader = {
      uploadSession: async (_sessionDir: string, sessionId: string) => {
        uploadCalled = true;
        uploadedSessionId = sessionId;
        return { allConfirmed: true };
      },
    };

    const collectorWithUpload = new TraceCollector({ outputDir: testDir }, mockUploader);
    const hs = new HookSystem();
    hs.setSessionId("upload-sess");
    hs.setCwd("/tmp");
    collectorWithUpload.registerHooks(hs);

    await hs.fireSessionStartEvent("startup");
    await hs.fireSessionEndEvent("exit");

    expect(uploadCalled).toBe(true);
    expect(uploadedSessionId).toBe("upload-sess");
  });

  // ─── Harness 数据消费 ───

  test("handleAfterModel 在 input.harness_context 有值时存入 currentPair.harness_turn_context", async () => {
    await fireSessionStart(hookSystem);

    // 先触发 BeforeModel
    await hookSystem.fireBeforeModelEvent({
      model: "claude-test",
      messages: [{ role: "user", content: "hello" }],
      raw_messages: [{ role: "user", content: "hello" }],
    });

    // 通过 hook system 传递 harness_context
    await hookSystem.fireAfterModelEvent(
      {
        model: "claude-test",
        messages: [],
        raw_messages: [{ role: "user", content: "hello" }],
      },
      {
        content_blocks: [{ type: "text", text: "回答" }],
        stop_reason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 50 },
      },
      {
        harness_context: {
          tool_subset: ["read", "write"],
          context_actions: [{ action: "trim", reason: "token_limit" }],
          runtime_mode: "local-inline",
          extra: { edit_protocol: "hashline" },
        },
      },
    );

    const pairs = collector.getPairs();
    expect(pairs).toHaveLength(1);
    expect(pairs[0].harness_turn_context).toBeDefined();
    expect(pairs[0].harness_turn_context?.tool_subset).toEqual(["read", "write"]);
    expect(pairs[0].harness_turn_context?.context_actions).toHaveLength(1);
    expect(pairs[0].harness_turn_context?.runtime_mode).toBe("local-inline");
    expect(pairs[0].harness_turn_context?.edit_protocol).toBe("hashline");
  });

  test("handlePostToolUse 在 input.edit_meta 有值时累积编辑统计", async () => {
    await fireSessionStart(hookSystem);

    // 第一次编辑：首轮成功
    await hookSystem.firePostToolUseEvent(
      "edit",
      { file_path: "src/app.ts", old_string: "a", new_string: "b" },
      { edited: true },
      false,
      "toolu_001",
      {
        edit_meta: {
          protocol: "replace",
          first_pass_success: true,
          retry_count: 0,
        },
      },
    );

    // 第二次编辑：需要重试
    await hookSystem.firePostToolUseEvent(
      "edit",
      { file_path: "src/hook/types.ts", old_string: "x", new_string: "y" },
      { edited: true },
      false,
      "toolu_002",
      {
        edit_meta: {
          protocol: "hashline",
          first_pass_success: false,
          retry_count: 2,
        },
      },
    );

    // 第三次编辑：首轮成功
    await hookSystem.firePostToolUseEvent(
      "write",
      { file_path: "src/new.ts", content: "code" },
      { written: true },
      false,
      "toolu_003",
      {
        edit_meta: {
          protocol: "replace",
          first_pass_success: true,
          retry_count: 0,
        },
      },
    );

    // SessionEnd 时应该写入 harness 统计
    await hookSystem.fireSessionEndEvent("exit");

    const meta = collector.getMetadata()!;
    expect(meta.harness).toBeDefined();
    expect(meta.harness?.edit_stats?.total_edits).toBe(3);
    expect(meta.harness?.edit_stats?.first_pass_success).toBe(2);
    expect(meta.harness?.edit_stats?.protocols_used).toEqual({ replace: 2, hashline: 1 });
  });

  test("handleSessionEnd 在 input.harness_summary 有值时写入 metadata.harness", async () => {
    await fireSessionStart(hookSystem);
    await fireModelRound(hookSystem);

    await hookSystem.fireSessionEndEvent("exit", undefined, {
      harness_summary: {
        task_profile: { task_type: "multi_file_edit", risk_level: "high" },
        edit_stats: {
          total_edits: 10,
          first_pass_success: 8,
          retry_count: 2,
          protocols_used: { replace: 6, hashline: 4 },
        },
        verify_stats: {
          total_runs: 5,
          pass_count: 4,
          auto_repair_success: 1,
          commands_used: ["make test", "npm run lint"],
        },
        context_stats: {
          trimmed_tokens: 1000,
          expired_items: 3,
          tool_subset_sizes: [10, 8, 6],
          compression_actions: 2,
        },
        runtime_mode: "managed-worktree",
        candidate_stats: {
          spawned: 3,
          selected: 1,
          selector_reason: "lowest_cost",
        },
      },
    });

    const meta = collector.getMetadata()!;
    expect(meta.harness).toBeDefined();
    expect(meta.harness?.task_profile).toEqual({ task_type: "multi_file_edit", risk_level: "high" });
    expect(meta.harness?.edit_stats?.total_edits).toBe(10);
    expect(meta.harness?.verify_stats?.total_runs).toBe(5);
    expect(meta.harness?.context_stats?.trimmed_tokens).toBe(1000);
    expect(meta.harness?.runtime_mode).toBe("managed-worktree");
    expect(meta.harness?.candidate_stats?.spawned).toBe(3);
  });

  test("所有 Harness 字段为空时行为与整合前完全一致（回归测试）", async () => {
    await fireSessionStart(hookSystem);

    // 不传任何 harness 字段
    await fireModelRound(hookSystem);
    await hookSystem.firePostToolUseEvent("bash", { command: "ls" }, { output: "a.ts" }, false);
    await hookSystem.fireSessionEndEvent("exit");

    const meta = collector.getMetadata()!;
    const pairs = collector.getPairs();

    // 基础功能应该正常工作
    expect(pairs).toHaveLength(1);
    expect(meta.tools_used.has("bash")).toBe(true);
    expect(meta.exit_status).toBe("end_turn");

    // harness 字段应该不存在或为空
    expect(pairs[0].harness_turn_context).toBeUndefined();
    expect(meta.harness).toBeUndefined();

    // session.traj 应该正常生成
    const trajPath = join(testDir, "sessions", "sess-001", "session.traj");
    expect(existsSync(trajPath)).toBe(true);
    const traj = JSON.parse(readFileSync(trajPath, "utf-8"));
    expect(traj.metadata.tool_source).toBe("sid-code");
    expect(traj.metadata.harness).toBeUndefined();
  });
});

describe("TraceCollector — maxSessionsRetained LRU 清理", () => {
  const { writeFileSync, rmSync, utimesSync } = require("node:fs") as typeof import("node:fs");

  /** 在 outputDir/sessions 下造一个 session 目录，可选 .uploaded 标记与 mtime */
  function makeSession(outputDir: string, id: string, opts: { uploaded?: boolean; mtimeSec?: number } = {}) {
    const dir = join(outputDir, "sessions", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.traj"), "{}");
    if (opts.uploaded) writeFileSync(join(dir, ".uploaded"), "{}");
    if (opts.mtimeSec !== undefined) {
      const t = new Date(opts.mtimeSec * 1000);
      utimesSync(dir, t, t);
    }
    return dir;
  }

  function freshDir(): string {
    const d = join(tmpdir(), `lru-test-${Math.random().toString(36).slice(2)}`);
    mkdirSync(d, { recursive: true });
    return d;
  }

  test("会话数未超上限 → 不删除", () => {
    const dir = freshDir();
    const a = makeSession(dir, "s1", { mtimeSec: 100 });
    const b = makeSession(dir, "s2", { mtimeSec: 200 });
    new TraceCollector({ outputDir: dir, maxSessionsRetained: 5 });
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("超上限 → 删最旧的，保留最新的", () => {
    const dir = freshDir();
    const old1 = makeSession(dir, "old1", { uploaded: true, mtimeSec: 100 });
    const old2 = makeSession(dir, "old2", { uploaded: true, mtimeSec: 200 });
    const recent = makeSession(dir, "recent", { uploaded: true, mtimeSec: 300 });
    // 上限 1 → 应删 2 个最旧，保留最新
    new TraceCollector({ outputDir: dir, maxSessionsRetained: 1 });
    expect(existsSync(old1)).toBe(false);
    expect(existsSync(old2)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("优先删已上传的，未上传的尽量保留（即使更旧）", () => {
    const dir = freshDir();
    // 未上传但最旧 + 两个已上传较新；上限 2 → overflow 1，应删已上传中最旧那个，保留未上传的
    const notUploadedOldest = makeSession(dir, "pending", { uploaded: false, mtimeSec: 100 });
    const uploadedMid = makeSession(dir, "up-mid", { uploaded: true, mtimeSec: 200 });
    const uploadedNew = makeSession(dir, "up-new", { uploaded: true, mtimeSec: 300 });
    new TraceCollector({ outputDir: dir, maxSessionsRetained: 2 });
    // 未上传的即使最旧也保留（数据未安全落远端）
    expect(existsSync(notUploadedOldest)).toBe(true);
    // 已上传中最旧的被删
    expect(existsSync(uploadedMid)).toBe(false);
    expect(existsSync(uploadedNew)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("sessions 目录不存在 → 安全无操作", () => {
    const dir = freshDir();
    // 不创建 sessions 子目录
    expect(() => new TraceCollector({ outputDir: dir, maxSessionsRetained: 1 })).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});
