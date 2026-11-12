/**
 * D16：BilledRequest 带 tools_hash / tools_count / prefix_source，并真的落进 events.jsonl。
 *
 * 走真实 OpenAIProvider 流式路径（mock fetch），断言落盘事件而不是只测 observeRequestShape：
 * 字段「函数算对了但 provider 出口没展开」这种死接线，只测函数测不出来。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { OpenAIProvider } from "@sid-code/core/llm/openai.ts";
import { initStreamObserver, resetStreamObserver } from "@sid-code/core/trace/stream-observer.ts";
import { toolsFingerprint } from "@sid-code/core/llm/request-shape-observation.ts";
import type { SendParams, ToolDefinition } from "@sid-code/core/llm/types.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetStreamObserver();
});

function sseBody(): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const chunks = [
    { choices: [{ index: 0, delta: { content: "ok" } }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 0 },
    },
  ];
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\n\n`));
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}

const tools: ToolDefinition[] = [
  { name: "edit", description: "e", input_schema: { type: "object", properties: {} } },
  { name: "read", description: "r", input_schema: { type: "object", properties: {} } },
];

async function billedFor(params: Partial<SendParams>) {
  const events: Array<{ event?: string; data?: Record<string, unknown> }> = [];
  initStreamObserver("s-shape", "/tmp/s-shape", (e) => events.push(e as any));
  globalThis.fetch = (async () =>
    new Response(sseBody(), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;
  const provider = new OpenAIProvider("k", "deepseek-flash", "https://api.example.invalid/v1");
  const stream = provider.sendMessageStream({
    model: "deepseek-flash",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    maxTokens: 16,
    ...params,
  } as SendParams);
  for await (const _ of stream) {
    /* drain */
  }
  const billed = events.filter((e) => e.event === "BilledRequest");
  expect(billed).toHaveLength(1);
  return billed[0]!.data!;
}

describe("D16 · BilledRequest 请求形状观测字段", () => {
  test("带 tools 的请求落 tools_hash / tools_count，hash 与工具定义一致", async () => {
    const d = await billedFor({ tools });
    expect(d.tools_count).toBe(2);
    expect(d.tools_hash).toBe(toolsFingerprint(tools)!.toolsHash);
    // 主循环请求不写 prefix_source（只有 fork 有）
    expect("prefix_source" in d).toBe(false);
  });

  test("fork 请求落 prefix_source", async () => {
    const d = await billedFor({ tools, forkPrefixSource: "snapshot" });
    expect(d.prefix_source).toBe("snapshot");
  });

  test("工具定义变一个字节 hash 就变（对齐判据靠它）", () => {
    const a = toolsFingerprint(tools)!.toolsHash;
    const b = toolsFingerprint([{ ...tools[0]!, description: "e2" }, tools[1]!])!.toolsHash;
    expect(a).not.toBe(b);
  });

  test("不带 tools 时字段缺席（不是 0 / 空串）", async () => {
    const d = await billedFor({});
    expect("tools_hash" in d).toBe(false);
    expect("tools_count" in d).toBe(false);
  });
});
