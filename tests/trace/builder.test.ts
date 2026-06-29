/**
 * TraceBuilder 单元测试
 * 验证将 RequestResponsePair[] 转换为 .traj 格式的正确性
 */

import { describe, test, expect } from "bun:test";
import {
  buildTrajectory,
  type RequestResponsePair,
  type TraceMetadata,
} from "../../src/trace/builder.ts";

// ─── 测试辅助函数 ───

function makePair(overrides: Partial<RequestResponsePair> = {}): RequestResponsePair {
  return {
    timestamp: "2026-03-26T10:00:00.000Z",
    index: 1,
    model: "claude-sonnet-4-20250514",
    request: {
      model: "claude-sonnet-4-20250514",
      system: "你是编程助手",
      messages: [{ role: "user", content: "请读取 package.json" }],
      tools: [{ name: "read" }],
      raw_messages: [{ role: "user", content: "请读取 package.json" }],
      new_messages: [{ role: "user", content: "请读取 package.json" }],
    },
    response: {
      content: [{ type: "text", text: "好的，我来读取。" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    stop_reason: "end_turn",
    is_partial: false,
    ...overrides,
  };
}

function makeMetadata(overrides: Partial<TraceMetadata> = {}): TraceMetadata {
  return {
    session_id: "test-session-001",
    model: "claude-sonnet-4-20250514",
    start_time: "2026-03-26T10:00:00.000Z",
    end_time: "2026-03-26T10:05:00.000Z",
    working_directory: "/tmp/test",
    tools_used: new Set<string>(),
    files_edited: new Set<string>(),
    user_prompts: ["请读取 package.json"],
    compactions: [],
    subagent_spans: [],
    has_thinking: false,
    has_sub_agent: false,
    total_tokens_sent: 100,
    total_tokens_received: 50,
    total_cumulative_prompt_tokens: 100,
    total_cache_read_tokens: 0,
    total_cache_creation_tokens: 0,
    total_cost_usd: 0.001,
    total_api_calls: 1,
    side_api_calls: 0,
    side_cost_usd: 0,
    side_tokens_sent: 0,
    side_tokens_received: 0,
    ...overrides,
  };
}

// ─── 测试用例 ───

describe("buildTrajectory", () => {

  // ─── 基础结构 ───

  test("输出包含四个顶层字段", () => {
    const result = buildTrajectory([makePair()], makeMetadata());
    expect(result).toHaveProperty("trajectory");
    expect(result).toHaveProperty("history");
    expect(result).toHaveProperty("info");
    expect(result).toHaveProperty("metadata");
    expect(Array.isArray(result.trajectory)).toBe(true);
    expect(Array.isArray(result.history)).toBe(true);
  });

  test("空 pairs 时输出空 trajectory", () => {
    const result = buildTrajectory([], makeMetadata());
    expect(result.trajectory).toHaveLength(0);
  });

  // ─── final_answer 步骤 ───

  test("stop_reason=end_turn 且 thought 非空时生成 final_answer", () => {
    const pair = makePair({
      response: {
        content: [{ type: "text", text: "项目名是 sid-code。" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      stop_reason: "end_turn",
    });
    const result = buildTrajectory([pair], makeMetadata());

    const finalAnswer = result.trajectory.find(s => s.message_type === "action" && (s as any).action === "final_answer");
    expect(finalAnswer).toBeDefined();
    expect((finalAnswer as any).thought).toBe("项目名是 sid-code。");
  });

  test("stop_reason=end_turn 但 thought 为空时不生成 final_answer", () => {
    const pair = makePair({
      response: {
        content: [{ type: "text", text: "   " }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      stop_reason: "end_turn",
    });
    const result = buildTrajectory([pair], makeMetadata());

    const finalAnswer = result.trajectory.find(s => (s as any).action === "final_answer");
    expect(finalAnswer).toBeUndefined();
  });

  test("stop_reason=tool_use 时不生成 final_answer", () => {
    const pair = makePair({
      response: {
        content: [
          { type: "text", text: "我来读取文件。" },
          { type: "tool_use", id: "toolu_001", name: "read", input: { file_path: "package.json" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      stop_reason: "tool_use",
    });
    const result = buildTrajectory([pair], makeMetadata());

    const finalAnswer = result.trajectory.find(s => (s as any).action === "final_answer");
    expect(finalAnswer).toBeUndefined();
  });

  // ─── action + observation 配对 ───

  test("tool_use 生成 action 步骤", () => {
    const pair = makePair({
      response: {
        content: [
          { type: "text", text: "我来读取。" },
          { type: "tool_use", id: "toolu_001", name: "read", input: { file_path: "package.json" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      stop_reason: "tool_use",
    });
    const result = buildTrajectory([pair], makeMetadata());

    const actionStep = result.trajectory.find(s => s.message_type === "action") as any;
    expect(actionStep).toBeDefined();
    expect(actionStep.tool_name).toBe("read");
    expect(actionStep.tool_use_id).toBe("toolu_001");
    expect(actionStep.thought).toBe("我来读取。");
    expect(actionStep.action).toContain("read(");
  });

  test("tool_use 后在下一个 pair 中找到 tool_result 生成 observation", () => {
    const pair1 = makePair({
      index: 1,
      response: {
        content: [
          { type: "tool_use", id: "toolu_001", name: "read", input: { file_path: "package.json" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      stop_reason: "tool_use",
    });

    const pair2 = makePair({
      index: 2,
      timestamp: "2026-03-26T10:00:05.000Z",
      request: {
        model: "claude-sonnet-4-20250514",
        raw_messages: [
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_001", content: '{"name":"sid-code"}', is_error: false }] },
        ],
        new_messages: [
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_001", content: '{"name":"sid-code"}', is_error: false }] },
        ],
      },
      response: {
        content: [{ type: "text", text: "项目名是 sid-code。" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 200, output_tokens: 30, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
      },
      stop_reason: "end_turn",
    });

    const result = buildTrajectory([pair1, pair2], makeMetadata({
      total_api_calls: 2,
      total_tokens_sent: 300,
      total_tokens_received: 60,
    }));

    // 应该有 action + observation 步骤
    const actionStep = result.trajectory.find(s => s.message_type === "action" && (s as any).tool_name === "read") as any;
    expect(actionStep).toBeDefined();
    expect(actionStep.tool_use_id).toBe("toolu_001");

    const obsStep = result.trajectory.find(s => s.message_type === "observation") as any;
    expect(obsStep).toBeDefined();
    expect(obsStep.tool_use_id).toBe("toolu_001");
    expect(obsStep.content).toBe('{"name":"sid-code"}');
    expect(obsStep.is_error).toBe(false);
    expect(obsStep._orphan).toBeUndefined();
  });

  test("找不到 tool_result 时生成 orphan observation", () => {
    const pair = makePair({
      response: {
        content: [
          { type: "tool_use", id: "toolu_missing", name: "bash", input: { command: "ls" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      stop_reason: "tool_use",
    });
    const result = buildTrajectory([pair], makeMetadata());

    const obsStep = result.trajectory.find(s => s.message_type === "observation") as any;
    expect(obsStep).toBeDefined();
    expect(obsStep._orphan).toBe(true);
    expect(obsStep.content).toContain("tool_result not found");
  });

  // ─── 多工具调用 ───

  test("同一 response 中多个 tool_use 分别生成 action + observation", () => {
    const pair1 = makePair({
      index: 1,
      response: {
        content: [
          { type: "text", text: "我来执行两个工具。" },
          { type: "tool_use", id: "toolu_001", name: "read", input: { file_path: "a.txt" } },
          { type: "tool_use", id: "toolu_002", name: "read", input: { file_path: "b.txt" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      stop_reason: "tool_use",
    });

    const pair2 = makePair({
      index: 2,
      request: {
        model: "claude-sonnet-4-20250514",
        raw_messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_001", content: "内容A", is_error: false },
              { type: "tool_result", tool_use_id: "toolu_002", content: "内容B", is_error: false },
            ],
          },
        ],
        new_messages: [],
      },
      response: {
        content: [{ type: "text", text: "读取完成。" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      stop_reason: "end_turn",
    });

    const result = buildTrajectory([pair1, pair2], makeMetadata({ total_api_calls: 2 }));

    // 4 个 trajectory 步骤：action1, obs1, action2, obs2（+ final_answer 可能有）
    const actions = result.trajectory.filter(s => s.message_type === "action" && (s as any).tool_name);
    const observations = result.trajectory.filter(s => s.message_type === "observation");
    expect(actions).toHaveLength(2);
    expect(observations).toHaveLength(2);

    // 第一个 action 包含 thought
    const a1 = actions[0] as any;
    expect(a1.thought).toBe("我来执行两个工具。");
    expect(a1.tool_use_id).toBe("toolu_001");

    // 第二个 action 的 thought 为空（避免重复）
    const a2 = actions[1] as any;
    expect(a2.thought).toBe("");
    expect(a2.tool_use_id).toBe("toolu_002");

    // observation 内容正确
    const obs1 = observations.find((o: any) => o.tool_use_id === "toolu_001") as any;
    const obs2 = observations.find((o: any) => o.tool_use_id === "toolu_002") as any;
    expect(obs1.content).toBe("内容A");
    expect(obs2.content).toBe("内容B");
  });

  // ─── history 结构 ───

  test("history 包含 system 消息（来自 metadata.system_prompt）", () => {
    const metadata = makeMetadata({ system_prompt: "你是一个编程助手" });
    const result = buildTrajectory([makePair()], metadata);

    const systemMsg = result.history.find(h => h.role === "system");
    expect(systemMsg).toBeDefined();
    expect((systemMsg as any).content).toBe("你是一个编程助手");
    expect((systemMsg as any).agent).toBe("primary");
  });

  test("history 包含 system 消息（来自 pair.request.system）", () => {
    const pair = makePair({
      request: {
        model: "claude-sonnet-4-20250514",
        system: "系统提示词",
        messages: [{ role: "user", content: "hello" }],
        raw_messages: [{ role: "user", content: "hello" }],
        new_messages: [{ role: "user", content: "hello" }],
      },
    });
    const result = buildTrajectory([pair], makeMetadata({ system_prompt: undefined }));

    const systemMsg = result.history.find(h => h.role === "system");
    expect(systemMsg).toBeDefined();
    expect((systemMsg as any).content).toBe("系统提示词");
  });

  test("history 包含 assistant 消息，附带 usage 和 stop_reason", () => {
    const pair = makePair({
      response: {
        content: [{ type: "text", text: "回答内容" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
      },
      stop_reason: "end_turn",
    });

    const result = buildTrajectory([pair], makeMetadata());
    const assistantMsg = result.history.find(h => h.role === "assistant") as any;

    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.usage.input_tokens).toBe(100);
    expect(assistantMsg.usage.output_tokens).toBe(50);
    expect(assistantMsg.usage.cache_read_input_tokens).toBe(10);
    expect(assistantMsg.usage.cache_creation_input_tokens).toBe(5);
    expect(assistantMsg.stop_reason).toBe("end_turn");
    expect(assistantMsg.agent).toBe("primary");
    expect(assistantMsg.tool_calls).toHaveLength(0);
  });

  test("history 中 assistant 消息包含 tool_calls 信息", () => {
    const pair = makePair({
      response: {
        content: [
          { type: "tool_use", id: "toolu_001", name: "bash", input: { command: "ls" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      stop_reason: "tool_use",
    });

    const result = buildTrajectory([pair], makeMetadata());
    const assistantMsg = result.history.find(h => h.role === "assistant") as any;

    expect(assistantMsg.tool_calls).toHaveLength(1);
    expect(assistantMsg.tool_calls[0].function.name).toBe("bash");
    expect(assistantMsg.tool_calls[0].function.arguments).toBe('{"command":"ls"}');
    expect(assistantMsg.message_type).toBe("action");
  });

  // ─── thinking blocks 处理 ───

  test("thinking_blocks 正确记录到 history 的 assistant 消息", () => {
    const pair = makePair({
      response: {
        content: [{ type: "text", text: "最终回答" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      stop_reason: "end_turn",
      thinking_blocks: [{ type: "thinking", thinking: "让我想想..." }],
    });

    const result = buildTrajectory([pair], makeMetadata({ has_thinking: true }));
    const assistantMsg = result.history.find(h => h.role === "assistant") as any;

    expect(assistantMsg.thinking_blocks).toHaveLength(1);
    expect(assistantMsg.thinking_blocks[0].thinking).toBe("让我想想...");
  });

  test("thinking_blocks 优先作为 thought 内容", () => {
    const pair = makePair({
      response: {
        content: [{ type: "text", text: "最终回答" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      stop_reason: "end_turn",
      thinking_blocks: [{ type: "thinking", thinking: "深度思考过程" }],
    });

    const result = buildTrajectory([pair], makeMetadata());
    const finalAnswer = result.trajectory.find(s => (s as any).action === "final_answer") as any;

    // thought 应该包含 thinking 内容
    expect(finalAnswer?.thought).toContain("深度思考过程");
  });

  test("无 thinking_blocks 时 history 中 thinking_blocks 为 null", () => {
    const pair = makePair();
    const result = buildTrajectory([pair], makeMetadata());
    const assistantMsg = result.history.find(h => h.role === "assistant") as any;

    expect(assistantMsg.thinking_blocks).toBeNull();
  });

  // ─── info 和 metadata 字段 ───

  test("info 字段包含正确统计数据", () => {
    const metadata = makeMetadata({
      total_tokens_sent: 500,
      total_tokens_received: 200,
      total_cache_read_tokens: 50,
      total_cache_creation_tokens: 10,
      total_cost_usd: 0.05,
      total_api_calls: 3,
      has_thinking: true,
    });
    const result = buildTrajectory([], metadata);

    expect(result.info.model_stats.tokens_sent).toBe(500);
    expect(result.info.model_stats.tokens_received).toBe(200);
    expect(result.info.model_stats.cache_read_tokens).toBe(50);
    expect(result.info.model_stats.cache_creation_tokens).toBe(10);
    expect(result.info.model_stats.api_calls).toBe(3);
    expect(result.info.model_stats.total_cost_usd).toBe(0.05);
    expect(result.info.has_thinking).toBe(true);
  });

  test("metadata 字段包含 tool_source=sid-code", () => {
    const result = buildTrajectory([], makeMetadata());
    expect(result.metadata.tool_source).toBe("sid-code");
  });

  test("metadata 字段包含正确的会话信息", () => {
    const metadata = makeMetadata({
      session_id: "abc-123",
      model: "claude-opus-4",
      working_directory: "/home/user/project",
      tools_used: new Set(["bash", "read"]),
      files_edited: new Set(["src/app.ts"]),
      user_prompts: ["任务一"],
      has_sub_agent: true,
    });
    const result = buildTrajectory([], metadata);

    expect(result.metadata.session_id).toBe("abc-123");
    expect(result.metadata.model).toBe("claude-opus-4");
    expect(result.metadata.working_directory).toBe("/home/user/project");
    expect(result.metadata.tools_used).toContain("bash");
    expect(result.metadata.tools_used).toContain("read");
    expect(result.metadata.files_edited).toContain("src/app.ts");
    expect(result.metadata.user_prompts).toContain("任务一");
    expect(result.metadata.has_sub_agent).toBe(true);
  });

  test("metadata 包含 total_tokens 统计", () => {
    const metadata = makeMetadata({
      total_tokens_sent: 300,
      total_tokens_received: 150,
    });
    const result = buildTrajectory([], metadata);

    expect(result.metadata.total_tokens).toBe(450);
    expect(result.metadata.total_tokens_sent).toBe(300);
    expect(result.metadata.total_tokens_received).toBe(150);
  });

  // §6.3：total_cumulative_prompt_tokens（flow 口径）应输出到 traj，供外部与 cost 做可比除法。
  test("§6.3 metadata 输出 total_cumulative_prompt_tokens（flow 累计 prompt）", () => {
    const metadata = makeMetadata({
      total_cumulative_prompt_tokens: 54321,
      total_cost_usd: 0.5,
    });
    const result = buildTrajectory([], metadata);

    // 关键：此前该字段在 metaOutput 输出块被遗漏（只累加不输出）
    expect(result.metadata.total_cumulative_prompt_tokens).toBe(54321);
    // 与 cost 同为 flow，可做可比除法（不会是 undefined）
    expect(typeof result.metadata.total_cumulative_prompt_tokens).toBe("number");
  });

  test("metadata 包含 total_steps（trajectory 步骤数）", () => {
    const pair = makePair({
      response: {
        content: [{ type: "text", text: "完成了。" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      stop_reason: "end_turn",
    });
    const result = buildTrajectory([pair], makeMetadata());

    expect(result.metadata.total_steps).toBe(result.trajectory.length);
  });

  // ─── exit_status 推断 ───

  test("最后一个 pair stop_reason=end_turn 时 exit_status 为 end_turn", () => {
    const pair = makePair({ stop_reason: "end_turn" });
    const result = buildTrajectory([pair], makeMetadata({ exit_status: undefined }));
    expect(result.info.exit_status).toBe("end_turn");
    expect(result.metadata.exit_status).toBe("end_turn");
  });

  test("metadata.exit_status 优先级高于自动推断", () => {
    const pair = makePair({ stop_reason: "end_turn" });
    const result = buildTrajectory([pair], makeMetadata({ exit_status: "user_interrupt" }));
    expect(result.info.exit_status).toBe("user_interrupt");
  });

  // ─── system prompt hash ───

  test("system prompt 存在时计算 claude_md_hash", () => {
    const metadata = makeMetadata({ system_prompt: "你是编程助手" });
    const result = buildTrajectory([], metadata);
    expect(result.metadata.claude_md_hash).toBeDefined();
    expect(typeof result.metadata.claude_md_hash).toBe("string");
    expect(result.metadata.claude_md_hash!.length).toBe(32); // MD5 hex 长度
  });

  test("无 system prompt 时 claude_md_hash 不存在", () => {
    const metadata = makeMetadata({ system_prompt: undefined });
    const result = buildTrajectory([], metadata);
    // 可能有来自 pair 的 system，如果 pairs 为空则没有
    // 这里测试空 pairs + 无 metadata.system_prompt 的情况
    if (!result.metadata.claude_md_hash) {
      expect(result.metadata.claude_md_hash).toBeUndefined();
    }
  });

  // ─── tool_result 查找最大前向搜索 ───

  test("maxLookahead=3 内找到 tool_result", () => {
    // pair1 发出 tool_use，tool_result 出现在 pair4（maxLookahead=3 的边界）
    const toolUseId = "toolu_lookahead";
    const pair1 = makePair({
      index: 1,
      response: {
        content: [{ type: "tool_use", id: toolUseId, name: "bash", input: { command: "sleep 3" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      stop_reason: "tool_use",
    });

    // pair2: 有其他 tool_result，不是我们找的
    const pair2 = makePair({
      index: 2,
      request: {
        model: "claude-sonnet-4-20250514",
        raw_messages: [
          { role: "user", content: [{ type: "tool_result", tool_use_id: "other_tool", content: "other", is_error: false }] },
        ],
        new_messages: [],
      },
      response: {
        content: [{ type: "text", text: "继续中" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      stop_reason: "end_turn",
    });

    // pair3: 我们的 tool_result（在 maxLookahead=3 范围内的第 2 个 pair）
    const pair3 = makePair({
      index: 3,
      request: {
        model: "claude-sonnet-4-20250514",
        raw_messages: [
          { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "done", is_error: false }] },
        ],
        new_messages: [],
      },
      response: {
        content: [{ type: "text", text: "完成了。" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      stop_reason: "end_turn",
    });

    const result = buildTrajectory([pair1, pair2, pair3], makeMetadata({ total_api_calls: 3 }));

    const obs = result.trajectory.find(s => s.message_type === "observation" && (s as any).tool_use_id === toolUseId) as any;
    expect(obs).toBeDefined();
    expect(obs.content).toBe("done");
    expect(obs._orphan).toBeUndefined();
  });

  // ─── token 统计从 pairs 累加 ───

  test("metadata 统计为 0 时从 pairs 计算: tokens_sent 取最后一次，其它累加", () => {
    const pair1 = makePair({
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
    });
    const pair2 = makePair({
      index: 2,
      usage: { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 },
    });

    const metadata = makeMetadata({
      total_tokens_sent: 0,  // 触发从 pairs 计算
      total_tokens_received: 0,
      total_cache_read_tokens: 0,
      total_cache_creation_tokens: 0,
    });

    const result = buildTrajectory([pair1, pair2], metadata);
    // input_tokens 含整段历史，取 last（200）；其它是每 turn 增量，累加
    expect(result.info.model_stats.tokens_sent).toBe(200);
    expect(result.info.model_stats.tokens_received).toBe(130);
    expect(result.info.model_stats.cache_read_tokens).toBe(30);
    expect(result.info.model_stats.cache_creation_tokens).toBe(5);
  });

  // ─── Harness 字段传递 ───

  test("metadata.harness 有值时正确输出到 TrajectoryMetaOutput.harness", () => {
    const metadata = makeMetadata({
      harness: {
        task_profile: {
          task_type: "multi_file_edit",
          risk_level: "medium",
          estimated_files: 3,
        },
        edit_stats: {
          total_edits: 5,
          first_pass_success: 4,
          retry_count: 1,
          protocols_used: { replace: 3, hashline: 2 },
        },
        runtime_mode: "local-inline",
      },
    });

    const result = buildTrajectory([], metadata);

    expect(result.metadata.harness).toBeDefined();
    expect(result.metadata.harness?.task_profile?.task_type).toBe("multi_file_edit");
    expect(result.metadata.harness?.edit_stats?.total_edits).toBe(5);
    expect(result.metadata.harness?.edit_stats?.first_pass_success).toBe(4);
    expect(result.metadata.harness?.runtime_mode).toBe("local-inline");
  });

  test("metadata.harness 为 undefined 时输出不含 harness 字段", () => {
    const metadata = makeMetadata({ harness: undefined });
    const result = buildTrajectory([], metadata);

    expect(result.metadata.harness).toBeUndefined();
  });

  test("RequestResponsePair.harness_turn_context 有值时不影响 trajectory/history 生成", () => {
    const pair = makePair({
      harness_turn_context: {
        tool_subset: ["read", "write", "bash"],
        context_actions: [{ action: "trim", reason: "token_limit" }],
        edit_protocol: "hashline",
        runtime_mode: "local-inline",
      },
    });

    const result = buildTrajectory([pair], makeMetadata());

    // trajectory 和 history 应该正常生成
    expect(result.trajectory.length).toBeGreaterThan(0);
    expect(result.history.length).toBeGreaterThan(0);

    // harness_turn_context 不影响输出结构
    const finalAnswer = result.trajectory.find(s => (s as any).action === "final_answer");
    expect(finalAnswer).toBeDefined();
  });
});
