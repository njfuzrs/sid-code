/**
 * stream-handler.ts 测试
 * 传输错误判定 / 非流式降级 / 事件重放转换 / max_tokens 收紧
 */

import { describe, test, expect } from "bun:test";
import {
  isStreamingTransportError,
  convertToStreamEvents,
  streamWithFallback,
} from "@sid-code/core/api/stream-handler.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent, AccumulatedResponse } from "@sid-code/core/llm/types.ts";

const baseParams: SendParams = {
  model: "m",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 64000,
};

describe("isStreamingTransportError", () => {
  test("ECONNRESET / EPIPE 是传输错误", () => {
    expect(isStreamingTransportError(Object.assign(new Error(), { code: "ECONNRESET" }))).toBe(true);
    expect(isStreamingTransportError(Object.assign(new Error(), { code: "EPIPE" }))).toBe(true);
  });
  test("SSE / event stream 相关消息", () => {
    expect(isStreamingTransportError(new Error("text/event-stream not supported"))).toBe(true);
    expect(isStreamingTransportError(new Error("premature close of stream"))).toBe(true);
    expect(isStreamingTransportError(new Error("incomplete chunked encoding"))).toBe(true);
  });
  test("API 逻辑错误不是传输错误", () => {
    expect(isStreamingTransportError(new Error("429 rate limited"))).toBe(false);
    expect(isStreamingTransportError(new Error("prompt is too long"))).toBe(false);
  });
});

describe("convertToStreamEvents", () => {
  test("文本响应重放为完整事件序列", () => {
    const resp: AccumulatedResponse = {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const events = [...convertToStreamEvents(resp)];
    expect(events[0].type).toBe("message_start");
    expect(events.some(e => e.type === "content_block_start")).toBe(true);
    expect(events.some(e => e.type === "content_block_delta" && (e as any).delta.type === "text_delta")).toBe(true);
    expect(events.some(e => e.type === "content_block_stop")).toBe(true);
    expect(events.some(e => e.type === "message_delta" && (e as any).delta.stop_reason === "end_turn")).toBe(true);
    expect(events[events.length - 1].type).toBe("message_stop");
  });

  test("tool_use 响应重放为 input_json_delta", () => {
    const resp: AccumulatedResponse = {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "/a" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    const events = [...convertToStreamEvents(resp)];
    const delta = events.find(e => e.type === "content_block_delta");
    expect((delta as any).delta.type).toBe("input_json_delta");
    expect((delta as any).delta.partial_json).toBe('{"path":"/a"}');
  });
});

/** 构造一个 mock provider */
function makeProvider(opts: {
  stream: () => AsyncIterable<StreamEvent>;
  nonStreaming?: (params: SendParams) => Promise<AccumulatedResponse>;
}): Provider {
  return {
    name: () => "mock",
    sendMessageStream: () => opts.stream(),
    ...(opts.nonStreaming ? { sendMessageNonStreaming: (p: SendParams) => opts.nonStreaming!(p) } : {}),
  };
}

describe("streamWithFallback", () => {
  test("流式正常完成不降级", async () => {
    const provider = makeProvider({
      stream: async function* () {
        yield { type: "message_start", message: { usage: { inputTokens: 1, outputTokens: 0 } } };
        yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } };
        yield { type: "message_stop" };
      },
    });
    const out: StreamEvent[] = [];
    for await (const e of streamWithFallback(provider, baseParams)) out.push(e);
    expect(out.some(e => e.type === "content_block_delta")).toBe(true);
  });

  test("传输错误（throw）+ 未输出内容 → 降级到非流式", async () => {
    let nonStreamMaxTokens = -1;
    const provider = makeProvider({
      stream: async function* (): AsyncGenerator<StreamEvent> {
        throw Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
      },
      nonStreaming: async (p) => {
        nonStreamMaxTokens = p.maxTokens;
        return {
          role: "assistant",
          content: [{ type: "text", text: "fallback" }],
          stopReason: "end_turn",
          usage: { inputTokens: 2, outputTokens: 2 },
        };
      },
    });
    const out: StreamEvent[] = [];
    for await (const e of streamWithFallback(provider, baseParams)) out.push(e);
    const textDelta = out.find(e => e.type === "content_block_delta");
    expect((textDelta as any).delta.text).toBe("fallback");
    // max_tokens 被收紧到 16384
    expect(nonStreamMaxTokens).toBe(16384);
  });

  test("传输错误（error 事件）→ 降级", async () => {
    const provider = makeProvider({
      stream: async function* () {
        yield { type: "error", error: { message: "premature close of stream" } };
      },
      nonStreaming: async () => ({
        role: "assistant",
        content: [{ type: "text", text: "recovered" }],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    });
    const out: StreamEvent[] = [];
    for await (const e of streamWithFallback(provider, baseParams)) out.push(e);
    const textDelta = out.find(e => e.type === "content_block_delta");
    expect((textDelta as any).delta.text).toBe("recovered");
  });

  test("API 逻辑错误（非传输）原样抛出，不降级", async () => {
    const provider = makeProvider({
      stream: async function* (): AsyncGenerator<StreamEvent> {
        throw new Error("429 rate limited");
      },
      nonStreaming: async () => { throw new Error("should not be called"); },
    });
    let caught: unknown;
    try {
      for await (const _ of streamWithFallback(provider, baseParams)) { /* drain */ }
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toContain("429");
  });

  test("已输出内容后出错不降级（避免重复内容）", async () => {
    const provider = makeProvider({
      stream: async function* () {
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } };
        throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
      },
      nonStreaming: async () => { throw new Error("should not fallback"); },
    });
    let caught: unknown;
    const out: StreamEvent[] = [];
    try {
      for await (const e of streamWithFallback(provider, baseParams)) out.push(e);
    } catch (e) {
      caught = e;
    }
    expect(out.length).toBe(1);
    expect(caught).toBeDefined();
  });

  test("无 sendMessageNonStreaming 时传输错误原样抛出", async () => {
    const provider = makeProvider({
      stream: async function* (): AsyncGenerator<StreamEvent> {
        throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
      },
    });
    let caught: unknown;
    try {
      for await (const _ of streamWithFallback(provider, baseParams)) { /* drain */ }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
  });
});
