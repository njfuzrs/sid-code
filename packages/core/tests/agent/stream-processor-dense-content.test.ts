/**
 * 子代理流处理器：content 数组必须**密集**（无空洞）。
 *
 * 回归背景（2026-10-11 事故）：旧实现按 SSE index 直接落位 `content[event.index] = ...`，
 * 且只认 text / tool_use——thinking 块被跳过不落位，于是 always-on 思考模型
 * （Sonnet/Opus 5.x）的「thinking(0) + tool_use(1)」响应产出 `[<hole>, tool_use]`，
 * agentic-loop 的 `for (const block of response.content)` 一遍历就崩
 * `undefined is not an object (evaluating 'block.type')`，子代理第 2 轮必死。
 */

import { describe, test, expect } from "bun:test";
import { processStream } from "@sid-code/core/agent/stream-processor.ts";
import type { StreamEvent } from "@sid-code/core/llm/types.ts";

async function* toStream(events: unknown[]): AsyncIterable<StreamEvent> {
  for (const e of events) yield e as StreamEvent;
}

const start = { type: "message_start", message: { usage: { inputTokens: 1, outputTokens: 0 } } };
const end = (stop: string) => ({
  type: "message_delta",
  delta: { stop_reason: stop },
  usage: { inputTokens: 0, outputTokens: 3 },
});

/** 断言数组无空洞，且每个元素都有 type（下游 for...of 读 block.type 的前提） */
function expectDense(content: unknown[]) {
  for (let i = 0; i < content.length; i++) {
    expect(i in content).toBe(true);
    expect(typeof (content[i] as { type?: unknown })?.type).toBe("string");
  }
}

describe("子代理 processStream：content 恒密集", () => {
  test("事故形态：thinking + 并行两个 tool_use → [thinking, tool_use, tool_use]，遍历不崩", async () => {
    // anthropic.ts 的 content_block_start 发的是同一个对象引用，stop 前把 signature 写回它
    const thinkingBlock: Record<string, unknown> = { type: "thinking", thinking: "" };
    const events = [
      start,
      { type: "content_block_start", index: 0, content_block: thinkingBlock },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "先列目录" } },
      // 模拟 anthropic.ts：stop 前把累积的 signature 写回 start 时发出的同一对象
      { type: "__sign__" },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "t1", name: "ls", input: {} },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "{}" },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "t2", name: "glob", input: {} },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"pattern":"*.ts"}' },
      },
      { type: "content_block_stop", index: 2 },
      end("tool_use"),
    ];
    async function* s(): AsyncIterable<StreamEvent> {
      for (const e of events) {
        if ((e as { type: string }).type === "__sign__") {
          thinkingBlock.signature = "sig-abc";
          continue;
        }
        yield e as StreamEvent;
      }
    }
    const res = await processStream(s());
    expectDense(res.content);
    expect(res.content.map((b) => b.type)).toEqual(["thinking", "tool_use", "tool_use"]);
    const th = res.content[0] as { thinking: string; signature?: string };
    expect(th.thinking).toBe("先列目录");
    expect(th.signature).toBe("sig-abc");
    expect((res.content[2] as { input: unknown }).input).toEqual({ pattern: "*.ts" });
    // 下游 agentic-loop 的遍历形态
    expect(() => {
      for (const b of res.content) void b.type;
    }).not.toThrow();
  });

  test("OpenAI 族思考（text + _raw_block:thinking）→ 转型为 thinking，后续 text 位置正确", async () => {
    const res = await processStream(
      toStream([
        start,
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
          _raw_block: { type: "thinking" },
        },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "推理中" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "答案" } },
        { type: "content_block_stop", index: 1 },
        end("end_turn"),
      ]),
    );
    expectDense(res.content);
    expect(res.content).toEqual([
      { type: "thinking", thinking: "推理中" },
      { type: "text", text: "答案" },
    ]);
  });

  test("未知块类型 + 跳跃 index → 不占位、不留空洞，其增量被忽略", async () => {
    const res = await processStream(
      toStream([
        start,
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "server_tool_use", id: "s" },
        },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "不该出现" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 5, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 5, delta: { type: "text_delta", text: "正文" } },
        { type: "content_block_stop", index: 5 },
        end("end_turn"),
      ]),
    );
    expectDense(res.content);
    expect(res.content).toEqual([{ type: "text", text: "正文" }]);
  });

  test("redacted_thinking 原样保留（多轮回传必需）", async () => {
    const res = await processStream(
      toStream([
        start,
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "redacted_thinking", data: "xyz" },
        },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } },
        { type: "content_block_stop", index: 1 },
        end("end_turn"),
      ]),
    );
    expectDense(res.content);
    expect(res.content).toEqual([
      { type: "redacted_thinking", data: "xyz" } as never,
      { type: "text", text: "ok" },
    ]);
  });

  test("stream_restart 后思考标记一并清空，新响应不被误转型", async () => {
    const res = await processStream(
      toStream([
        start,
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "作废思考" } },
        { type: "stream_restart", reason: "network_error", attempt: 1 },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "新回答" } },
        { type: "content_block_stop", index: 0 },
        end("end_turn"),
      ]),
    );
    expectDense(res.content);
    expect(res.content).toEqual([{ type: "text", text: "新回答" }]);
  });
});
