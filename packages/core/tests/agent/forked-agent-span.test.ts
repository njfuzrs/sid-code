/**
 * X1H2 T3 · forked 后台任务进 trace 树。
 *
 * 改造前的缺陷形态：
 * - forked 路径不走 hook（`Headless`/`runForkedAgent` 直连 provider），模型调用在 trace 上
 *   完全不存在 → 「fork 烧了 token 但树上看不到」；
 * - `recordForkedToolSpan` 只 `detached: true` 不传 parent → 父由 `ctx.currentSpanId` 决定，
 *   取决于 fork 恰好在哪个 chat span 期间启动；chat 已 end 时更会挂到已出队的 spanId 上，
 *   成为 T4 判据②（找不到的父）里的悬空项。
 *
 * 变异自证：把 `recordForkedToolSpan` 的 `parentSpanId` 参数删掉 / 把模型 span 的
 * `parentSpanId` 去掉，两个断言都变红（父会变成 undefined 或别的 span）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  initTelemetry,
  shutdownTelemetry,
  getTelemetryBus,
  ATTR,
} from "@sid-code/core/telemetry/index.ts";
import type { SpanData, TelemetryExporter } from "@sid-code/core/telemetry/types.ts";
import { runForkedAgent, type ForkedAgentContext } from "@sid-code/core/agent/forked-agent.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";

/** 会话根 spanId（16 字符十六进制，与 bus 生成格式一致） */
const ROOT = "0123456789abcdef";

function mockProvider(scripts: any[][]) {
  let call = 0;
  return {
    name: () => "mock",
    defaultModel: () => "mock-model",
    async *sendMessageStream() {
      const events = scripts[call] ?? [
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { outputTokens: 1 } },
      ];
      call++;
      for (const e of events) yield e;
    },
  };
}

class EchoTool {
  name() {
    return "read";
  }
  description() {
    return "读取文件";
  }
  inputSchema() {
    return { type: "object", properties: { file_path: { type: "string" } } };
  }
  async execute(input: any) {
    return { output: `read: ${JSON.stringify(input)}` };
  }
  readOnly() {
    return true;
  }
}

function makeContext(provider: any, rootSpanId?: string): ForkedAgentContext {
  const registry = new ToolRegistry();
  registry.register(new EchoTool() as any);
  return {
    systemPrompt: "system",
    messages: [{ role: "user", content: [{ type: "text", text: "原始对话" }] }],
    provider,
    toolRegistry: registry,
    model: "mock-model",
    ...(rootSpanId ? { rootSpanId } : {}),
  };
}

const toolTurn = [
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "t1", name: "read" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"file_path":"a"}' },
  },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { outputTokens: 1 } },
];

const doneTurn = [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "完成" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { outputTokens: 1 } },
];

describe("X1H2 T3 · forked 后台任务进树", () => {
  let spans: SpanData[];

  beforeEach(() => {
    spans = [];
    const exporter: TelemetryExporter = {
      name: "mock",
      exportSpans: async (batch) => {
        spans.push(...batch);
      },
      shutdown: async () => {},
    };
    const bus = initTelemetry({
      enabled: true,
      batchSize: 100,
      flushIntervalMs: 999999,
      exporters: [],
    });
    bus.addExporter(exporter);
  });

  afterEach(async () => {
    await shutdownTelemetry();
  });

  async function run(rootSpanId?: string) {
    const ctx = makeContext(mockProvider([toolTurn, doneTurn]), rootSpanId);
    await runForkedAgent(ctx, {
      promptMessages: [{ role: "user", content: [{ type: "text", text: "提取" }] }],
      canUseTool: () => ({ behavior: "allow" }),
      maxTurns: 3,
      querySource: "memory-extract",
    });
    await getTelemetryBus().flush();
  }

  test("模型调用建 chat span：父是传入的会话根，标 forked", async () => {
    await run(ROOT);

    const chat = spans.find((s) => s.kind === "chat")!;
    expect(chat).toBeDefined();
    expect(chat.parentSpanId).toBe(ROOT);
    expect(chat.attributes["sidcode.execution_context"]).toBe("forked");
    expect(chat.attributes["sidcode.forked.query_source"]).toBe("memory-extract");
    expect(chat.attributes[ATTR.REQUEST_MODEL]).toBe("mock-model");
  });

  test("工具 span 显式挂会话根（不是栈顶 chat span）", async () => {
    await run(ROOT);

    const tool = spans.find((s) => s.kind === "execute_tool")!;
    expect(tool).toBeDefined();
    expect(tool.parentSpanId).toBe(ROOT);
    expect(tool.attributes["sidcode.tool.span_backfilled"]).toBe(true);
    expect(tool.attributes["sidcode.execution_context"]).toBe("forked");
    // 关键：不是挂到 chat span 下（改造前 ctx.currentSpanId 在 chat 期间就是它）
    const chat = spans.find((s) => s.kind === "chat")!;
    expect(tool.parentSpanId).not.toBe(chat.spanId);
  });

  test("没有 rootSpanId 时退回改造前行为（不崩、span 仍产出）", async () => {
    await run(undefined);

    const chat = spans.find((s) => s.kind === "chat")!;
    const tool = spans.find((s) => s.kind === "execute_tool")!;
    expect(chat).toBeDefined();
    expect(tool).toBeDefined();
    // 不显式指定父时 bus 用 traceContext 栈顶；测试里没有活跃栈，父为空。
    expect(chat.parentSpanId).toBeUndefined();
  });
});
