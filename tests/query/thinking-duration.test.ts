/**
 * SP1 思考耗时测量单测（stream-processor 层）
 *
 * 验证 processStream 在思考块（content_block_start 的 _raw_block.type==="thinking"
 * → 若干 text_delta → content_block_stop）结束时，给原地转型的 ThinkingBlock
 * 附上 durationMs（首个 delta 到 stop 的耗时）。
 *
 * 因 durationMs 依赖真实时钟，断言只校验「存在且非负」与「无 delta 不附耗时」，
 * 不锁定具体毫秒值，避免脆弱。
 */

import { test, expect, describe } from "bun:test";
import { processStream } from "../../src/query/stream-processor.ts";
import type { StreamEvent } from "../../src/llm/types.ts";

async function* toStream(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const e of events) yield e;
}

describe("processStream — SP1 思考耗时", () => {
  test("思考块带 delta → ThinkingBlock.durationMs 存在且非负", async () => {
    const events: StreamEvent[] = [
      { type: "message_start", message: { usage: { inputTokens: 0, outputTokens: 0 } } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
        _raw_block: { type: "thinking" },
      },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "先" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "想想" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { inputTokens: 0, outputTokens: 0 } },
      { type: "message_stop" },
    ];

    const resp = await processStream(toStream(events));
    const thinking = resp.content.find((b) => b.type === "thinking");
    expect(thinking).toBeDefined();
    if (thinking && thinking.type === "thinking") {
      expect(thinking.thinking).toBe("先想想");
      expect(typeof thinking.durationMs).toBe("number");
      expect(thinking.durationMs!).toBeGreaterThanOrEqual(0);
    }
  });

  test("普通文本块不附 durationMs", async () => {
    const events: StreamEvent[] = [
      { type: "message_start", message: { usage: { inputTokens: 0, outputTokens: 0 } } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ];

    const resp = await processStream(toStream(events));
    const text = resp.content.find((b) => b.type === "text");
    expect(text).toBeDefined();
    // 文本块不该有 durationMs 字段（thinking 专属）
    expect((text as unknown as Record<string, unknown>).durationMs).toBeUndefined();
  });
});
