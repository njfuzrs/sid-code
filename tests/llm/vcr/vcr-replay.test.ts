/**
 * T8.15：VCR 回放测试 — 从 fixture 还原字节流，验证 provider 解析结果结构正确
 *
 * 每个 fixture 对应一个/多个断言：
 *   - openai-normal-stream：文本累积 + usage + stop_reason
 *   - openai-tool-call-stream：tool_use 块 + 参数 JSON 拼接 + finish_reason=tool_calls
 *   - deepseek-keep-alive-heavy：大量 `: keep-alive` 注释行不干扰解析，reasoning + content 正确分离
 *
 * 意义：未来任何流解析改动（如 parseSSE 重构）若导致解析结果退化，本测试立即捕获。
 * 这是 T7 StreamLifecycle 迁移的"对拍"安全网——回放同一字节流，验证行为不变。
 *
 * fix_type: case_design
 */

import { describe, test, expect, afterEach } from "bun:test";
import { OpenAIProvider } from "@sid-code/core/llm/openai.ts";
import type { SendParams, StreamEvent, ContentBlock } from "@sid-code/core/llm/types.ts";
import { loadFixture, installFetchFromFixture } from "./vcr.ts";

const BASE_PARAMS: SendParams = {
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 100,
};

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

/** 消费流，聚合为 { text, thinking, blocks, stopReason, usage, events } */
async function replayAndCollect(model: string, params: SendParams) {
  const provider = new OpenAIProvider("test-key", model);
  const events: StreamEvent[] = [];
  let text = "";
  let thinking = "";
  const blocks: ContentBlock[] = [];
  let stopReason: string | null = null;
  let usage: any = null;
  // 追踪哪些 block index 是 thinking 块（openai.ts 把 reasoning_content 作为
  // content_block_start + _raw_block:{type:"thinking"}，其 delta 仍是 text_delta）。
  const thinkingBlockIndexes = new Set<number>();

  for await (const ev of provider.sendMessageStream(params)) {
    events.push(ev);
    if (ev.type === "content_block_start") {
      const raw = (ev as any)._raw_block;
      if (raw?.type === "thinking") thinkingBlockIndexes.add((ev as any).index);
    } else if (ev.type === "content_block_delta") {
      if (ev.delta.type === "text_delta") {
        if (thinkingBlockIndexes.has((ev as any).index)) thinking += ev.delta.text;
        else text += ev.delta.text;
      }
    } else if (ev.type === "content_block_stop" && (ev as any).content_block) {
      blocks.push((ev as any).content_block);
    } else if (ev.type === "message_delta") {
      if ((ev as any).delta?.stop_reason) stopReason = (ev as any).delta.stop_reason;
    } else if (ev.type === "message_stop") {
      if ((ev as any).usage) usage = (ev as any).usage;
    } else if (ev.type === "error") {
      throw new Error(`unexpected error event: ${(ev as any).error?.message}`);
    }
  }
  return { text, thinking, blocks, stopReason, usage, events };
}

describe("T8.15 VCR 回放 — openai-normal-stream", () => {
  test("文本正确累积 + 无 error 事件", async () => {
    const fx = loadFixture("openai", "normal-stream");
    restore = installFetchFromFixture(fx);
    const { text, events } = await replayAndCollect("gpt-4o-mini", BASE_PARAMS);
    expect(text).toBe("Hello, world!");
    expect(events.some((e) => e.type === "error")).toBe(false);
    // 至少有 message_stop 收尾
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  });
});

describe("T8.15 VCR 回放 — openai-tool-call-stream", () => {
  test("tool_use 块 + 参数 JSON 拼接正确", async () => {
    const fx = loadFixture("openai", "tool-call-stream");
    restore = installFetchFromFixture(fx);
    const { events } = await replayAndCollect("gpt-4o-mini", BASE_PARAMS);

    // 收集 tool_use 块（从 content_block_start / stop 中）
    const toolUseStart = events.find(
      (e) => e.type === "content_block_start" && (e as any).content_block?.type === "tool_use",
    ) as any;
    expect(toolUseStart).toBeDefined();
    expect(toolUseStart.content_block.name).toBe("get_weather");

    // 参数 JSON 分片拼接：{"city":"Paris"}
    const argDeltas = events
      .filter((e) => e.type === "content_block_delta" && (e as any).delta?.type === "input_json_delta")
      .map((e) => (e as any).delta.partial_json)
      .join("");
    expect(argDeltas).toBe("{\"city\":\"Paris\"}");
    expect(JSON.parse(argDeltas)).toEqual({ city: "Paris" });
  });
});

describe("T8.15 VCR 回放 — deepseek-keep-alive-heavy", () => {
  test("大量 keep-alive 注释行不干扰解析，reasoning 与 content 正确分离", async () => {
    const fx = loadFixture("deepseek", "keep-alive-heavy");
    restore = installFetchFromFixture(fx);
    const { text, thinking, events } = await replayAndCollect("deepseek-chat", BASE_PARAMS);

    // 正文只有 "42"（keep-alive 注释行被跳过）
    expect(text).toBe("42");
    // reasoning_content 作为 thinking 透传
    expect(thinking).toContain("Let me think");
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  });
});
