/**
 * 第二层兜底单测（stream-processor 层）—— "只思考不答复" 原地转型为正文
 *
 * 背景:reasoning 模型(DeepSeek 等)有时整轮只产出 reasoning_content、普通 content
 * 通道一字未发,且 stop_reason=end_turn。此时 content 里只剩 thinking 块:
 * TUI 渲染为「✻ 思考过程」而非正文答复气泡,且下一轮回放会触发协议 400。
 *
 * processStream 在收尾时做兜底:end_turn/stop + 无 text + 无 tool_use + 恰好 1 个
 * thinking 块 + 思考文本 ≤500 字符 → 把该 thinking 块【原地转型】为 text 块
 *（而非复制追加,避免 content 数组里同段文字重复,保持数据纯净）。
 *
 * 覆盖:1 个触发场景 + 4 个不触发场景(回归保护)。
 */

import { test, expect, describe } from "bun:test";
import { processStream } from "@sid-code/core/query/stream-processor.ts";
import type { StreamEvent } from "@sid-code/core/llm/types.ts";

async function* toStream(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const e of events) yield e;
}

/** 构造一个"思考块"事件序列(reasoning_content → thinking 块) */
function thinkingBlock(index: number, text: string): StreamEvent[] {
  return [
    {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
      _raw_block: { type: "thinking" },
    },
    { type: "content_block_delta", index, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index },
  ];
}

describe("processStream — 第二层兜底:只思考不答复原地转型", () => {
  test("end_turn + 仅短思考无正文 → thinking 块原地转型为 text 块", async () => {
    const events: StreamEvent[] = [
      { type: "message_start", message: { usage: { inputTokens: 0, outputTokens: 0 } } },
      ...thinkingBlock(0, "用户只是打招呼,有什么我可以帮你的吗?"),
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      { type: "message_stop" },
    ];

    const resp = await processStream(toStream(events));

    // 原地转型:不再有 thinking 块,只剩一个 text 块(无重复、无污染)
    const thinking = resp.content.find((b) => b.type === "thinking");
    expect(thinking).toBeUndefined();
    const texts = resp.content.filter((b) => b.type === "text");
    expect(texts).toHaveLength(1);
    if (texts[0].type === "text") {
      expect(texts[0].text).toBe("用户只是打招呼,有什么我可以帮你的吗?");
    }
    // content 数组总长度为 1(单块)
    expect(resp.content).toHaveLength(1);

    // 轨迹采集的 _thinkingBlocks 仍保留原始思考(不丢数据)
    expect((resp as any)._thinkingBlocks).toBeDefined();
    expect((resp as any)._thinkingBlocks).toHaveLength(1);
  });

  test("思考文本超过 500 字符 → 判定为真思考链,保持 thinking 块原样", async () => {
    const longText = "推".repeat(600); // 600 字符 > 500 上限
    const events: StreamEvent[] = [
      { type: "message_start", message: { usage: { inputTokens: 0, outputTokens: 0 } } },
      ...thinkingBlock(0, longText),
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      { type: "message_stop" },
    ];

    const resp = await processStream(toStream(events));
    // 不转型:仍是 thinking 块,无 text 块
    const thinking = resp.content.find((b) => b.type === "thinking");
    expect(thinking).toBeDefined();
    const text = resp.content.find((b) => b.type === "text");
    expect(text).toBeUndefined();
  });

  test("有正文 text 时不触发兜底(thinking 块原样保留)", async () => {
    const events: StreamEvent[] = [
      { type: "message_start", message: { usage: { inputTokens: 0, outputTokens: 0 } } },
      ...thinkingBlock(0, "思考内容"),
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "正式答复" } },
      { type: "content_block_stop", index: 1 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      { type: "message_stop" },
    ];

    const resp = await processStream(toStream(events));
    // thinking 块保留(未被转型),text 块只有原本那一个
    const thinking = resp.content.find((b) => b.type === "thinking");
    expect(thinking).toBeDefined();
    const texts = resp.content.filter((b) => b.type === "text");
    expect(texts).toHaveLength(1);
    if (texts[0].type === "text") {
      expect(texts[0].text).toBe("正式答复");
    }
  });

  test("有 tool_use 时不触发兜底(正文空属正常,thinking 块保留)", async () => {
    const events: StreamEvent[] = [
      { type: "message_start", message: { usage: { inputTokens: 0, outputTokens: 0 } } },
      ...thinkingBlock(0, "我决定调用工具"),
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "c1", name: "read", input: {} },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "{}" },
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
    // 不转型:thinking 块保留,无 text 块,tool_use 在
    const thinking = resp.content.find((b) => b.type === "thinking");
    expect(thinking).toBeDefined();
    const text = resp.content.find((b) => b.type === "text");
    expect(text).toBeUndefined();
    const toolUse = resp.content.find((b) => b.type === "tool_use");
    expect(toolUse).toBeDefined();
  });

  test("stop_reason 非 end_turn/stop 时不触发兜底", async () => {
    const events: StreamEvent[] = [
      { type: "message_start", message: { usage: { inputTokens: 0, outputTokens: 0 } } },
      ...thinkingBlock(0, "被截断前的思考"),
      {
        type: "message_delta",
        delta: { stop_reason: "max_tokens" },
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      { type: "message_stop" },
    ];

    const resp = await processStream(toStream(events));
    // max_tokens(可能续写)不转型,避免把半截思考误当最终答复
    const thinking = resp.content.find((b) => b.type === "thinking");
    expect(thinking).toBeDefined();
    const text = resp.content.find((b) => b.type === "text");
    expect(text).toBeUndefined();
  });
});
