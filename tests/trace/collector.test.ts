/**
 * TraceCollector 单元测试
 * 验证 hook 事件序列 → pairs 配对、增量 messages、metadata 填充
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { TraceCollector } from "../../src/trace/collector.ts";
import { HookSystem } from "../../src/hook/system.ts";
import { initLogger, LogLevel } from "../../src/debug/logger.ts";
import { existsSync, readFileSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
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
    reasoningTokens?: number;
    provider?: string;
    model?: string;
  } = {},
) {
  const messages = opts.messages ?? [{ role: "user", content: "hello" }];
  const contentBlocks = opts.contentBlocks ?? [{ type: "text", text: "回答" }];
  const model = opts.model ?? "claude-test";

  await hookSystem.fireBeforeModelEvent({
    model,
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
      model,
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
        ...(opts.reasoningTokens !== undefined ? { reasoningTokens: opts.reasoningTokens } : {}),
      },
      ...(opts.provider ? { provider: opts.provider } : {}),
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

  // ─── ★§6.4：/model 切换后 metadata.model 跟踪实际模型，model_at_start 保留启动值 ───

  test("★/model 中途切换：metadata.model 跟随实际模型，model_at_start 冻结启动值", async () => {
    // SessionStart 启动模型为 claude-test（见 fireSessionStart）。随后两轮请求分别用
    // glm-5.2、deepseek-v4-pro，模拟用户中途 /model 切换。
    await fireSessionStart(hookSystem, "sess-001");
    await fireModelRound(hookSystem, { model: "glm-5.2" });
    await fireModelRound(hookSystem, { model: "ali-deepseek-v4-pro" });

    const meta = collector.getMetadata()!;
    // model 跟踪实际发生请求的模型（切换后为最新模型），与 raw/events/TUI 一致。
    expect(meta.model).toBe("ali-deepseek-v4-pro");
    // model_at_start 冻结在 SessionStart 的启动值，供归因对照，不随 /model 切换变动。
    expect(meta.model_at_start).toBe("claude-test");
  });

  test("AfterModel 后 raw.jsonl 追加一行", async () => {
    await fireSessionStart(hookSystem);
    await fireModelRound(hookSystem);

    const rawPath = join(testDir, "sessions", "sess-001", "raw.jsonl");
    expect(existsSync(rawPath)).toBe(true);
    // §3.5：BeforeModel 预写 request_sent 行，完整 pair 是第二行
    const lines = readFileSync(rawPath, "utf-8").trim().split("\n");
    const pairLine = lines.find(l => {
      const parsed = JSON.parse(l);
      return parsed.type !== "request_sent";
    })!;
    const line = JSON.parse(pairLine);
    expect(line.index).toBe(1);
    expect(line.stop_reason).toBe("end_turn");
    // raw.jsonl 中不应包含 raw_messages 字段
    expect(line.request.raw_messages).toBeUndefined();
  });

  // §3.5（fdb47f30）：raw_preview.jsonl 的 total_tokens_est 不再恒为 0。
  test("BeforeModel 后 raw_preview.jsonl 写入非零 total_tokens_est", async () => {
    await fireSessionStart(hookSystem);
    // 给一条有实质内容的消息，确保估算 > 0
    await fireModelRound(hookSystem, {
      messages: [{ role: "user", content: "请帮我详细分析这段代码的性能瓶颈并给出优化建议" }],
    });

    const previewPath = join(testDir, "sessions", "sess-001", "raw_preview.jsonl");
    expect(existsSync(previewPath)).toBe(true);
    const line = JSON.parse(readFileSync(previewPath, "utf-8").trim().split("\n")[0]);
    expect(line.index).toBe(1);
    expect(line.msg_count).toBe(1);
    // 关键：total_tokens_est 应为正数（原 bug 恒为 0）
    expect(typeof line.total_tokens_est).toBe("number");
    expect(line.total_tokens_est).toBeGreaterThan(0);
  });

  // §6.1：total_tokens_est 应计入 system prompt + tools 定义（旧实现只算 messages，低估 ~380 倍）。
  test("§6.1 raw_preview.total_tokens_est 计入 system+tools（大 tools 定义显著抬高估算）", async () => {
    await fireSessionStart(hookSystem);

    // 构造一个很大的 tools 定义（模拟真实 ~10-20k token 的工具集），
    // 以及一条很短的 user 消息。若估算只算 messages，结果会很小；
    // 计入 tools 后应显著变大。
    const bigTools = Array.from({ length: 30 }, (_, i) => ({
      name: `tool_${i}`,
      description: "这是一个功能非常详细的工具，".repeat(20),
      input_schema: { type: "object", properties: { arg: { type: "string", description: "参数说明".repeat(10) } } },
    }));
    const bigSystem = "你是一个专业的编程助手。".repeat(50);

    await fireModelRound(hookSystem, {
      messages: [{ role: "user", content: "hi" }],
      system: bigSystem,
      tools: bigTools,
    });

    const previewPath = join(testDir, "sessions", "sess-001", "raw_preview.jsonl");
    const line = JSON.parse(readFileSync(previewPath, "utf-8").trim().split("\n")[0]);
    // 短消息 "hi" 本身只有几个 token；计入 system(~大段中文) + 30 个工具定义后，
    // 估算应远超 1000，证明 system/tools 已被计入。
    expect(line.total_tokens_est).toBeGreaterThan(1000);
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

  // ─── 缺口分析补全：派生/采集类指标 ───

  describe("缺口分析指标采集与落盘", () => {
    const readEvents = (): any[] => {
      const eventsPath = join(testDir, "sessions", "sess-001", "events.jsonl");
      return readFileSync(eventsPath, "utf-8").trim().split("\n").map(l => JSON.parse(l));
    };

    test("工具耗时：PostToolUse.duration_ms 落盘 + 会话级累计", async () => {
      await fireSessionStart(hookSystem);
      await hookSystem.firePostToolUseEvent("bash", { command: "ls" }, { output: "a" }, false, "t1", { duration_ms: 1200 });
      await hookSystem.firePostToolUseEvent("read", { file_path: "a.ts" }, { output: "b" }, false, "t2", { duration_ms: 800 });

      const meta = collector.getMetadata()!;
      expect(meta.total_tool_duration_ms).toBe(2000);
      expect(meta.tool_duration_samples).toBe(2);

      const post = readEvents().filter(e => e.event === "PostToolUse");
      expect(post[0].data.duration_ms).toBe(1200);
      expect(post[1].data.duration_ms).toBe(800);
    });

    test("工具耗时：缺 duration_ms 时不落字段、不计样本", async () => {
      await fireSessionStart(hookSystem);
      await hookSystem.firePostToolUseEvent("bash", { command: "ls" }, { output: "a" }, false, "t1");

      const meta = collector.getMetadata()!;
      expect(meta.total_tool_duration_ms).toBe(0);
      expect(meta.tool_duration_samples).toBe(0);
      const post = readEvents().find(e => e.event === "PostToolUse");
      expect(post.data.duration_ms).toBeUndefined();
    });

    test("reasoning token：落盘 AfterModelRaw + 会话级累计（仅 >0 时落字段）", async () => {
      await fireSessionStart(hookSystem);
      await fireModelRound(hookSystem, { reasoningTokens: 300, outputTokens: 500, provider: "openai", model: "glm-5.2" });
      await fireModelRound(hookSystem, { reasoningTokens: 0, outputTokens: 50, provider: "openai", model: "glm-5.2" });

      const meta = collector.getMetadata()!;
      expect(meta.total_reasoning_tokens).toBe(300);

      const raw = readEvents().filter(e => e.event === "AfterModelRaw");
      expect(raw[0].data.reasoning_tokens).toBe(300);
      // reasoning=0 时不落字段（避免噪声）
      expect(raw[1].data.reasoning_tokens).toBeUndefined();
    });

    test("上下文占用率：落盘 used/window/ratio + 会话级峰值", async () => {
      await fireSessionStart(hookSystem);
      // claude-test 会命中兜底窗口；用真实模型名确保窗口可查
      await fireModelRound(hookSystem, { inputTokens: 100_000, provider: "anthropic", model: "claude-opus-4-8" });
      await fireModelRound(hookSystem, { inputTokens: 300_000, provider: "anthropic", model: "claude-opus-4-8" });

      const raw = readEvents().filter(e => e.event === "AfterModelRaw");
      expect(raw[0].data.context_used_tokens).toBe(100_000);
      expect(raw[0].data.context_window).toBeGreaterThan(0);
      expect(raw[0].data.context_usage_ratio).toBeGreaterThan(0);
      expect(raw[0].data.context_usage_ratio).toBeLessThanOrEqual(1);

      // 峰值取各轮最大（第二轮 300k > 第一轮 100k）
      const meta = collector.getMetadata()!;
      expect(meta.context_usage_peak_tokens).toBe(300_000);
      expect(meta.context_usage_peak_ratio).toBeGreaterThan(raw[0].data.context_usage_ratio);
    });

    test("tokens/sec：纯生成耗时累计 + SessionEnd 派生吞吐", async () => {
      await fireSessionStart(hookSystem);
      await fireModelRound(hookSystem, { outputTokens: 1000, provider: "openai", model: "glm-5.2" });
      // 模拟 stream_completed 遥测（纯生成耗时 2s）
      collector.writeRetryTelemetry({ type: "stream_completed", provider: "openai", totalEvents: 10, elapsedMs: 2000 });

      let meta = collector.getMetadata()!;
      expect(meta.total_gen_elapsed_ms).toBe(2000);
      expect(meta.gen_samples).toBe(1);

      await hookSystem.fireSessionEndEvent("exit");
      meta = collector.getMetadata()!;
      // 1000 tokens / 2s = 500 tokens/sec
      expect(meta.output_tokens_per_sec).toBeCloseTo(500, 0);
    });

    test("tokens/sec：无纯生成耗时样本时 output_tokens_per_sec 为 undefined（不落误导 0）", async () => {
      await fireSessionStart(hookSystem);
      await fireModelRound(hookSystem, { outputTokens: 1000, provider: "openai", model: "glm-5.2" });
      // 不写任何 stream_completed 遥测

      await hookSystem.fireSessionEndEvent("exit");
      const meta = collector.getMetadata()!;
      expect(meta.gen_samples).toBe(0);
      expect(meta.output_tokens_per_sec).toBeUndefined();
    });

    test("弃流/重试：会话级聚合计数（六类·可靠性）", async () => {
      await fireSessionStart(hookSystem);
      collector.writeRetryTelemetry({ type: "retry", provider: "openai", attempt: 1 });
      collector.writeRetryTelemetry({ type: "retry", provider: "openai", attempt: 2 });
      collector.writeRetryTelemetry({ type: "stream_idle_timeout", provider: "openai", timeoutMs: 90000, totalEvents: 3 });
      collector.writeRetryTelemetry({ type: "529_dropped", provider: "openai", model: "glm-5.2" });
      collector.writeRetryTelemetry({ type: "stream_completed", provider: "openai", totalEvents: 10, elapsedMs: 1000 });

      const meta = collector.getMetadata()!;
      // retry×2 计入重试 + 弃流；idle_timeout + 529 各计弃流；completed 不计弃流
      expect(meta.model_retry_count).toBe(2);
      expect(meta.discarded_streams).toBe(4);
    });

    test("上下文趋势：逐轮 ratio 序列保留时序", async () => {
      await fireSessionStart(hookSystem);
      await fireModelRound(hookSystem, { inputTokens: 100_000, provider: "anthropic", model: "claude-opus-4-8" });
      await fireModelRound(hookSystem, { inputTokens: 200_000, provider: "anthropic", model: "claude-opus-4-8" });
      await fireModelRound(hookSystem, { inputTokens: 300_000, provider: "anthropic", model: "claude-opus-4-8" });

      const meta = collector.getMetadata()!;
      expect(meta.context_usage_trend).toHaveLength(3);
      // 单调递增（输入逐轮变大 → 占用率逐轮升高）
      expect(meta.context_usage_trend[1]).toBeGreaterThan(meta.context_usage_trend[0]);
      expect(meta.context_usage_trend[2]).toBeGreaterThan(meta.context_usage_trend[1]);
    });

    test("派生比率：output/input 比 + 单会话缓存命中率（三/四类）", async () => {
      await fireSessionStart(hookSystem);
      await fireModelRound(hookSystem, { inputTokens: 1000, outputTokens: 250, cacheRead: 600, provider: "openai", model: "glm-5.2" });

      await hookSystem.fireSessionEndEvent("exit");
      const meta = collector.getMetadata()!;
      // output/input = 250 / 1000 = 0.25
      expect(meta.output_input_ratio).toBeCloseTo(0.25, 3);
      // 命中率 = cache_read / cumulative_prompt = 600 / 1000 = 0.6
      expect(meta.session_cache_hit_rate).toBeCloseTo(0.6, 3);
    });
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

  // ─── 优化 2：SessionEnd 落 session-summary.json（批量分诊入口）───

  test("优化2：正常会话 SessionEnd 落 session-summary.json，errors=0", async () => {
    await fireSessionStart(hookSystem);
    await fireModelRound(hookSystem, {
      messages: [{ role: "user", content: "hi" }],
      contentBlocks: [{ type: "text", text: "hello" }],
      stopReason: "end_turn",
    });
    await hookSystem.fireSessionEndEvent("exit");

    const sumPath = join(testDir, "sessions", "sess-001", "session-summary.json");
    expect(existsSync(sumPath)).toBe(true);
    const summary = JSON.parse(readFileSync(sumPath, "utf-8"));
    expect(summary.session_id).toBe("sess-001");
    expect(summary.exit_status).toBe("end_turn");
    expect(summary.abnormal).toBe(false);
    expect(summary.errors).toBe(0);
    // 复用 digest 的字段应齐全（瘦身后仍含批量分诊主键）
    expect(typeof summary.turns).toBe("number");
    expect(Array.isArray(summary.anomaly_kinds)).toBe(true);
    expect(Array.isArray(summary.anomalies)).toBe(true);
  });

  test("优化2：异常退出(error) 的 summary 标 abnormal=true 且 errors>0", async () => {
    await fireSessionStart(hookSystem);
    await fireModelRound(hookSystem, {
      messages: [{ role: "user", content: "task" }],
      contentBlocks: [{ type: "text", text: "处理中" }],
      stopReason: "tool_use",
    });
    await hookSystem.fireSessionEndEvent("error", undefined, {
      error: { message: "API 错误: 400", name: "ApiError" },
    });

    const summary = JSON.parse(
      readFileSync(join(testDir, "sessions", "sess-001", "session-summary.json"), "utf-8"),
    );
    expect(summary.abnormal).toBe(true);
    expect(summary.exit_status).toBe("error");
    // digest 对 error 退出会产出异常项 → errors 计数 > 0
    expect(summary.errors).toBeGreaterThan(0);
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
    const lines = readFileSync(rawPath, "utf-8").trim().split("\n");
    // §3.5：BeforeModel 时会预写 request_sent 行，完整 pair 是第二行
    const pairLine = lines.find(l => {
      const parsed = JSON.parse(l);
      return parsed.type !== "request_sent";
    })!;
    const line = JSON.parse(pairLine);

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
    // §3.5：每次 BeforeModel 预写 request_sent，故总行数 = 2 pair + 2 request_sent = 4
    const pairLines = lines.filter(l => {
      const parsed = JSON.parse(l);
      return parsed.type !== "request_sent";
    });
    expect(pairLines).toHaveLength(2);

    const line2 = JSON.parse(pairLines[1]);
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
    // 必须发生至少一次真实 LLM 轮次，否则会被「空白轨迹」清理逻辑判定为空壳，
    // 跳过上传（修复问题二的有意行为）。补一轮 Before/AfterModel 使会话非空壳。
    await fireModelRound(hs, {
      messages: [{ role: "user", content: "hi" }],
      contentBlocks: [{ type: "text", text: "hello" }],
    });
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

  // ─── 修复问题二：空白轨迹清理 ───

  test("空白会话（无任何 LLM 调用）退出时删除整个 trajectory 目录", async () => {
    await fireSessionStart(hookSystem); // sess-001
    const dir = join(testDir, "sessions", "sess-001");
    // SessionStart 已落 events.jsonl，目录此刻存在
    expect(existsSync(dir)).toBe(true);

    // 直接退出，从未发生 Before/AfterModel → 纯空壳
    await hookSystem.fireSessionEndEvent("exit");

    // 空壳目录应被整体清理
    expect(existsSync(dir)).toBe(false);
  });

  test("有真实 LLM 轮次的会话退出时保留 trajectory 目录", async () => {
    await fireSessionStart(hookSystem); // sess-001
    await fireModelRound(hookSystem, {
      messages: [{ role: "user", content: "hi" }],
      contentBlocks: [{ type: "text", text: "hello" }],
    });
    const dir = join(testDir, "sessions", "sess-001");
    expect(existsSync(dir)).toBe(true);

    await hookSystem.fireSessionEndEvent("exit");

    // 非空壳，目录必须保留
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, "raw.jsonl"))).toBe(true);
  });

  // ─── ★§6.1：放宽空壳清理，覆盖"发出一次 BeforeModel 即被 abort、0 token"的启动即中断会话 ───

  test("★启动即中断（BeforeModel 发出后立即 abort，0 token）退出时也判空壳清理", async () => {
    await fireSessionStart(hookSystem); // sess-001
    const dir = join(testDir, "sessions", "sess-001");
    // 只发 BeforeModel（在途），不发 AfterModel —— 模拟用户敲 "hi" 随即 Ctrl-C。
    await hookSystem.fireBeforeModelEvent({
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
      raw_messages: [{ role: "user", content: "hi" }],
    });
    expect(existsSync(dir)).toBe(true);

    // 退出：handleSessionEnd 会把在途 pair 冲成 partial/interrupted 空壳,随后判空壳清理。
    await hookSystem.fireSessionEndEvent("user_interrupt");

    // 该类噪音会话（全天 18 条）应被清理，不再残留供上传。
    expect(existsSync(dir)).toBe(false);
  });

  test("★在途中断但已收到响应内容（有诊断价值）→ 保留目录，不误删", async () => {
    await fireSessionStart(hookSystem); // sess-001
    const dir = join(testDir, "sessions", "sess-001");
    // 完成一轮真实 LLM 调用（收到内容块）——即便随后异常退出也有诊断价值。
    await fireModelRound(hookSystem, {
      messages: [{ role: "user", content: "hi" }],
      contentBlocks: [{ type: "text", text: "部分回答" }],
    });
    await hookSystem.fireSessionEndEvent("user_interrupt");

    // 有真实响应内容 → 非空壳，必须保留。
    expect(existsSync(dir)).toBe(true);
  });

  // ─── 修复问题一：resume 复用原 trajectory 目录 ───

  test("resume 续接复用 resumed_from 目录，且 index 接续历史轮次", async () => {
    // 第一轮：原始会话 orig-sess，发生 1 轮 LLM 调用并退出
    const hs1 = new HookSystem();
    hs1.setSessionId("orig-sess");
    hs1.setCwd("/tmp/test");
    const c1 = new TraceCollector({ outputDir: testDir });
    c1.registerHooks(hs1);
    await hs1.fireSessionStartEvent("startup");
    await fireModelRound(hs1, {
      messages: [{ role: "user", content: "first" }],
      contentBlocks: [{ type: "text", text: "r1" }],
    });
    await hs1.fireSessionEndEvent("exit");

    const origDir = join(testDir, "sessions", "orig-sess");
    const rawPath = join(origDir, "raw.jsonl");
    expect(existsSync(rawPath)).toBe(true);
    // raw.jsonl 每轮写 2 行：request_sent 预写行 + 完整 pair 行。只数完整 pair（type 缺省）。
    const countPairs = () =>
      readFileSync(rawPath, "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { type?: string; index?: number })
        .filter((r) => r.type === undefined);
    const pairsAfterFirst = countPairs();
    expect(pairsAfterFirst.length).toBe(1); // 历史 1 轮
    expect(pairsAfterFirst[0].index).toBe(1);

    // 第二轮：新进程 -c 恢复，进程 id 为 new-proc，但 resumed_from=orig-sess
    const hs2 = new HookSystem();
    hs2.setSessionId("new-proc");
    hs2.setCwd("/tmp/test");
    const c2 = new TraceCollector({ outputDir: testDir });
    c2.registerHooks(hs2);
    await hs2.fireSessionStartEvent("resume", { resumedFrom: "orig-sess" });
    await fireModelRound(hs2, {
      messages: [{ role: "user", content: "second" }],
      contentBlocks: [{ type: "text", text: "r2" }],
    });
    await hs2.fireSessionEndEvent("exit");

    // 不应另建 new-proc 目录
    expect(existsSync(join(testDir, "sessions", "new-proc"))).toBe(false);
    // 续接写入同一 orig-sess/raw.jsonl，完整 pair 现在 2 轮
    const pairsAfterResume = countPairs();
    expect(pairsAfterResume.length).toBe(2);
    // 续接轮 index 接续为 2（而非从 1 重号）
    expect(pairsAfterResume[1].index).toBe(2);
  });

  test("resume 复用已上传清理的目录：从 metadata.json 恢复 index 偏移", async () => {
    // 模拟「上传成功后清理」的目录状态：raw.jsonl/session.traj/events.jsonl 已被删，
    // 仅剩 .uploaded 标记 + metadata.json（含 total_api_calls=3 表示历史 3 轮）。
    const dir = join(testDir, "sessions", "uploaded-sess");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".uploaded"), JSON.stringify({ session_id: "uploaded-sess" }));
    writeFileSync(
      join(dir, "metadata.json"),
      JSON.stringify({ session_id: "uploaded-sess", total_api_calls: 3 }),
    );

    // -c 恢复该已清理目录
    const hs = new HookSystem();
    hs.setSessionId("proc-x");
    hs.setCwd("/tmp/test");
    const c = new TraceCollector({ outputDir: testDir });
    c.registerHooks(hs);
    await hs.fireSessionStartEvent("resume", { resumedFrom: "uploaded-sess" });
    await fireModelRound(hs, {
      messages: [{ role: "user", content: "after-upload" }],
      contentBlocks: [{ type: "text", text: "r4" }],
    });
    await hs.fireSessionEndEvent("exit");

    // 续接轮 index 应接续历史 3 轮 → 第 4 轮（而非从 1 重号、与远端历史冲突）
    const rawPath = join(dir, "raw.jsonl");
    expect(existsSync(rawPath)).toBe(true);
    const pairs = readFileSync(rawPath, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type?: string; index?: number })
      .filter((r) => r.type === undefined);
    expect(pairs.length).toBe(1);
    expect(pairs[0].index).toBe(4);
  });
});

// ─── §3.4（fdb47f30）：审计日志覆盖 ───
// 验证 BeforeModel/AfterModel/工具事件被写入 audit.log（INFO 写文件、工具失败升 WARN）。
// 用 initLogger 注入临时文件 audit logger（fileOnly + WARN + 写所有级别到文件），
// 触发事件后读文件断言 AUDIT 条目存在。fdb47f30 的 audit.log 只有 2 条、看不出第 23
// 次请求发生了什么，正是因为这些 handler 从不调 logger。
describe("TraceCollector — §3.4 审计日志覆盖", () => {
  let testDir: string;
  let auditFile: string;
  let hookSystem: HookSystem;
  let collector: TraceCollector;

  beforeEach(() => {
    testDir = join(tmpdir(), `trace-audit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    auditFile = join(testDir, "audit.log");

    // 还原生产 audit logger 配置：fileOnly + WARN，文件写所有级别。
    initLogger({
      enabled: true,
      level: LogLevel.WARN,
      logFile: auditFile,
      console: false,
      fileOnly: true,
      append: true,
    });

    hookSystem = new HookSystem();
    hookSystem.setSessionId("sess-audit");
    hookSystem.setCwd("/tmp/test");
    collector = new TraceCollector({ outputDir: testDir });
    collector.registerHooks(hookSystem);
  });

  afterEach(() => {
    // 还原为 disabled，避免污染其他测试的全局 logger 单例
    initLogger({ enabled: false });
  });

  function readAudit(): string {
    return existsSync(auditFile) ? readFileSync(auditFile, "utf-8") : "";
  }

  // WriteStream 异步写入，断言前轮询等待目标内容落盘（最多 ~1s）。
  async function waitForAudit(needle: string, timeoutMs = 1000): Promise<string> {
    const start = Date.now();
    // bun:test 环境无 Date.now 限制，这里用真实时间轮询
    while (Date.now() - start < timeoutMs) {
      const content = readAudit();
      if (content.includes(needle)) return content;
      await new Promise((r) => setTimeout(r, 20));
    }
    return readAudit();
  }

  test("BeforeModel + AfterModel 写入 AUDIT:MODEL 条目（含 index/stop/token）", async () => {
    await fireSessionStart(hookSystem, "sess-audit");
    await fireModelRound(hookSystem, { stopReason: "tool_use", inputTokens: 123, outputTokens: 45 });

    const audit = await waitForAudit("AfterModel index=1");
    expect(audit).toContain("AUDIT:MODEL");
    // BeforeModel：含 index 与 model
    expect(audit).toContain("BeforeModel index=1");
    // AfterModel：含 stop_reason 与 token
    expect(audit).toContain("AfterModel index=1");
    expect(audit).toContain("stop=tool_use");
    expect(audit).toContain("in=123");
    expect(audit).toContain("out=45");
  });

  test("工具成功写 INFO AUDIT:TOOL，工具失败升 WARN", async () => {
    await fireSessionStart(hookSystem, "sess-audit");
    // 成功工具
    await hookSystem.firePreToolUseEvent("bash", { command: "ls" }, "toolu_ok");
    await hookSystem.firePostToolUseEvent("bash", { command: "ls" }, { output: "a.ts" }, false, "toolu_ok");
    // 失败工具
    await hookSystem.firePostToolUseEvent("bash", { command: "bad" }, { error: "boom" }, true, "toolu_bad");

    const audit = await waitForAudit("toolu_bad");
    expect(audit).toContain("AUDIT:TOOL");
    // 成功条目
    expect(audit).toContain("✓ bash id=toolu_ok");
    // 失败条目带 is_error 标记，且为 WARN 级
    expect(audit).toContain("✗ bash id=toolu_bad");
    expect(audit).toContain("(is_error)");
    // 断言失败条目确实是 WARN 级（审计日志关键信号必可见）。WARN 级格式化为 ⚠ 前缀。
    const failLine = audit.split("\n").find((l) => l.includes("toolu_bad")) ?? "";
    expect(failLine).toContain("⚠");
  });

  test("PostToolUseFailure 写 WARN AUDIT:TOOL", async () => {
    await fireSessionStart(hookSystem, "sess-audit");
    await hookSystem.firePostToolUseFailureEvent("bash", { command: "rm -rf /" }, "Permission denied", "toolu_fail");

    const audit = await waitForAudit("toolu_fail");
    expect(audit).toContain("AUDIT:TOOL");
    expect(audit).toContain("✗ bash id=toolu_fail");
    expect(audit).toContain("PostToolUseFailure");
    const failLine = audit.split("\n").find((l) => l.includes("toolu_fail")) ?? "";
    expect(failLine).toContain("⚠");
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

// ─── 辅助调用（side-call）增量同步 —— 对账修复回归测试 ───
//
// 背景：side-call（标题生成/记忆召回等 fire-and-forget 影子调用）此前只在 SessionEnd
// 时才把 getSideStats() 汇总写入 trajectory metadata。若会话未走到 SessionEnd（崩溃/
// 被杀/挂起），已经产生的用量会从 trajectory 永久丢失——即便 provider 已经计费。
// 现由 side-call-sink 的 setSideStatsObserver 在每次 recordSideCall 后立即同步。

describe("TraceCollector — 辅助调用(side-call)增量同步", () => {
  let testDir: string;
  let hookSystem: HookSystem;
  let collector: TraceCollector;

  beforeEach(async () => {
    testDir = join(tmpdir(), `trace-sidecall-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });

    hookSystem = new HookSystem();
    hookSystem.setSessionId("sess-side");
    hookSystem.setCwd("/tmp/test");

    collector = new TraceCollector({ outputDir: testDir });
    collector.registerHooks(hookSystem);

    // 隔离：每个测试前清空累计用量，避免跨用例污染（成本计算器/观察者由
    // TraceCollector 构造函数重新注册，见 registerHooks 之前的 constructor）。
    const { resetSideCallStats } = await import("../../src/trace/side-call-sink.ts");
    resetSideCallStats();
  });

  // WriteTraj 异步写入，断言前轮询等待落盘（最多 ~1s），同一套路见上方 waitForAudit。
  async function waitForSideStats(timeoutMs = 1000): Promise<any> {
    const trajPath = join(testDir, "sessions", "sess-side", "session.traj");
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (existsSync(trajPath)) {
        const traj = JSON.parse(readFileSync(trajPath, "utf-8"));
        if (traj.metadata?.side_api_calls > 0) return traj;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    return existsSync(trajPath) ? JSON.parse(readFileSync(trajPath, "utf-8")) : undefined;
  }

  test("recordSideCall 后立即同步进内存 metadata，无需等待 SessionEnd", async () => {
    await fireSessionStart(hookSystem, "sess-side");
    await fireModelRound(hookSystem);

    const { recordSideCall } = await import("../../src/trace/side-call-sink.ts");
    recordSideCall({
      label: "title-generation",
      model: "claude-test",
      inputTokens: 40,
      outputTokens: 5,
      cacheReadTokens: 10,
      cacheCreationTokens: 0,
      durationMs: 0,
    });

    // 同步断言：syncSideCallMetadata 在观察者回调内同步执行，不涉及任何 I/O 等待。
    const meta = collector.getMetadata();
    expect(meta!.side_api_calls).toBe(1);
    expect(meta!.side_tokens_sent).toBe(40);
    expect(meta!.side_tokens_received).toBe(5);
  });

  test("recordSideCall 后 session.traj 落盘也反映最新用量（未触发 SessionEnd）", async () => {
    await fireSessionStart(hookSystem, "sess-side");
    await fireModelRound(hookSystem);

    const { recordSideCall } = await import("../../src/trace/side-call-sink.ts");
    recordSideCall({
      label: "title-generation",
      model: "claude-test",
      inputTokens: 40,
      outputTokens: 5,
      cacheReadTokens: 10,
      cacheCreationTokens: 0,
      durationMs: 0,
    });

    // 不触发 fireSessionEndEvent —— 模拟进程被杀/挂起，从未走到清理路径。
    const traj = await waitForSideStats();
    expect(traj).toBeDefined();
    expect(traj.metadata.side_api_calls).toBe(1);
    expect(traj.metadata.side_tokens_sent).toBe(40);
    expect(traj.metadata.side_tokens_received).toBe(5);
  });

  test("多次 recordSideCall 累加，且与 SessionEnd 最终值一致", async () => {
    await fireSessionStart(hookSystem, "sess-side");
    await fireModelRound(hookSystem);

    const { recordSideCall } = await import("../../src/trace/side-call-sink.ts");
    recordSideCall({
      label: "title-generation",
      model: "claude-test",
      inputTokens: 40,
      outputTokens: 5,
      cacheReadTokens: 10,
      cacheCreationTokens: 0,
      durationMs: 0,
    });
    recordSideCall({
      label: "memory-recall",
      model: "claude-test",
      inputTokens: 20,
      outputTokens: 8,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      durationMs: 0,
    });

    expect(collector.getMetadata()!.side_api_calls).toBe(2);
    expect(collector.getMetadata()!.side_tokens_sent).toBe(60);
    expect(collector.getMetadata()!.side_tokens_received).toBe(13);

    // 正常路径走到 SessionEnd 时，两条链路（观察者增量 vs SessionEnd 兜底）汇总值须一致。
    await hookSystem.fireSessionEndEvent("exit");
    expect(collector.getMetadata()!.side_api_calls).toBe(2);
    expect(collector.getMetadata()!.side_tokens_sent).toBe(60);
    expect(collector.getMetadata()!.side_tokens_received).toBe(13);
  });
});
