/**
 * F5：子代理 `.output` 只写**本轮**新文本（20261019 轨迹 ap4fn0mqo：21 段里 20 段是同一句话）。
 *
 * 根因：onTurnEnd 的 textOutput 是「最后一次文本」，纯工具轮沿用上一轮的值；sub-agent 每轮
 * 拿它 appendAgentOutput，于是一句话被逐轮重写。改用 info.turnText（本轮文本，没有即空串）。
 */

import { describe, test, expect } from "bun:test";
import { SubAgent } from "@sid-code/core/agent/sub-agent.ts";
import { Registry } from "@sid-code/core/tool/registry.ts";
import { getAllTasks, getTaskOutputTail, flushTaskOutput } from "@sid-code/core/task/index.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";

const MARKER = "TURN_ONE_TEXT_MARKER";

/** 第 1 轮：文本 + 工具；第 2、3 轮：纯工具；第 4 轮：纯文本收尾 */
class TextThenToolsProvider implements Provider {
  private turn = 0;
  name() {
    return "mock";
  }
  defaultModel() {
    return "mock-model";
  }
  async *sendMessageStream(_params: SendParams): AsyncIterable<StreamEvent> {
    this.turn += 1;
    const turn = this.turn;
    yield {
      type: "message_start",
      message: { id: `m${turn}`, role: "assistant", usage: { inputTokens: 10, outputTokens: 0 } },
    } as StreamEvent;
    let idx = 0;
    const text = turn === 1 ? MARKER : turn === 4 ? "完成" : "";
    if (text) {
      yield {
        type: "content_block_start",
        index: idx,
        content_block: { type: "text", text: "" },
      } as StreamEvent;
      yield {
        type: "content_block_delta",
        index: idx,
        delta: { type: "text_delta", text },
      } as StreamEvent;
      yield { type: "content_block_stop", index: idx } as StreamEvent;
      idx++;
    }
    if (turn === 4) {
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { outputTokens: 5 },
      } as StreamEvent;
      return;
    }
    yield {
      type: "content_block_start",
      index: idx,
      content_block: { type: "tool_use", id: `t${turn}`, name: "read", input: {} },
    } as StreamEvent;
    yield {
      type: "content_block_delta",
      index: idx,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify({ file_path: `f${turn}.ts` }),
      },
    } as StreamEvent;
    yield { type: "content_block_stop", index: idx } as StreamEvent;
    yield {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { outputTokens: 5 },
    } as StreamEvent;
  }
}

const readTool = {
  name: () => "read",
  description: () => "read",
  inputSchema: () => ({ type: "object", properties: { file_path: { type: "string" } } }),
  readOnly: () => true,
  execute: async () => ({ output: "ok" }),
};

describe("F5 子代理 .output 只写本轮文本", () => {
  test("文本轮 → 工具轮 → 工具轮：第 1 轮那句话只落盘一次", async () => {
    const reg = new Registry();
    reg.register(readTool as any);
    const before = new Set(getAllTasks().map((t) => t.id));
    const agent = new SubAgent(new TextThenToolsProvider(), "test-model", reg);
    const result = await agent.execute({
      type: "explore",
      description: "落盘测试",
      prompt: "干活",
    });
    expect(result.success).toBe(true);

    const task = getAllTasks().find((t) => !before.has(t.id) && t.type === "local_agent");
    expect(task).toBeDefined();
    await flushTaskOutput(task!.id);
    const out = (await getTaskOutputTail(task!.id, 1024 * 1024)) ?? "";
    expect(out.split(MARKER).length - 1).toBe(1);
    expect(out).toContain("完成");
  });
});
