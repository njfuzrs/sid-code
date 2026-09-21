/**
 * D2 + D3：子代理停止原因 / 空参数对齐主循环 F1/F2
 *
 * 缺陷记录：docs-research/.../20260920-工具调用层-写入门文档时核出的缺陷.md
 *
 * D3：`end_turn` 先于 `tool_use` 判断 → 网关把 stop_reason 标成 end_turn 却留下
 *     tool_use 时，子代理直接 success:true，工具从未执行。
 * D2：空参数只给退化块补 tool_result，同轮健康 tool_use 变孤儿 → 下一轮 400。
 *
 * 本文件驱动真实 `runAgentLoop`（不绕入口）。不改执行器——断言的是循环编排，
 * 不是分区算法。
 *
 * fix_type: regression_guard
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { runAgentLoop } from "@sid-code/core/agent/agentic-loop.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { LoopDetector } from "@sid-code/core/agent/loop-detection.ts";
import { MAX_EMPTY_PARAM_RETRIES } from "@sid-code/core/query/empty-param.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { ContentBlock, SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";
import type { LegacyTool, LegacyToolResult } from "@sid-code/core/tool/types.ts";

// ─── 流夹具 ───────────────────────────────────────────────────────────────

async function* textEndStream(
  text: string,
  stopReason: string = "end_turn",
): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } } as any;
  yield { type: "content_block_start", index: 0, content_block: { type: "text" } } as any;
  yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } as any;
  yield { type: "content_block_stop", index: 0 } as any;
  yield {
    type: "message_delta",
    delta: { stop_reason: stopReason },
    usage: { outputTokens: 5 },
  } as any;
}

/**
 * 一条 tool_use。入参必须走 input_json_delta——塞在 content_block_start.input 里
 * 会被 stream-processor 落成 input={}（见 subagent-progress-emit 同款注释）。
 */
async function* toolUseStream(opts: {
  id: string;
  name: string;
  input: Record<string, unknown>;
  stopReason: string;
  extra?: { id: string; name: string; input: Record<string, unknown> };
}): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } } as any;
  yield {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: opts.id, name: opts.name },
  } as any;
  if (Object.keys(opts.input).length > 0) {
    yield {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(opts.input) },
    } as any;
  }
  yield { type: "content_block_stop", index: 0 } as any;

  if (opts.extra) {
    yield {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: opts.extra.id, name: opts.extra.name },
    } as any;
    if (Object.keys(opts.extra.input).length > 0) {
      yield {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(opts.extra.input) },
      } as any;
    }
    yield { type: "content_block_stop", index: 1 } as any;
  }

  yield {
    type: "message_delta",
    delta: { stop_reason: opts.stopReason },
    usage: { outputTokens: 5 },
  } as any;
}

function makeProvider(scripted: Array<() => AsyncIterable<StreamEvent>>) {
  const calls: SendParams[] = [];
  const provider = {
    name: () => "mock",
    defaultModel: () => "mock-model",
    sendMessageStream: (params: SendParams) => {
      const idx = calls.length;
      calls.push(params);
      return scripted[Math.min(idx, scripted.length - 1)]();
    },
  } as unknown as Provider;
  return { provider, calls };
}

// ─── 工具 / 上下文 ────────────────────────────────────────────────────────

class CountingTool implements LegacyTool {
  readonly calls: Array<Record<string, unknown>> = [];
  constructor(
    private readonly toolName: string,
    private readonly schema: Record<string, unknown>,
    private readonly readonly: boolean,
  ) {}
  name() {
    return this.toolName;
  }
  description() {
    return this.toolName;
  }
  inputSchema() {
    return this.schema;
  }
  readOnly() {
    return this.readonly;
  }
  async execute(input: Record<string, unknown>): Promise<LegacyToolResult> {
    this.calls.push(input);
    return { output: `${this.toolName} ok` };
  }
}

const REQUIRED_PATH_SCHEMA = {
  type: "object",
  properties: { file_path: { type: "string" } },
  required: ["file_path"],
};

function makeRegistry(tools: CountingTool[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t as any);
  return registry;
}

function makeCtxMgr(): ContextManager {
  const ctxMgr = new ContextManager({ maxTokens: 100_000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "任务" }] });
  return ctxMgr;
}

function baseConfig(
  provider: Provider,
  tools: ToolRegistry,
  overrides: Record<string, unknown> = {},
) {
  return {
    provider,
    model: "mock-model",
    ctxMgr: makeCtxMgr(),
    tools,
    maxTurns: 10,
    signal: new AbortController().signal,
    loopDetector: new LoopDetector(),
    permissionChecker: undefined,
    ...overrides,
  } as any;
}

/** 历史里出现过 tool_use 却没有配对 tool_result 的 id——下一轮发给 OpenAI 族就是 400。 */
function unpairedToolUseIds(messages: Array<{ role: string; content: ContentBlock[] }>): string[] {
  const uses = new Set<string>();
  const results = new Set<string>();
  for (const msg of messages) {
    for (const block of msg.content ?? []) {
      if (block.type === "tool_use") uses.add(block.id);
      if (block.type === "tool_result") results.add(block.tool_use_id);
    }
  }
  return [...uses].filter((id) => !results.has(id));
}

