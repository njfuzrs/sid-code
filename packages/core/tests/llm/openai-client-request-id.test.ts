/**
 * OpenAI 兼容路径的客户端请求 ID 注入
 *
 * 为什么要测：超时 / 断流 / 用户中断这类失败拿不到响应头，也就没有网关
 * x-*-request-id。客户端 ID 在发请求前生成，是这类失败里唯一能拿去找网关方
 * 对账的标识。此前只有 anthropic.ts 注入，OpenAI 兼容的四个发送入口
 * （Chat 流式 / Responses 流式 / Chat 非流式 / Responses 非流式）都没带。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { OpenAIProvider } from "@sid-code/core/llm/openai.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const origFetch = globalThis.fetch;
const origProtocol = process.env.SID_CODE_OPENAI_PROTOCOL;

afterEach(() => {
  globalThis.fetch = origFetch;
  // 存/恢复原值，不无条件 delete（同进程多文件共享 env）
  if (origProtocol === undefined) delete process.env.SID_CODE_OPENAI_PROTOCOL;
  else process.env.SID_CODE_OPENAI_PROTOCOL = origProtocol;
});

/** 装一个只记录请求头、按需返回响应的 fetch 桩 */
function captureFetch(makeResponse: () => Response): { ids: string[]; urls: string[] } {
  const seen = { ids: [] as string[], urls: [] as string[] };
  globalThis.fetch = ((url: any, init?: any) => {
    seen.urls.push(String(url));
    seen.ids.push(init?.headers?.["x-client-request-id"]);
    return Promise.resolve(makeResponse());
  }) as typeof fetch;
  return seen;
}

const params = {
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 16,
} as any;

async function drain(it: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of it) {
    /* 只关心请求头 */
  }
}

describe("OpenAI 兼容路径注入 x-client-request-id", () => {
  test("Chat Completions 流式：带 UUID，且每次请求不同", async () => {
    process.env.SID_CODE_OPENAI_PROTOCOL = "chat";
    const seen = captureFetch(
      () =>
        new Response(
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
    );
    const provider = new OpenAIProvider("test-key", "gpt-4o-mini");
    await drain(provider.sendMessageStream(params));
    await drain(provider.sendMessageStream(params));

    expect(seen.urls.every((u) => u.endsWith("/chat/completions"))).toBe(true);
    expect(seen.ids).toHaveLength(2);
    for (const id of seen.ids) expect(id).toMatch(UUID_RE);
    expect(seen.ids[0]).not.toBe(seen.ids[1]);
  });

  test("Chat Completions 流式：HTTP 错误路径也已带上（请求发出时就定下）", async () => {
    process.env.SID_CODE_OPENAI_PROTOCOL = "chat";
    const seen = captureFetch(() => new Response("boom", { status: 503 }));
    const provider = new OpenAIProvider("test-key", "gpt-4o-mini");
    await drain(provider.sendMessageStream(params));
    expect(seen.ids[0]).toMatch(UUID_RE);
  });

  test("Responses API 流式：带 UUID", async () => {
    process.env.SID_CODE_OPENAI_PROTOCOL = "responses";
    const seen = captureFetch(() => new Response("boom", { status: 503 }));
    const provider = new OpenAIProvider("test-key", "gpt-4o-mini");
    await drain(provider.sendMessageStream(params));

    expect(seen.urls[0]).toEndWith("/responses");
    expect(seen.ids[0]).toMatch(UUID_RE);
  });

  test("Chat Completions 非流式：带 UUID", async () => {
    process.env.SID_CODE_OPENAI_PROTOCOL = "chat";
    const seen = captureFetch(() =>
      Response.json({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    const provider = new OpenAIProvider("test-key", "gpt-4o-mini");
    await provider.sendMessageNonStreaming(params);

    expect(seen.urls[0]).toEndWith("/chat/completions");
    expect(seen.ids[0]).toMatch(UUID_RE);
  });

  test("Responses API 非流式：带 UUID", async () => {
    process.env.SID_CODE_OPENAI_PROTOCOL = "responses";
    const seen = captureFetch(() => new Response("boom", { status: 503 }));
    const provider = new OpenAIProvider("test-key", "gpt-4o-mini");
    await provider.sendMessageNonStreaming(params).catch(() => {});

    expect(seen.urls[0]).toEndWith("/responses");
    expect(seen.ids[0]).toMatch(UUID_RE);
  });
});
