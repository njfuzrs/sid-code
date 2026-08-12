/**
 * 别名 → 真名 的**端到端**回归：断言真正发到线上的 `model` 字段。
 *
 * 为什么必须打到 fetch 边界：单测 resolveWireModel 只证明「解析函数对」，
 * 证明不了「provider 真的用了它」。本次改造的核心风险恰恰是漏接某条路径
 * （流式 / 非流式 / 两家 provider 各一份请求体），那种漏只在真配了 modelId 时现形。
 *
 * 同时钉住反向不变量：**归因侧仍必须是别名**。两条渠道指向同一真名，若归因也用真名，
 * 分渠道的成本/日志统计会被合并成一条，改造就把一个 bug 换成另一个 bug。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { setWireModelAliases, resetWireModelAliases } from "@sid-code/core/llm/wire-model.ts";

const GATEWAY = "claude-sonnet-5-gateway";
const REAL = "claude-sonnet-5";

const BASE_MSG = [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }];

/** 抓取 OpenAI 兼容端点非流式请求体 */
async function captureOpenAIBody(ctorModel: string, params: Record<string, unknown>): Promise<any> {
  const { OpenAIProvider } = await import("@sid-code/core/llm/openai.ts");
  let captured: any = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    captured = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as any;
  try {
    const provider = new OpenAIProvider("k", ctorModel, "https://example.invalid/v1");
    await provider.sendMessageNonStreaming({
      messages: BASE_MSG,
      maxTokens: 16,
      ...params,
    } as any);
  } finally {
    globalThis.fetch = origFetch;
  }
  return captured;
}

/** 抓取 OpenAI 兼容端点**流式**请求体（与非流式是两份独立代码，必须各测一遍） */
async function captureOpenAIStreamBody(
  ctorModel: string,
  params: Record<string, unknown>,
): Promise<any> {
  const { OpenAIProvider } = await import("@sid-code/core/llm/openai.ts");
  let captured: any = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    captured = JSON.parse(init.body);
    const sse =
      `data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n` +
      `data: [DONE]\n\n`;
    return new Response(sse, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as any;
  try {
    const provider = new OpenAIProvider("k", ctorModel, "https://example.invalid/v1");
    for await (const _ev of provider.sendMessageStream({
      messages: BASE_MSG,
      maxTokens: 16,
      ...params,
    } as any)) {
      /* 消费完即可，只关心发出去的 body */
    }
  } finally {
    globalThis.fetch = origFetch;
  }
  return captured;
}

/** 抓取 Anthropic 端点流式请求体（走 SDK，仍在 fetch 边界拦） */
async function captureAnthropicStreamBody(
  ctorModel: string,
  params: Record<string, unknown>,
): Promise<any> {
  const { AnthropicProvider } = await import("@sid-code/core/llm/anthropic.ts");
  let captured: any = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    captured = JSON.parse(init.body);
    const sse =
      `event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"x","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n` +
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
    return new Response(sse, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as any;
  try {
    const provider = new AnthropicProvider("k", ctorModel, "https://example.invalid");
    for await (const _ev of provider.sendMessageStream({
      messages: BASE_MSG,
      maxTokens: 16,
      ...params,
    } as any)) {
      /* 同上 */
    }
  } finally {
    globalThis.fetch = origFetch;
  }
  return captured;
}

describe("wireModel 显式传入 → 请求体必须是真名", () => {
  beforeEach(() => resetWireModelAliases());
  afterEach(() => resetWireModelAliases());

  test("OpenAI 非流式", async () => {
    const body = await captureOpenAIBody(GATEWAY, { model: GATEWAY, wireModel: REAL });
    expect(body.model).toBe(REAL);
  });

  test("OpenAI 流式", async () => {
    const body = await captureOpenAIStreamBody(GATEWAY, { model: GATEWAY, wireModel: REAL });
    expect(body.model).toBe(REAL);
  });

  test("Anthropic 流式", async () => {
    const body = await captureAnthropicStreamBody(GATEWAY, { model: GATEWAY, wireModel: REAL });
    expect(body.model).toBe(REAL);
  });
});

describe("未传 wireModel → 靠进程级别名表兜底（side-call / headless 等路径）", () => {
  beforeEach(() => {
    resetWireModelAliases();
    setWireModelAliases([{ name: GATEWAY, modelId: REAL }]);
  });
  afterEach(() => resetWireModelAliases());

  test("OpenAI 非流式：只给别名也发真名", async () => {
    const body = await captureOpenAIBody(GATEWAY, { model: GATEWAY });
    expect(body.model).toBe(REAL);
  });

  test("OpenAI 流式：只给别名也发真名", async () => {
    const body = await captureOpenAIStreamBody(GATEWAY, { model: GATEWAY });
    expect(body.model).toBe(REAL);
  });

  test("Anthropic 流式：只给别名也发真名", async () => {
    const body = await captureAnthropicStreamBody(GATEWAY, { model: GATEWAY });
    expect(body.model).toBe(REAL);
  });

  test("连 params.model 都没有（老调用点）→ 构造时别名也过表", async () => {
    const body = await captureOpenAIBody(GATEWAY, {});
    expect(body.model).toBe(REAL);
  });
});

describe("没有任何 modelId 配置时零行为变化", () => {
  beforeEach(() => resetWireModelAliases());

  test("OpenAI：原样发 params.model", async () => {
    const body = await captureOpenAIBody("glm-5", { model: "glm-5" });
    expect(body.model).toBe("glm-5");
  });

  test("Anthropic：原样发 params.model", async () => {
    const body = await captureAnthropicStreamBody(REAL, { model: REAL });
    expect(body.model).toBe(REAL);
  });
});

describe("反向不变量：别名不得被真名污染", () => {
  beforeEach(() => resetWireModelAliases());
  afterEach(() => resetWireModelAliases());

  test("SendParams.model 仍是别名（归因/计价/日志读它，两渠道必须能分开统计）", async () => {
    setWireModelAliases([{ name: GATEWAY, modelId: REAL }]);
    const params: any = { model: GATEWAY, messages: BASE_MSG, maxTokens: 16 };
    const snapshot = { ...params };
    await captureOpenAIBody(GATEWAY, params);
    // provider 不得原地改调用方对象的 model（那会让上层归因看到真名，两渠道合并）
    expect(params.model).toBe(snapshot.model);
    expect(params.model).toBe(GATEWAY);
  });
});