function flattenText(messages: Array<{ role: string; content: ContentBlock[] }>): string {
  return messages
    .flatMap((m) => m.content)
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

// ─── D3：end_turn 残留 tool_use 不得收工 ─────────────────────────────────

describe("D3 — F2 fall-through（end_turn 仍含非空 tool_use）", () => {
  test("end_turn + 非空 read → 执行工具，不直接 success 丢调用", async () => {
    const read = new CountingTool("read", REQUIRED_PATH_SCHEMA, true);
    const { provider, calls } = makeProvider([
      () =>
        toolUseStream({
          id: "t-read",
          name: "read",
          input: { file_path: "a.ts" },
          stopReason: "end_turn",
        }),
      () => textEndStream("读完了"),
    ]);

    const result = await runAgentLoop(baseConfig(provider, makeRegistry([read])));

    expect(read.calls.length).toBe(1);
    expect(read.calls[0]?.file_path).toBe("a.ts");
    expect(result.success).toBe(true);
    expect(result.toolUseCount).toBe(1);
    expect(calls.length).toBe(2);
    expect(unpairedToolUseIds(result.messages as any)).toEqual([]);
  });

  test("stop + 非空 read 同样 fall-through（不是只认 end_turn）", async () => {
    const read = new CountingTool("read", REQUIRED_PATH_SCHEMA, true);
    const { provider } = makeProvider([
      () =>
        toolUseStream({
          id: "t-read",
          name: "read",
          input: { file_path: "b.ts" },
          stopReason: "stop",
        }),
      () => textEndStream("完成"),
    ]);

    const result = await runAgentLoop(baseConfig(provider, makeRegistry([read])));
    expect(read.calls.length).toBe(1);
    expect(result.success).toBe(true);
    expect(unpairedToolUseIds(result.messages as any)).toEqual([]);
  });

  test("stop_sequence + 非空 read 同样 fall-through（主循环白名单第三项）", async () => {
    const read = new CountingTool("read", REQUIRED_PATH_SCHEMA, true);
    const { provider } = makeProvider([
      () =>
        toolUseStream({
          id: "t-read",
          name: "read",
          input: { file_path: "c.ts" },
          stopReason: "stop_sequence",
        }),
      () => textEndStream("完成"),
    ]);

    const result = await runAgentLoop(baseConfig(provider, makeRegistry([read])));
    expect(read.calls.length).toBe(1);
    expect(result.success).toBe(true);
    expect(unpairedToolUseIds(result.messages as any)).toEqual([]);
  });

  test("end_turn 且无 tool_use → 仍直接收工（不误伤正常结束）", async () => {
    const read = new CountingTool("read", REQUIRED_PATH_SCHEMA, true);
    const { provider, calls } = makeProvider([() => textEndStream("任务完成")]);

    const result = await runAgentLoop(baseConfig(provider, makeRegistry([read])));
    expect(result.success).toBe(true);
    expect(result.lastTextOutput).toContain("任务完成");
    expect(read.calls.length).toBe(0);
    expect(calls.length).toBe(1);
    expect(result.errorMessage).toBeUndefined();
  });

  test("stop_sequence 且无 tool_use → 干净收工，不再当未知停止原因", async () => {
    const { provider } = makeProvider([() => textEndStream("碰到 stop 序列", "stop_sequence")]);
    const result = await runAgentLoop(baseConfig(provider, new ToolRegistry()));
    expect(result.success).toBe(true);
    expect(result.lastTextOutput).toContain("碰到 stop 序列");
    expect(result.errorMessage).toBeUndefined();
  });
});

// ─── D3 ∩ D2：end_turn + 空参数，必须进 F1 而不是 success 丢工具 ─────────

describe("D3 ∩ D2 — end_turn + 空参数不得跳过 F1", () => {
  test("end_turn + 空参数 write → 连坐重试，工具未执行，历史零孤儿", async () => {
    const write = new CountingTool("write", REQUIRED_PATH_SCHEMA, false);
    const { provider, calls } = makeProvider([
      () =>
        toolUseStream({
          id: "t-empty",
          name: "write",
          input: {},
          stopReason: "end_turn",
        }),
      () => textEndStream("已按完整参数重试"),
    ]);

    const result = await runAgentLoop(baseConfig(provider, makeRegistry([write])));

    expect(write.calls.length).toBe(0);
    expect(result.success).toBe(true);
    expect(calls.length).toBe(2);
    expect(unpairedToolUseIds(result.messages as any)).toEqual([]);
    expect(flattenText(result.messages as any)).toContain("参数为空");
    expect(flattenText(result.messages as any)).toContain("自动重试 1/3");
  });
});

// ─── D2：同轮健康 tool_use 必须连坐，不得只补退化块 ─────────────────────

describe("D2 — 空参数连坐（同轮健康 tool_use 不得变孤儿）", () => {
  test("tool_use + 空 write + 健康 read → 两个都不执行，输出零 tool_use", async () => {
    const write = new CountingTool("write", REQUIRED_PATH_SCHEMA, false);
    const read = new CountingTool("read", REQUIRED_PATH_SCHEMA, true);
    const { provider, calls } = makeProvider([
      () =>
        toolUseStream({
          id: "t-empty",
          name: "write",
          input: {},
          stopReason: "tool_use",
          extra: { id: "t-healthy", name: "read", input: { file_path: "keep.ts" } },
        }),
      () => textEndStream("重新规划"),
    ]);

    const result = await runAgentLoop(baseConfig(provider, makeRegistry([write, read])));

    expect(write.calls.length).toBe(0);
    expect(read.calls.length).toBe(0);
    expect(result.success).toBe(true);
    expect(calls.length).toBe(2);
    expect(unpairedToolUseIds(result.messages as any)).toEqual([]);
    // 连坐文案：退化块说参数为空，健康块说未被执行
    const text = flattenText(result.messages as any);
    expect(text).toContain("write");
    expect(text).toContain("参数为空");
    expect(text).toContain("read");
    expect(text).toContain("未被执行");
    // 助手消息里不许再留任何 tool_use（否则必成孤儿）
    const assistantWithTools = result.messages.filter((m) =>
      m.content.some((b) => b.type === "tool_use"),
    );
    expect(assistantWithTools).toEqual([]);
  });

  test("无必填参数的合法 input={} 不触发 F1（enter_plan_mode / cron_list 形态）", async () => {
    const cron = new CountingTool("cron_list", { type: "object", properties: {} }, true);
    const { provider } = makeProvider([
      () =>
        toolUseStream({
          id: "t-cron",
          name: "cron_list",
          input: {},
          stopReason: "tool_use",
        }),
      () => textEndStream("列表已取"),
    ]);

    const result = await runAgentLoop(baseConfig(provider, makeRegistry([cron])));
    expect(cron.calls.length).toBe(1);
    expect(result.success).toBe(true);
    expect(unpairedToolUseIds(result.messages as any)).toEqual([]);
  });

  test(`空参数持续退化时最多重试 ${MAX_EMPTY_PARAM_RETRIES} 次后放行，不空转到 maxTurns`, async () => {
    const write = new CountingTool("write", REQUIRED_PATH_SCHEMA, false);
    let emptyCalls = 0;
    const { provider, calls } = makeProvider([
      () => {
        emptyCalls++;
        return toolUseStream({
          id: `t-empty-${emptyCalls}`,
          name: "write",
          input: {},
          stopReason: "tool_use",
        });
      },
    ]);

    const result = await runAgentLoop(
      baseConfig(provider, makeRegistry([write]), { maxTurns: 10 }),
    );

    expect(write.calls.length).toBe(0);
    expect(result.success).toBe(true);
    // 3 次重试 + 第 4 次耗尽放行 = 4 次 LLM 调用，绝不是跑满 maxTurns
    expect(calls.length).toBe(MAX_EMPTY_PARAM_RETRIES + 1);
    expect(result.turns).toBe(MAX_EMPTY_PARAM_RETRIES + 1);
    expect(unpairedToolUseIds(result.messages as any)).toEqual([]);
  });
});

// ─── 接线哨兵：必须调用主循环纯函数，不许再手写半套 ─────────────────────

describe("D2/D3 接线哨兵（防再抄一份）", () => {
  const src = readFileSync(
    new URL("../../../../packages/core/src/agent/agentic-loop.ts", import.meta.url),
    "utf-8",
  );

  test("runAgentLoop 调 detectEmptyParamToolUses / replaceEmptyParamToolUses / buildEmptyParamRetryMessage", () => {
    // 旧实现手写 filter(isEmptyToolInput) + 只给退化块补 tool_result，正是 D2 本体。
    // 这三条调用在，连坐与重试文案就跟主循环同一份；少一条就会再漂。
    expect(src).toContain("detectEmptyParamToolUses(");
    expect(src).toContain("replaceEmptyParamToolUses(");
    expect(src).toContain("buildEmptyParamRetryMessage(");
    expect(src).toContain("MAX_EMPTY_PARAM_RETRIES");
  });

  test("F2 白名单走共享 isEndTurnLikeStopReason，且 end_turn 不再无条件 return", () => {
    // 判据必须与主循环共用一份，不能在子循环再抄 end_turn/stop/stop_sequence。
    expect(src).toContain("isEndTurnLikeStopReason(");
    expect(src).toContain("f2FallThrough");
    // 旧代码：`if (end_turn || stop) { return { success: true } }` 无 tool_use 守卫。
    // 新代码必须在收工前看 hasPendingToolUse。
    expect(src).toContain("hasPendingToolUse");
    expect(src).toContain("isEndTurnLike && !hasPendingToolUse");
  });

  test("不再手写「只给退化块补 error tool_result」", () => {
    expect(src).not.toContain("工具参数为空。请检查工具定义");
  });
});
