/**
 * 9bc92c2c 回归测试：content_block index 不连续（稀疏数组防御）
 *
 * 验证 processStream 在第三方代理返回非连续 index 时（如跳过 0 直接 index=1）：
 * 1. 不崩溃（无 TypeError）
 * 2. content 数组密集（无 undefined 空洞）
 * 3. 正常 index=0 开始的场景不受影响
 * 4. 混合场景（text + tool_use，index 乱序）正确累积
 */

import { test, expect, describe } from "bun:test";
import { processStream } from "@sid-code/core/query/stream-processor.ts";
import type { StreamEvent } from "@sid-code/core/llm/types.ts";

async function* toStream(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const e of events) yield e;
}

describe("processStream — 9bc92c2c 稀疏 index 防御", () => {
  test("index 从 1 开始（跳过 0）的 tool_use 不崩溃且数组密集", async () => {
    // 复现根因场景：代理直接返回 tool_use，index=1 跳过 0
    const events: StreamEvent[] = [
      { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 5 } } },
      {
        type: "content_block_start",
        index: 1, // 跳过 0！
        content_block: { type: "tool_use", id: "tool_123", name: "read", input: {} },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"file_path":' },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '"/tmp/x.ts"}' },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      { type: "message_stop" },
    ];

    const resp = await processStream(toStream(events));

    // 数组密集：无 undefined 空洞
    expect(resp.content.every((b) => b != null)).toBe(true);
    // 只有一个 tool_use 块
    expect(resp.content.length).toBe(1);
    expect(resp.content[0].type).toBe("tool_use");
    if (resp.content[0].type === "tool_use") {
      expect(resp.content[0].name).toBe("read");
      expect(resp.content[0].input).toEqual({ file_path: "/tmp/x.ts" });
    }
  });

  test("index 从 2 开始的多个 block（text + tool_use）正确累积", async () => {
    // 极端情况：index 从 2 开始，且有间隔
    const events: StreamEvent[] = [
      { type: "message_start", message: { usage: { inputTokens: 0, outputTokens: 0 } } },
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "text", text: "" },
      },
      { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "你好" } },
      { type: "content_block_stop", index: 2 },
      {
        type: "content_block_start",
        index: 5, // 跳到 5
        content_block: { type: "tool_use", id: "tool_456", name: "bash", input: {} },
      },
      {
        type: "content_block_delta",
        index: 5,
        delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' },
      },
      { type: "content_block_stop", index: 5 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      { type: "message_stop" },
    ];

    const resp = await processStream(toStream(events));

    // 密集数组，2 个元素
    expect(resp.content.length).toBe(2);
    expect(resp.content.every((b) => b != null)).toBe(true);

    // 按 push 顺序：先 text 后 tool_use
    expect(resp.content[0].type).toBe("text");
    if (resp.content[0].type === "text") {
      expect(resp.content[0].text).toBe("你好");
    }
    expect(resp.content[1].type).toBe("tool_use");
    if (resp.content[1].type === "tool_use") {
      expect(resp.content[1].name).toBe("bash");
      expect(resp.content[1].input).toEqual({ command: "ls" });
    }
  });

  test("正常 index=0 开始的连续 stream 不受影响", async () => {
    const events: StreamEvent[] = [
      { type: "message_start", message: { usage: { inputTokens: 0, outputTokens: 0 } } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "World" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tool_789", name: "write", input: {} },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"path":"/a.ts","content":"x"}' },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      { type: "message_stop" },
    ];

    const resp = await processStream(toStream(events));

    expect(resp.content.length).toBe(2);
    expect(resp.content[0].type).toBe("text");
    if (resp.content[0].type === "text") {
      expect(resp.content[0].text).toBe("Hello World");
    }
    expect(resp.content[1].type).toBe("tool_use");
    if (resp.content[1].type === "tool_use") {
      expect(resp.content[1].name).toBe("write");
      expect(resp.content[1].input).toEqual({ path: "/a.ts", content: "x" });
    }
  });

  test("未知 index 的 delta/stop 事件被安全忽略", async () => {
    // 模拟代理发送了 content_block_delta 但之前没有对应的 start
    const events: StreamEvent[] = [
      { type: "message_start", message: { usage: { inputTokens: 0, outputTokens: 0 } } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      // 孤儿 delta：index 99 从未 start 过
      { type: "content_block_delta", index: 99, delta: { type: "text_delta", text: "ghost" } },
      { type: "content_block_stop", index: 0 },
      // 孤儿 stop
      { type: "content_block_stop", index: 99 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      { type: "message_stop" },
    ];

    const resp = await processStream(toStream(events));

    expect(resp.content.length).toBe(1);
    expect(resp.content[0].type).toBe("text");
    if (resp.content[0].type === "text") {
      expect(resp.content[0].text).toBe("ok");
    }
  });

  test("thinking 块 + 非连续 index 正确转型", async () => {
    // thinking 块 index=3，text 块 index=7
    const events: StreamEvent[] = [
      { type: "message_start", message: { usage: { inputTokens: 0, outputTokens: 0 } } },
      {
        type: "content_block_start",
        index: 3,
        content_block: { type: "text", text: "" },
        _raw_block: { type: "thinking" },
      },
      { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "思考中" } },
      { type: "content_block_stop", index: 3 },
      {
        type: "content_block_start",
        index: 7,
        content_block: { type: "text", text: "" },
      },
      { type: "content_block_delta", index: 7, delta: { type: "text_delta", text: "答复" } },
      { type: "content_block_stop", index: 7 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      { type: "message_stop" },
    ];

    const resp = await processStream(toStream(events));

    expect(resp.content.length).toBe(2);
    expect(resp.content.every((b) => b != null)).toBe(true);
    // thinking 块应该被转型
    expect(resp.content[0].type).toBe("thinking");
    if (resp.content[0].type === "thinking") {
      expect(resp.content[0].thinking).toBe("思考中");
    }
    // text 块正常
    expect(resp.content[1].type).toBe("text");
    if (resp.content[1].type === "text") {
      expect(resp.content[1].text).toBe("答复");
    }
  });
});
