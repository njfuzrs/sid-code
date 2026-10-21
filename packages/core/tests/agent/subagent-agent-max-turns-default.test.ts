import { afterEach, describe, expect, test } from "bun:test";
import {
  clearDynamicAgents,
  registerDynamicAgents,
} from "@sid-code/core/agent/agent-definition.ts";
import { SubAgent } from "@sid-code/core/agent/sub-agent.ts";
import { Registry } from "@sid-code/core/tool/registry.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";
import type { LegacyTool, LegacyToolResult } from "@sid-code/core/tool/types.ts";

function toolUseEvents(turn: number): StreamEvent[] {
  return [
    {
      type: "message_start",
      message: { usage: { inputTokens: 10, outputTokens: 0 } },
    } as StreamEvent,
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: `read-${turn}`, name: "report_read" },
    } as StreamEvent,
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{}" },
    } as StreamEvent,
    { type: "content_block_stop", index: 0 } as StreamEvent,
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { outputTokens: 5 },
    } as StreamEvent,
  ];
}

function textEvents(text: string): StreamEvent[] {
  return [
    {
      type: "message_start",
      message: { usage: { inputTokens: 10, outputTokens: 0 } },
    } as StreamEvent,
    { type: "content_block_start", index: 0, content_block: { type: "text" } } as StreamEvent,
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } as StreamEvent,
    { type: "content_block_stop", index: 0 } as StreamEvent,
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { outputTokens: 5 },
    } as StreamEvent,
  ];
}

class RepeatingToolProvider implements Provider {
  calls = 0;
  forcedSummaryRequested = false;

  constructor(private readonly toolTurns: number) {}

  name(): string {
    return "mock";
  }

  defaultModel(): string {
    return "mock-model";
  }

  async *sendMessageStream(params: SendParams): AsyncIterable<StreamEvent> {
    this.calls++;
    if (this.calls <= this.toolTurns) {
      yield* toolUseEvents(this.calls);
      return;
    }

    this.forcedSummaryRequested = params.messages.some(
      (message) =>
        message.role === "user" &&
        message.content.some(
          (block) => block.type === "text" && block.text.includes("你已达到最大轮次限制"),
        ),
    );
    yield* textEvents("检查完成");
  }
}

class CountingTool implements LegacyTool {
  calls = 0;

  name(): string {
    return "report_read";
  }

  description(): string {
    return "记录一次测试读取";
  }

  inputSchema(): Record<string, unknown> {
    return { type: "object", properties: {} };
  }

  readOnly(): boolean {
    return true;
  }

  async execute(): Promise<LegacyToolResult> {
    this.calls++;
    return { output: `读取次数 ${this.calls}` };
  }
}

function registerAgent(agentType: string, maxTurns: number): void {
  registerDynamicAgents([
    {
      agentType,
      description: "受限轮次 Agent",
      whenToUse: "执行有轮次上限的任务",
      systemPrompt: "你是测试 Agent。",
      tools: ["report_read"],
      maxTurns,
      readOnly: true,
      source: "userSettings",
    },
  ]);
}

afterEach(() => clearDynamicAgents());

describe("自定义 Agent 的 maxTurns 默认值", () => {
  test("Agent 定义默认上限进入 SubAgent 执行并触发强制总结", async () => {
    registerAgent("limited-agent", 2);
    const provider = new RepeatingToolProvider(2);
    const tool = new CountingTool();
    const tools = new Registry();
    tools.register(tool);
    const subAgent = new SubAgent(provider, "mock-model", tools);

    const result = await subAgent.execute({
      type: "limited-agent",
      description: "最多检查两项",
      prompt: "依次读取文件并汇总",
    });

    expect(result.success).toBe(true);
    expect(result.turns).toBe(2);
    expect(tool.calls).toBe(2);
    expect(provider.calls).toBe(3);
    expect(provider.forcedSummaryRequested).toBe(true);
  });

  test("调用级 maxTurns 覆盖 Agent 默认上限", async () => {
    registerAgent("overridden-agent", 1);
    const provider = new RepeatingToolProvider(3);
    const tool = new CountingTool();
    const tools = new Registry();
    tools.register(tool);

    const result = await new SubAgent(provider, "mock-model", tools).execute({
      type: "overridden-agent",
      description: "显式延长本次任务",
      prompt: "依次读取文件并汇总",
      maxTurns: 3,
    });

    expect(result.success).toBe(true);
    expect(result.turns).toBe(3);
    expect(tool.calls).toBe(3);
    expect(provider.calls).toBe(4);
    expect(provider.forcedSummaryRequested).toBe(true);
  });
});
