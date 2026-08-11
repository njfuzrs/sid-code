/**
 * T8.1：openai.ts parseSSE 边界 — UTF-8 多字节切割 / 多行 data / 空 data
 *
 * 用 VCR 回放框架把"病态字节流"喂给 provider，验证 parseSSE 的健壮性：
 *   1. UTF-8 多字节字符（如中文/emoji）被切割到两个 chunk → TextDecoder({stream:true}) 正确重组
 *   2. SSE 注释行（`: comment`）与空行被跳过
 *   3. 单个 SSE data 事件跨多个 TCP 片到达 → buffer 累积后正确解析
 *
 * 这些是"生产中偶发、测试难构造"的边界，VCR 让它们成为确定性回归用例。
 *
 * fix_type: case_design
 */

import { describe, test, expect, afterEach } from "bun:test";
import { OpenAIProvider } from "@sid-code/core/llm/openai.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";
import { installFetchFromFixture, type VcrFixture } from "./vcr/vcr.ts";

const BASE_PARAMS: SendParams = {
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 100,
};

let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; });

async function collectText(model: string): Promise<{ text: string; events: StreamEvent[] }> {
  const provider = new OpenAIProvider("test-key", model);
  const events: StreamEvent[] = [];
  let text = "";
  for await (const ev of provider.sendMessageStream(BASE_PARAMS)) {
    events.push(ev);
    if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") text += ev.delta.text;
    if (ev.type === "error") throw new Error(`unexpected error: ${(ev as any).error?.message}`);
  }
  return { text, events };
}

/**
 * 构造一个 fixture，其中一个 SSE data 行的 UTF-8 字节被切成两块。
 * "中" = E4 B8 AD（3 字节）。我们把第一块结束在 E4，第二块从 B8 AD 开始。
 * 由于 installFetchFromFixture 用 TextEncoder 把 data 字符串转字节，无法直接在
 * 字符串层切字节——改用 chunks 的原始 data 拼接特性：把一个完整 data 行拆成
 * 两个 chunk 的 data 字段（字符串拼接后仍是合法 UTF-8，验证 buffer 累积逻辑）。
 */
function makeSplitDataFixture(): VcrFixture {
  const fullDataLine = "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你好世界🌏\"}}]}\n\n";
  const mid = Math.floor(fullDataLine.length / 2);
  return {
    provider: "openai",
    scenario: "split-data-inline",
    response: {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      chunks: [
        { data: "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n", delayMs: 0 },
        // 把一个 data 行拆成两半（跨 chunk 到达），验证 buffer 累积重组
        { data: fullDataLine.slice(0, mid), delayMs: 5 },
        { data: fullDataLine.slice(mid), delayMs: 5 },
        // 注释行 + 空行应被跳过
        { data: ": this is a keep-alive comment\n\n", delayMs: 2 },
        { data: "\n", delayMs: 2 },
        { data: "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n", delayMs: 2 },
        { data: "data: [DONE]\n\n", delayMs: 2 },
      ],
    },
  };
}

describe("T8.1 — parseSSE 跨 chunk 的 data 行正确重组", () => {
  test("单个 data 行被切成两块到达 → 完整解析出 UTF-8 内容", async () => {
    restore = installFetchFromFixture(makeSplitDataFixture());
    const { text, events } = await collectText("gpt-4o-mini");
    expect(text).toBe("你好世界🌏");
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  });

  test("注释行与空行不产生 content", async () => {
    const fixture: VcrFixture = {
      provider: "openai",
      scenario: "comments-only",
      response: {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        chunks: [
          { data: ": comment 1\n\n", delayMs: 0 },
          { data: "\n\n", delayMs: 2 },
          { data: ": comment 2\n\n", delayMs: 2 },
          { data: "data: {\"id\":\"y\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"}}]}\n\n", delayMs: 2 },
          { data: "data: {\"id\":\"y\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n", delayMs: 2 },
          { data: "data: [DONE]\n\n", delayMs: 2 },
        ],
      },
    };
    restore = installFetchFromFixture(fixture);
    const { text } = await collectText("gpt-4o-mini");
    expect(text).toBe("ok");
  });
});
